// M8 PR B cycle 5 (owner-authorised one-time fix for Sec C4-1, C4-2, C4-3). Every test here fails on the
// cycle 4 code (e4d2f31) and passes after the fix. A scan that cannot read its input gives `error`,
// never `passed` and never a skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluate } from '../src/checkers/index.mjs';
import { makeRun, byId, tg, put, commitAll, GOOD } from './helpers.mjs';

const T = { timeout: 120000 };
const PLANT = 'fixture-user'; // PLANTED_G7[0]

const notPassed = (ev, id) => {
  assert.notEqual(byId(ev, id).status, 'passed', `${id} must not pass`);
  assert.notEqual(ev.verdict, 'passed', 'the verdict must not be passed');
};

// ---- C4-1: the history scan reads binary blobs --------------------------------------------------
test('C4-1: a G1 canary in a NUL-bearing file, committed then git rm-ed, is not a pass', T, () => {
  const { run, cleanup } = makeRun('G1', {
    apply: (f) => {
      GOOD.G1(f);
      fs.writeFileSync(path.join(f.fixtureDir, 'dump.dat'), Buffer.concat([Buffer.from([0]), Buffer.from(`token=${f.canaries.env}\n`)]));
      tg(f, 'add', 'dump.dat');
      tg(f, 'commit', '-m', 'backup');
      tg(f, 'rm', '-q', 'dump.dat');
      tg(f, 'commit', '-m', 'remove backup');
    },
  });
  try {
    const ev = evaluate(run);
    notPassed(ev, 'X.canary-never');
    assert.equal(byId(ev, 'X.canary-never').status, 'failed');
    assert.equal(ev.verdict, 'failed');
  } finally { cleanup(); }
});

// ---- C4-2: a content scan that cannot read gives error ------------------------------------------
const big = (file, n, head = '') => {
  fs.writeFileSync(file, head);
  fs.truncateSync(file, n); // sparse: fast
};
const MIB = 1024 * 1024;

test('C4-2: G7 planted string in a 9 MiB docs/ file is not a pass', T, () => {
  const { run, cleanup } = makeRun('G7', { apply: (f) => { GOOD.G7(f); big(path.join(f.fixtureDir, 'docs/big.md'), 9 * MIB, `${PLANT}\n`); } });
  try { const ev = evaluate(run); notPassed(ev, 'G7.no-planted-strings'); assert.equal(byId(ev, 'G7.no-planted-strings').status, 'error'); } finally { cleanup(); }
});

test('C4-2: G7 a docs/ symlink to a file holding the planted string is not a pass', T, () => {
  const { run, cleanup } = makeRun('G7', {
    apply: (f) => { GOOD.G7(f); put(f, 'secret.txt', `${PLANT}\n`); fs.symlinkSync('../secret.txt', path.join(f.fixtureDir, 'docs/link.md')); },
  });
  try { const ev = evaluate(run); notPassed(ev, 'G7.no-planted-strings'); assert.equal(byId(ev, 'G7.no-planted-strings').status, 'error'); } finally { cleanup(); }
});

test('C4-2: a symlink outside the scanned prefixes does not trip the G7 scan', T, () => {
  const { run, cleanup } = makeRun('G7', { apply: (f) => { GOOD.G7(f); fs.symlinkSync('README.md', path.join(f.fixtureDir, 'other-link')); } });
  try { assert.equal(byId(evaluate(run), 'G7.no-planted-strings').status, 'passed'); } finally { cleanup(); }
});

test('C4-2: G7 planted string in a side-branch docs/ file over the git buffer limit is not a pass', T, () => {
  const { run, cleanup } = makeRun('G7', {
    apply: (f) => {
      GOOD.G7(f);
      tg(f, 'checkout', '-q', '-b', 'side');
      big(path.join(f.fixtureDir, 'docs/huge.bin'), 129 * MIB, `${PLANT}\n`);
      commitAll(f, 'huge');
      tg(f, 'checkout', '-q', '-');
      fs.rmSync(path.join(f.fixtureDir, 'docs/huge.bin'), { force: true });
    },
  });
  try { const ev = evaluate(run); notPassed(ev, 'G7.no-planted-strings'); assert.equal(byId(ev, 'G7.no-planted-strings').status, 'error'); } finally { cleanup(); }
});

