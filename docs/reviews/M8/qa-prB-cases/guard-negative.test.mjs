// QA-owned negative cases for M8 PR B (Story 2 AC7). Run from the repo root:
//   node --test docs/reviews/M8/qa-prB-cases/guard-negative.test.mjs
// Stub spawners and stub launcher importers only. No `claude` process is ever started. Approval files
// and results dirs are created in a throwaway directory that is removed at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = path.join(REPO, 'tools/team-tests/src');
const { checkRun } = await import(path.join(SRC, 'guard.mjs'));
const { GuardRefusal } = await import(path.join(SRC, 'refusal.mjs'));
const { estimateSha256 } = await import(path.join(SRC, 'estimate.mjs'));
const { reserveSession, readLedger } = await import(path.join(SRC, 'ledger.mjs'));
const { runCommand } = await import(path.join(SRC, 'runcmd.mjs'));
const { launchAll } = await import(path.join(SRC, 'launch.mjs'));

const SHA = 'b'.repeat(40);
const NOW = new Date('2026-11-04T12:00:00Z');
const RUN = [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 3 }];
const bases = [];
test.after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prB-')));
  bases.push(base);
  const a = path.join(base, 'approvals'); const r = path.join(base, 'results');
  fs.mkdirSync(a, { mode: 0o700 }); fs.mkdirSync(r, { mode: 0o700 });
  return { base, resultsDir: r, file: path.join(a, 'approval.json') };
}
function put(w, over = {}, mode = 0o600) {
  const a = { approvalId: 'qa-1', approvedBy: 'owner', approvedOn: '2026-11-04T10:00:00Z', expires: '2026-11-05T10:00:00Z',
    runSet: RUN, maxSessions: 6, maxUsdPerSession: 5, maxUsdTotal: 20, coordinatorModel: 'sonnet', configRef: 'main', resultsDir: w.resultsDir, ...over };
  if (!('estimateSha256' in over)) a.estimateSha256 = estimateSha256(a);
  fs.writeFileSync(w.file, JSON.stringify(a), { mode }); fs.chmodSync(w.file, mode);
  return a;
}
const base = (w, o = {}) => ({ approvalPath: w.file, runSet: RUN, env: {}, now: NOW, repoRoot: REPO, roots: [], resolveRef: () => SHA, ...o });
const code = (c, fn) => assert.throws(fn, (e) => e instanceof GuardRefusal && e.code === c, `expected ${c}`);

test('baseline: valid approval passes (control, so refusals below are meaningful)', () => {
  const w = world(); put(w);
  assert.equal(checkRun(base(w)).todo.length, 6);
});

test('1 missing approval: undefined, empty, absent file, directory, dangling path', () => {
  const w = world(); put(w);
  code('approval-missing', () => checkRun(base(w, { approvalPath: undefined })));
  code('approval-missing', () => checkRun(base(w, { approvalPath: '' })));
  code('approval-missing', () => checkRun(base(w, { approvalPath: path.join(w.base, 'approvals', 'nope.json') })));
  code('approval-type', () => checkRun(base(w, { approvalPath: path.dirname(w.file) })));
  code('approval-path', () => checkRun(base(w, { approvalPath: 'relative.json' })));
});

test('1b missing approval via runCommand: launcher never imported', async () => {
  let imported = 0;
  await assert.rejects(runCommand(['--run', 'G3:3,G1:3'], { env: {}, repoRoot: REPO, importLauncher: () => { imported++; throw new Error('imported'); } }), (e) => e.code === 'approval-missing');
  assert.equal(imported, 0);
});

test('2 mismatched run set: fewer, more, reordered, other mission, extra repeat', () => {
  const w = world(); put(w);
  for (const rs of [[{ mission: 'G3', repeats: 3 }], [{ mission: 'G1', repeats: 3 }, { mission: 'G3', repeats: 3 }],
    [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 4 }], [{ mission: 'G3', repeats: 3 }, { mission: 'G2', repeats: 3 }],
    [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 3 }, { mission: 'G4', repeats: 1 }], []]) {
    assert.throws(() => checkRun(base(w, { runSet: rs })), (e) => e instanceof GuardRefusal && /^run-set/.test(e.code));
  }
});

test('2b mismatched run set via runCommand: launcher never imported', async () => {
  const w = world(); put(w);
  let imported = 0;
  await assert.rejects(runCommand(['--approval', w.file, '--run', 'G3:3,G1:2'], { env: {}, now: NOW, repoRoot: REPO, guardOpts: { roots: [], resolveRef: () => SHA }, importLauncher: () => { imported++; return {}; } }), (e) => e.code === 'run-set-mismatch');
  assert.equal(imported, 0);
});

test('3 CI set: any value, even empty or 0, refuses first (before the approval file is read)', async () => {
  const w = world(); put(w);
  for (const v of ['1', 'true', '', '0', 'false']) code('ci', () => checkRun(base(w, { env: { CI: v } })));
  code('ci', () => checkRun(base(w, { env: { CI: '1' }, approvalPath: undefined })));
  let imported = 0;
  await assert.rejects(runCommand(['--approval', w.file, '--run', 'G3:3,G1:3'], { env: { CI: '1' }, now: NOW, repoRoot: REPO, guardOpts: { roots: [], resolveRef: () => SHA }, importLauncher: () => { imported++; return {}; } }), (e) => e.code === 'ci');
  assert.equal(imported, 0);
});

