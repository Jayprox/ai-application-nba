// `tests-before-after` checker (G1): the new test fails on the original commit and passes on the fix.
// It RUNS AGENT-WRITTEN CODE, so: the B2 child env only (never the parent env), an extracted tree
// (blob reads, no checkout) inside the scratch dir, a timeout, and spawn with an argument array (no shell).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isWithin } from '../paths.mjs';
import { need, git, branches, changedOn, isTestFile, baseShaOf, fixtureDirOf, extractTree } from './util.mjs';

export const DEFAULT_TIMEOUT_MS = 60000;

function runTests(cwd, files, env, timeoutMs) {
  // detached: the test process leads its own process group, so the whole group (the test files and anything
  // they spawned) can be killed after the run, on timeout or not (Sec F5).
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, shell: false, detached: true });
  if (r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ } }
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') return { status: 'timeout' };
  if (r.error || r.status === null) return { status: 'error' };
  return { status: r.status === 0 ? 'pass' : 'fail' };
}

// No git checkout: the tree is written from blob reads against the harness-owned repo copy, so no
// smudge filter or hook of the agent's can run (Sec F1).
function withTree(run, name, ref, fn) {
  const scratch = fs.realpathSync(run.scratch);
  const dir = path.join(scratch, name);
  need(isWithin(scratch, dir), 'worktree outside scratch');
  fs.mkdirSync(dir, { mode: 0o700 }); // fails if the name already exists
  try {
    extractTree(run, ref, dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const handlers = {
  'G1.test-before-after': (run) => {
    fixtureDirOf(run);
    need(typeof run.scratch === 'string' && path.isAbsolute(run.scratch) && fs.existsSync(run.scratch), 'scratch missing');
    need(run.env && typeof run.env === 'object' && typeof run.env.PATH === 'string' && typeof run.env.HOME === 'string', 'child env missing');
    const timeoutMs = Number.isInteger(run.testTimeoutMs) && run.testTimeoutMs > 0 ? run.testTimeoutMs : DEFAULT_TIMEOUT_MS;
    const base = baseShaOf(run);
    const fix = branches(run).find((b) => b.startsWith('fix/'));
    if (!fix) return { pass: false, evidence: ['no fix/* branch to test'] };
    const fixRef = `refs/heads/${fix}`;
    const newTests = git(run, ['diff', '--name-only', '--diff-filter=AM', '--no-renames', '--no-ext-diff', '--no-textconv', base, fixRef, '--'])
      .split('\n').filter((p) => p && isTestFile(p));
    if (newTests.length === 0) return { pass: false, evidence: ['no new or changed test file on the fix branch'] };
    for (const t of newTests) need(!t.startsWith('-') && !t.includes('..'), 'bad test path');

    const before = withTree(run, 'tba-before', base, (dir) => {
      for (const t of newTests) {
        const content = git(run, ['show', `${fixRef}:${t}`]);
        fs.mkdirSync(path.dirname(path.join(dir, t)), { recursive: true });
        fs.writeFileSync(path.join(dir, t), content);
      }
      return runTests(dir, newTests, run.env, timeoutMs);
    });
    const after = withTree(run, 'tba-after', fixRef, (dir) => runTests(dir, newTests, run.env, timeoutMs));
    if ([before.status, after.status].some((s) => s === 'timeout' || s === 'error')) {
      need(false, `test run ${before.status === 'pass' || before.status === 'fail' ? after.status : before.status}`); // fail closed: error, never passed
    }
    return {
      pass: before.status === 'fail' && after.status === 'pass',
      evidence: [`new test file count ${newTests.length}`, `on the original commit: ${before.status}`, `on the fix: ${after.status}`],
    };
  },
};
