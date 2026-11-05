#!/usr/bin/env node
// team-tests CLI. `dry-run` (the default) uses synthetic samples only: no model, no `claude`, no
// network. It never imports a launcher. Real runs arrive in later tasks (B6, B7).
import { runDryRun, formatSummary, scrub } from '../src/dryrun.mjs';

const [cmd = 'dry-run'] = process.argv.slice(2);

if (cmd === 'dry-run') {
  try {
    const r = runDryRun();
    process.stdout.write(formatSummary(r));
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(scrub(`team-tests: dry run failed (${err?.name ?? 'Error'}: ${err?.message ?? ''})\n`));
    process.exit(2);
  }
} else {
  process.stderr.write(`team-tests: command "${String(cmd).replace(/[^\w-]/g, '?')}" is not implemented yet\n`);
  process.exit(2);
}