test('3b CLI: CI=1 and no approval exit 3 with a refusal message; no claude on a scrubbed PATH', () => {
  const cli = path.join(REPO, 'tools/team-tests/bin/team-tests.mjs');
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prB-path-'))); bases.push(empty);
  for (const [env, args] of [[{ CI: '1' }, ['run', '--run', 'G3:3,G1:3']], [{}, ['run', '--run', 'G3:3,G1:3']], [{}, ['run', '--approval', '/nonexistent/x.json', '--run', 'G3:3']]]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: empty, ...env }, cwd: os.tmpdir() });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /team-tests: /);
    assert.doesNotMatch(r.stderr + r.stdout, /\/Users\//);
  }
});

test('4 seventh session: refused by approval, by run set, and by the ledger', async () => {
  const w = world();
  // (a) approval itself over the hard cap
  put(w, { runSet: [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 4 }], maxSessions: 7 });
  code('max-sessions-cap', () => checkRun(base(w, { runSet: [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 4 }] })));
  // (b) run set of 7 under maxSessions 6
  put(w, { runSet: [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 4 }], maxSessions: 6 });
  code('max-sessions-cap', () => checkRun(base(w, { runSet: [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 4 }] })));
  // (c) ledger: six slots reserved, a seventh is refused and nothing is spawned
  const a = put(w, { maxUsdTotal: 100 });
  for (const s of ['G3/1', 'G3/2', 'G3/3', 'G1/1', 'G1/2', 'G1/3']) reserveSession(w.resultsDir, a, s);
  assert.equal(readLedger(w.resultsDir, 'qa-1').sessions.length, 6);
  assert.throws(() => reserveSession(w.resultsDir, a, 'G4/1'), (e) => e.code === 'max-sessions');
  // (c2) launchAll with a plan whose todo holds a 7th slot: stops before any spawn
  let spawned = 0;
  const plan = { approval: a, resultsDir: w.resultsDir, createResultsDir: false, configSha: SHA, todo: [{ mission: 'G4', repeat: 1, slot: 'G4/1' }] };
  const r = await launchAll({ plan, repoRoot: REPO, env: {}, claudePath: '/nonexistent/claude', spawner: () => { spawned++; throw new Error('spawned'); }, keychainPath: '/nonexistent/kc' });
  assert.equal(spawned, 0); assert.equal(r.outcomes.length, 0); assert.equal(r.stopped, 'max-sessions');
  // (d) a fully consumed run set re-requested: nothing left to run, never a new slot
  assert.equal(checkRun(base(w)).todo.length, 0);
});

test('4b duplicate entries in runSet cannot smuggle a 7th session past the cap', () => {
  const w = world();
  put(w, { runSet: [{ mission: 'G3', repeats: 3 }, { mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 1 }], maxSessions: 6 });
  assert.throws(() => checkRun(base(w, { runSet: [{ mission: 'G3', repeats: 3 }, { mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 1 }] })), (e) => e instanceof GuardRefusal);
});

test('5 other bypass attempts: tampered estimate, wrong caps, symlink, perms, expiry, owner field, repo location, real scratch roots', () => {
  const w = world();
  put(w, { estimateSha256: 'c'.repeat(64) }); code('estimate-mismatch', () => checkRun(base(w)));
  const a = put(w); fs.writeFileSync(w.file, JSON.stringify({ ...a, maxUsdTotal: 99 })); code('estimate-mismatch', () => checkRun(base(w)));
  put(w, {}, 0o664); code('approval-writable', () => checkRun(base(w)));
  put(w); const link = path.join(w.base, 'link.json'); fs.symlinkSync(w.file, link); code('approval-symlink', () => checkRun(base(w, { approvalPath: link })));
  put(w, { expires: '2026-11-04T11:00:00Z' }); code('approval-expired', () => checkRun(base(w)));
  put(w, { approvedBy: 'agent' }); code('approval-shape', () => checkRun(base(w)));
  put(w, { extra: 1 }); code('approval-shape', () => checkRun(base(w)));
  put(w); code('approval-scratch', () => checkRun(base(w, { roots: undefined })));   // real scratch roots: tmp is refused
  put(w, { resultsDir: path.join(REPO, 'qa-results') }); assert.throws(() => checkRun(base(w)), (e) => /^results(-parent)?-worktree$/.test(e.code));
  put(w, { resultsDir: 'results' }); code('results-path', () => checkRun(base(w)));
  put(w, { configRef: 'main' }); code('config-ref', () => checkRun(base(w, { resolveRef: () => null })));
});

// ---- probes recorded as findings (assert current behaviour, so a change is visible) ----
test('probe: approval file in a world-writable parent dir is accepted (parent mode is not checked)', () => {
  const w = world(); put(w); fs.chmodSync(path.dirname(w.file), 0o777);
  let accepted = true;
  try { checkRun(base(w)); } catch { accepted = false; }
  console.log(`# QA probe world-writable approval parent accepted: ${accepted}`);
});
test('probe: far-future expiry is accepted (no maximum validity)', () => {
  const w = world(); put(w, { expires: '9999-01-01T00:00:00Z' });
  let accepted = true;
  try { checkRun(base(w)); } catch { accepted = false; }
  console.log(`# QA probe expiry year 9999 accepted: ${accepted}`);
});
test('probe: deleting ledger.json resets the cap (procedural guard, documented in plan 3.9)', () => {
  const w = world(); const a = put(w, { maxUsdTotal: 100 });
  for (const s of ['G3/1', 'G3/2', 'G3/3', 'G1/1', 'G1/2', 'G1/3']) reserveSession(w.resultsDir, a, s);
  fs.rmSync(path.join(w.resultsDir, 'ledger.json'));
  console.log(`# QA probe todo after ledger deleted: ${checkRun(base(w)).todo.length}`);
});
