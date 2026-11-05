#!/usr/bin/env node
// team-tests CLI. `dry-run` (the default) uses synthetic samples only: no model, no `claude`, no
// network. It never imports a launcher. `estimate` and `run` (B7) load the guard and, only after it passes, the launcher.
import { fileURLToPath } from 'node:url';
import { runDryRun, formatSummary, scrub } from '../src/dryrun.mjs';
import { scorePaths, writeReport, compare, sanitize } from '../src/report.mjs';

const [cmd = 'dry-run', ...args] = process.argv.slice(2);

function fail(err) {
  const known = err?.name === 'ResultError';
  process.stderr.write(sanitize(`team-tests: ${known ? err.message : `failed (${err?.name ?? 'Error'})`}\n`));
  process.exit(2);
}

function refused(err) {
  const known = err?.name === 'GuardRefusal';
  process.stderr.write(sanitize(`team-tests: ${known ? err.message : `failed (${err?.name ?? 'Error'})`}\n`));
  process.exit(known ? 3 : 2);
}

if (cmd === 'dry-run') {
  try {
    const r = runDryRun();
    process.stdout.write(formatSummary(r));
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(scrub(`team-tests: dry run failed (${err?.name ?? 'Error'}: ${err?.message ?? ''})\n`));
    process.exit(2);
  }
} else if (cmd === 'score') {
  try {
    const rows = scorePaths(args);
    for (const s of rows) process.stdout.write(sanitize(`${s.mission} repeat ${s.repeat}: mechanical ${s.mechanical.passed}/${s.mechanical.total}, safety ${s.safety.passed}/${s.safety.total}, quality ${s.quality.passed}/${s.quality.total}, stop ${s.stopReason}\n`));
    process.exit(0);
  } catch (err) { fail(err); }
} else if (cmd === 'report') {
  try {
    if (args.length !== 1) throw Object.assign(new Error('usage: report <result-dir>'), { name: 'ResultError' });
    const r = writeReport(args[0]);
    process.stdout.write(`wrote ${r.files.join(', ')}\n`);
    process.exit(0);
  } catch (err) { fail(err); }
} else if (cmd === 'compare') {
  try {
    if (args.length !== 2) throw Object.assign(new Error('usage: compare <baseline> <candidate>'), { name: 'ResultError' });
    const r = compare([args[0]], [args[1]]);
    process.stdout.write(r.text);
    process.exit(r.compare.ok ? 0 : 1);
  } catch (err) { fail(err); }
} else if (cmd === 'estimate') {
  try {
    const { estimateCommand } = await import('../src/runcmd.mjs');
    process.stdout.write(estimateCommand(args));
    process.exit(0);
  } catch (err) { refused(err); }
} else if (cmd === 'run') {
  try {
    const { runCommand } = await import('../src/runcmd.mjs');
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const log = (o) => process.stdout.write(`${o.mission} repeat ${o.repeat}: stop ${o.stopReason}, cost US$${o.costUsd.toFixed(2)}${o.isolationFailed ? ', ISOLATION FAILED' : ''}${o.safetyFailed ? ', safety criterion not passed' : ''}${o.usageOk ? '' : ', usage unreadable'}\n`);
    const r = await runCommand(args, { repoRoot, log });
    process.stdout.write(`run finished: ${r.outcomes.length} session(s)${r.stopped ? `, stopped early (${r.stopped})` : ''}\n`);
    process.exit(r.stopped ? 1 : 0);
  } catch (err) { refused(err); }
} else {
  process.stderr.write(`team-tests: command "${String(cmd).replace(/[^\w-]/g, '?')}" is not implemented yet\n`);
  process.exit(2);
}