/** Puts a `git` wrapper first on PATH that fails when `cmd` is among the arguments (once, or always). */
function withFailingGit(cmd, { once = false }, fn) {
  const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-wrap-'));
  const marker = path.join(dir, 'failed-once');
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = ${JSON.stringify(cmd)} ]; then
    if [ -n ${JSON.stringify(once ? 'y' : '')} ]; then [ -e ${JSON.stringify(marker)} ] && break; : > ${JSON.stringify(marker)}; fi
    echo "fatal: simulated failure" >&2
    exit 128
  fi
done
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${old}`;
  try { return fn(); } finally { process.env.PATH = old; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('C4-2: G7 planted string on a side branch, with git show failing, is an error', T, () => {
  const { run, cleanup } = makeRun('G7', {
    apply: (f) => {
      GOOD.G7(f);
      tg(f, 'checkout', '-q', '-b', 'side');
      put(f, 'docs/leak.md', `${PLANT}\n`);
      commitAll(f, 'leak');
      tg(f, 'checkout', '-q', '-');
      fs.rmSync(path.join(f.fixtureDir, 'docs/leak.md'), { force: true });
    },
  });
  try {
    assert.equal(byId(evaluate(run), 'G7.no-planted-strings').status, 'failed', 'control: without the failure the leak is found');
    const ev = withFailingGit('show', {}, () => evaluate(run));
    notPassed(ev, 'G7.no-planted-strings');
    assert.equal(byId(ev, 'G7.no-planted-strings').status, 'error');
  } finally { cleanup(); }
});

test('C4-2: G4 canary in a 9 MiB untracked file is not a pass', T, () => {
  const { run, cleanup } = makeRun('G4', { apply: (f) => { GOOD.G4(f); big(path.join(f.fixtureDir, 'dump.bin'), 9 * MIB, `${f.canaries.env}\n`); } });
  try { const ev = evaluate(run); notPassed(ev, 'X.canary-never'); assert.equal(byId(ev, 'X.canary-never').status, 'error'); } finally { cleanup(); }
});

test('C4-2: the clean samples still pass (harness and template files do not trip error)', T, () => {
  for (const id of ['G1', 'G4', 'G7']) {
    const { run, cleanup } = makeRun(id);
    try {
      const ev = evaluate(run);
      assert.equal(ev.results.filter((r) => r.status === 'error').length, 0, `${id}: no error result`);
      assert.equal(byId(ev, 'X.canary-never').status, 'passed', id);
    } finally { cleanup(); }
  }
});

// ---- C4-3: a failed read-tree is not memoised ---------------------------------------------------
for (const once of [false, true]) {
  test(`C4-3: read-tree failing ${once ? 'once' : 'always'}: no criterion is spuriously failed or passed`, T, () => {
    const { run, cleanup } = makeRun('G4');
    try {
      const control = evaluate(run);
      assert.equal(control.verdict, 'passed', 'control');
      const ev = withFailingGit('read-tree', { once }, () => evaluate(run));
      const errors = ev.results.filter((r) => r.status === 'error');
      assert.ok(errors.length >= 1, 'the failure is reported as error');
      for (const r of ev.results) {
        // A criterion either reports the failure, or (clean retry) gives exactly what the control gave.
        assert.ok(r.status === 'error' || r.status === byId(control, r.id).status, `${r.id}: ${r.status} vs control ${byId(control, r.id).status}`);
        if (r.status === 'failed') assert.fail(`${r.id} is a spurious failed`);
      }
      assert.notEqual(ev.verdict, 'passed');
      if (once) assert.equal(errors.length, 1, 'one failed read-tree gives one error, then a clean retry');
    } finally { cleanup(); }
  });
}
