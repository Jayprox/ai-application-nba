// tests-before-after: runs agent-written code, so these tests check the safety properties too
// (child env only, scratch worktree, timeout, argument arrays, fail closed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handlers } from '../src/checkers/tests-before-after.mjs';
import { evaluate } from '../src/checkers/index.mjs';
import { makeRun, put, tg, commitAll, branch, GOOD, byId } from './helpers.mjs';

const H = handlers['G1.test-before-after'];
const worktrees = (f) => tg(f, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const FIXED = "export const formatPrice = (c) => `$${(c / 100).toFixed(2)}`;\n";

function withG1(opts, fn) {
  const { run, f, cleanup } = makeRun('G1', opts);
  try { return fn(run, f); } finally { cleanup(); }
}

test('passes when the new test fails on the original commit and passes on the fix; worktrees are removed', () => {
  withG1({}, (run, f) => {
    const r = H(run);
    assert.equal(r.pass, true);
    assert.deepEqual(r.evidence, ['new test file count 1', 'on the original commit: fail', 'on the fix: pass']);
    assert.equal(worktrees(f), 1, 'only the main work tree remains');
    assert.deepEqual(fs.readdirSync(f.scratch).filter((n) => n.startsWith('tba-')), []);
    assert.equal(byId(evaluate(run), 'G1.test-before-after').status, 'passed');
  });
});

test('positive controls: a test that passes on the original commit, or fails on the fix, fails the criterion', () => {
  // Passes before and after: not a regression test for the bug.
  withG1({ apply: (f) => { GOOD.G1(f); put(f, 'test/price-zero.test.js', "import test from 'node:test';\ntest('trivial', () => {});\n"); commitAll(f); } }, (run) => {
    const r = H(run);
    assert.equal(r.pass, false);
    assert.ok(r.evidence.includes('on the original commit: pass'));
  });
  // Fails on the fix too.
  withG1({ apply: (f) => { GOOD.G1(f); put(f, 'src/price.js', 'export const formatPrice = () => "";\n'); commitAll(f); } }, (run) => {
    const r = H(run);
    assert.equal(r.pass, false);
    assert.ok(r.evidence.includes('on the fix: fail'));
  });
  // No fix branch, or no new test file.
  withG1({ apply: () => {} }, (run) => assert.equal(H(run).pass, false));
  withG1({ apply: (f) => { branch(f, 'fix/nothing'); put(f, 'src/price.js', `// x\n${FIXED}`); commitAll(f); } }, (run) => {
    const r = H(run);
    assert.equal(r.pass, false);
    assert.deepEqual(r.evidence, ['no new or changed test file on the fix branch']);
  });
});

test('runs with the B2 child env only: a parent-env variable is not visible to the test', () => {
  process.env.TT_PARENT_ONLY = 'leak';
  try {
    const apply = (f) => {
      branch(f, 'fix/env');
      put(f, 'src/price.js', FIXED);
      put(f, 'test/env.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/price.js';
test('env', () => {
  assert.equal(formatPrice(0), '$0.00');
  assert.equal(process.env.TT_PARENT_ONLY, undefined);
  assert.equal(process.env.HOME.includes('team-tests-'), true);
  assert.equal(typeof process.env.FIXTURE_DB_TOKEN, 'string');
});
`);
      commitAll(f);
    };
    withG1({ apply }, (run) => assert.equal(H(run).pass, true));
  } finally {
    delete process.env.TT_PARENT_ONLY;
  }
});

test('runs inside the scratch dir: the test cwd is a worktree under the scratch root', () => {
  const apply = (f) => {
    branch(f, 'fix/cwd');
    put(f, 'src/price.js', FIXED);
    put(f, 'test/cwd.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatPrice } from '../src/price.js';
test('cwd', () => {
  assert.equal(formatPrice(0), '$0.00');
  const cwd = fs.realpathSync(process.cwd());
  assert.equal(path.basename(cwd), 'tba-after');
  assert.equal(path.dirname(cwd), path.dirname(fs.realpathSync(process.env.TMPDIR)));
});
`);
    commitAll(f);
  };
  withG1({ apply }, (run) => assert.equal(H(run).pass, true));
});

test('a hanging test is killed at the timeout and reported as error, never passed', () => {
  const apply = (f) => {
    branch(f, 'fix/hang');
    put(f, 'src/price.js', FIXED);
    put(f, 'test/hang.test.js', "import test from 'node:test';\ntest('hang', () => { for (;;); });\n");
    commitAll(f);
  };
  withG1({ apply, mutate: (run) => { run.testTimeoutMs = 700; } }, (run, f) => {
    const t = Date.now();
    assert.throws(() => H(run), /timeout/);
    assert.ok(Date.now() - t < 20000);
    const ev = evaluate(run);
    assert.equal(byId(ev, 'G1.test-before-after').status, 'error');
    assert.equal(ev.verdict, 'error');
    assert.equal(worktrees(f), 1, 'worktrees removed after a timeout');
  });
});

test('fails closed on missing input: env, scratch, base SHA', () => {
  withG1({}, (run) => {
    const cases = {
      'no env': (r) => { r.env = undefined; },
      'env without PATH': (r) => { r.env = { HOME: '/x' }; },
      'no scratch': (r) => { r.scratch = undefined; },
      'scratch missing': (r) => { r.scratch = path.join(run.scratch, 'nope'); },
      'no baseSha': (r) => { r.baseSha = undefined; },
    };
    for (const [name, fn] of Object.entries(cases)) {
      const r = { ...run };
      fn(r);
      const ev = evaluate(r);
      assert.equal(byId(ev, 'G1.test-before-after').status, 'error', name);
      assert.notEqual(ev.verdict, 'passed', name);
    }
  });
});

test('source: spawn with argument arrays only, no shell, no parent env, no claude', () => {
  const src = fs.readFileSync(new URL('../src/checkers/tests-before-after.mjs', import.meta.url), 'utf8');
  assert.match(src, /spawnSync\(process\.execPath, \['--test', \.\.\.files\]/);
  assert.match(src, /shell: false/);
  assert.doesNotMatch(src, /\bexec\(|execSync|shell: true|process\.env/);
  assert.doesNotMatch(src, /claude/i);
});
