// B7: refusal-to-run guard and ledger (Story 2 AC7). One refusal test per condition of plan 3.9.
// Approval files live in a throwaway directory; `roots: []` tells the guard that this directory is not
// scratch space (the CLI never sets it). The default roots are exercised in their own tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkRun, MAX_SESSIONS, APPROVAL_KEYS } from '../src/guard.mjs';
import { GuardRefusal } from '../src/refusal.mjs';
import { estimateSha256, estimateText, parseRunSet } from '../src/estimate.mjs';
import { reserveSession, finishSession, readLedger, spentUsd, checkLedger } from '../src/ledger.mjs';
import { runCommand, estimateCommand } from '../src/runcmd.mjs';
import { REPO } from './helpers.mjs';

const SHA = 'a'.repeat(40);
const RUN = [{ mission: 'G3', repeats: 3 }, { mission: 'G1', repeats: 3 }];
const NOW = new Date('2026-11-04T12:00:00Z');
const roots = [];
const bases = [];
test.after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-')));
  bases.push(base);
  const approvalDir = path.join(base, 'approvals');
  const resultsDir = path.join(base, 'results');
  fs.mkdirSync(approvalDir, { mode: 0o700 });
  fs.mkdirSync(resultsDir, { mode: 0o700 });
  return { base, approvalDir, resultsDir, file: path.join(approvalDir, 'approval.json') };
}

function approvalFor(w, over = {}) {
  const a = {
    approvalId: 'pilot-1', approvedBy: 'owner', approvedOn: '2026-11-04T10:00:00Z', expires: '2026-11-05T10:00:00Z',
    runSet: RUN, maxSessions: 6, maxUsdPerSession: 5, maxUsdTotal: 20, coordinatorModel: 'sonnet', configRef: 'main',
    estimateSha256: '', resultsDir: w.resultsDir, ...over,
  };
  if (!('estimateSha256' in over)) a.estimateSha256 = estimateSha256({ runSet: a.runSet, maxSessions: a.maxSessions, maxUsdPerSession: a.maxUsdPerSession, maxUsdTotal: a.maxUsdTotal });
  return a;
}

function put(w, over = {}, mode = 0o600) {
  fs.writeFileSync(w.file, JSON.stringify(approvalFor(w, over)), { mode });
  fs.chmodSync(w.file, mode);
}

const check = (w, o = {}) => checkRun({ approvalPath: w.file, runSet: RUN, env: {}, now: NOW, repoRoot: REPO, roots, resolveRef: () => SHA, ...o });
const refused = (code, fn) => assert.throws(fn, (e) => e instanceof GuardRefusal && e.code === code, `expected refusal ${code}`);

test('a complete, valid approval passes and reports the plan', () => {
  const w = world(); put(w);
  const r = check(w);
  assert.equal(r.approval.approvalId, 'pilot-1');
  assert.equal(r.todo.length, 6);
  assert.equal(r.createResultsDir, false);
  assert.equal(r.configSha, SHA);
  assert.equal(MAX_SESSIONS, 6);
});

// 1. approval file location and permissions ----------------------------------------------------
test('refuse: --approval not given, file missing', () => {
  const w = world();
  refused('approval-missing', () => check(w, { approvalPath: undefined }));
  refused('approval-missing', () => check(w, { approvalPath: '' }));
  refused('approval-missing', () => check(w));
});

test('refuse: relative, unnormalised or NUL-containing approval path', () => {
  const w = world(); put(w);
  refused('approval-path', () => check(w, { approvalPath: 'approval.json' }));
  refused('approval-path', () => check(w, { approvalPath: `${w.approvalDir}/../approvals/approval.json` }));
  refused('approval-path', () => check(w, { approvalPath: `${w.file}\0x` }));
});

test('refuse: approval file is a symlink, sits behind a symlinked directory, or is a hard link', () => {
  const w = world(); put(w);
  const link = path.join(w.approvalDir, 'link.json');
  fs.symlinkSync(w.file, link);
  refused('approval-symlink', () => check(w, { approvalPath: link }));
  const dirLink = path.join(w.base, 'dirlink');
  fs.symlinkSync(w.approvalDir, dirLink);
  refused('approval-symlink', () => check(w, { approvalPath: path.join(dirLink, 'approval.json') }));
  const hard = path.join(w.approvalDir, 'hard.json');
  fs.linkSync(w.file, hard);
  refused('approval-hardlink', () => check(w, { approvalPath: hard }));
});

test('refuse: approval path is a directory; file group- or world-writable; not owned by the current user', () => {
  const w = world(); put(w);
  refused('approval-type', () => check(w, { approvalPath: w.approvalDir }));
  fs.chmodSync(w.file, 0o620);
  refused('approval-writable', () => check(w));
  fs.chmodSync(w.file, 0o602);
  refused('approval-writable', () => check(w));
  fs.chmodSync(w.file, 0o600);
  refused('approval-owner', () => check(w, { uid: process.getuid() + 1 }));
});

test('refuse: approval file inside scratch space (default roots) and inside a git work tree', () => {
  const w = world(); put(w);
  refused('approval-scratch', () => checkRun({ approvalPath: w.file, runSet: RUN, env: {}, now: NOW, repoRoot: REPO, resolveRef: () => SHA }));
  const tree = path.join(w.base, 'tree');
  fs.mkdirSync(tree, { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', tree]).status, 0);
  const inTree = { ...w, file: path.join(tree, 'approval.json') };
  put(inTree);
  refused('approval-worktree', () => check(w, { approvalPath: inTree.file }));
});

test('refuse: approval is not valid JSON, has an unknown or missing field, or approvedBy is not owner', () => {
  const w = world();
  fs.writeFileSync(w.file, '{nope', { mode: 0o600 });
  refused('approval-json', () => check(w));
  put(w, { extra: 1 });
  refused('approval-shape', () => check(w));
  for (const k of APPROVAL_KEYS) {
    const a = approvalFor(w); delete a[k];
    fs.writeFileSync(w.file, JSON.stringify(a), { mode: 0o600 });
    refused('approval-shape', () => check(w));
  }
  put(w, { approvedBy: 'coordinator', estimateSha256: undefined });
  refused('approval-shape', () => check(w));
});

// 2-3. run set, session cap, cost caps in the approval ------------------------------------------
test('refuse: requested run set differs from the approved run set (content, repeats, order, extra, none)', () => {
  const w = world(); put(w);
  refused('run-set-mismatch', () => check(w, { runSet: [{ mission: 'G3', repeats: 3 }] }));
  refused('run-set-mismatch', () => check(w, { runSet: [{ mission: 'G3', repeats: 2 }, { mission: 'G1', repeats: 3 }] }));
  refused('run-set-mismatch', () => check(w, { runSet: [RUN[1], RUN[0]] }));
  refused('run-set-mismatch', () => check(w, { runSet: [...RUN, { mission: 'G2', repeats: 1 }] }));
  refused('run-set', () => check(w, { runSet: [] }));
});

test('refuse: maxSessions above the hard cap of 6 in code (a 7th session)', () => {
  const w = world(); put(w, { maxSessions: 7 });
  refused('max-sessions-cap', () => check(w));
  const seven = [{ mission: 'G3', repeats: 4 }, { mission: 'G1', repeats: 3 }];
  put(w, { runSet: seven, maxSessions: 6 });
  refused('max-sessions-cap', () => check(w, { runSet: seven }));
});

test('refuse: run set larger than the approval maxSessions', () => {
  const w = world(); put(w, { maxSessions: 5 });
  refused('max-sessions', () => check(w));
});

test('refuse: a 7th session when six are already in the ledger', () => {
  const w = world();
  const one = [{ mission: 'G2', repeats: 1 }];
  put(w, { runSet: one });
  const approval = approvalFor(w, { runSet: one });
  for (const [m, n] of [['G3', 1], ['G3', 2], ['G3', 3], ['G1', 1], ['G1', 2], ['G1', 3]]) { reserveSession(w.resultsDir, approval, `${m}/${n}`); finishSession(w.resultsDir, approval, `${m}/${n}`, { status: 'finished', costUsd: 0.1 }); }
  refused('max-sessions', () => check(w, { runSet: one }));
  assert.throws(() => reserveSession(w.resultsDir, approval, 'G2/1'), (e) => e.code === 'max-sessions');
});

test('refuse: approval cost caps that are not positive numbers or per-session above total', () => {
  const w = world();
  for (const over of [{ maxUsdPerSession: 0 }, { maxUsdTotal: -1 }, { maxUsdPerSession: '5' }, { maxUsdPerSession: 30 }]) {
    put(w, over);
    refused('approval-shape', () => check(w));
  }
});

// 4. estimate ------------------------------------------------------------------------------------
test('refuse: estimateSha256 does not match the estimate for this run set and these caps', () => {
  const w = world();
  put(w, { estimateSha256: 'b'.repeat(64) });
  refused('estimate-mismatch', () => check(w));
  put(w, { estimateSha256: estimateSha256({ runSet: RUN, maxSessions: 6, maxUsdPerSession: 4, maxUsdTotal: 20 }) });
  refused('estimate-mismatch', () => check(w));
  put(w, { estimateSha256: 'zz' });
  refused('approval-shape', () => check(w));
});

test('estimate: deterministic, shows the worst case and labels assumptions as unmeasured; CLI prints the hash', () => {
  const p = { runSet: RUN, maxSessions: 6, maxUsdPerSession: 5, maxUsdTotal: 20 };
  assert.equal(estimateText(p), estimateText(p));
  assert.match(estimateText(p), /worst case, sessions x per-session cap: US\$30\.00/);
  assert.match(estimateText(p), /UNMEASURED/);
  const out = estimateCommand(['--run', 'G3:3,G1:3', '--max-sessions', '6', '--max-usd-session', '5', '--max-usd-total', '20']);
  assert.ok(out.includes(estimateSha256(p)));
  assert.ok(!/\/(Users|home|tmp)\//.test(out));
  assert.throws(() => parseRunSet('G9:1'));
  assert.throws(() => parseRunSet('G1:0'));
});

// 5. expiry, CI, config ref ---------------------------------------------------------------------
test('refuse: expired approval, approval dated in the future', () => {
  const w = world(); put(w, { expires: '2026-11-04T11:00:00Z' });
  refused('approval-expired', () => check(w));
  put(w, { approvedOn: '2026-11-04T13:00:00Z', expires: '2026-11-06T00:00:00Z' });
  refused('approval-shape', () => check(w));
});

test('refuse: CI is set (any value, including empty)', () => {
  const w = world(); put(w);
  for (const v of ['1', 'true', '', '0']) refused('ci', () => check(w, { env: { CI: v } }));
});

test('refuse: configRef that does not resolve to a commit', () => {
  const w = world(); put(w);
  refused('config-ref', () => check(w, { resolveRef: () => null }));
  put(w, { configRef: '--upload-pack=x' });
  refused('approval-shape', () => check(w));
  put(w, { configRef: 'no-such-branch-xyz' });
  refused('config-ref', () => checkRun({ approvalPath: w.file, runSet: RUN, env: {}, now: NOW, repoRoot: REPO, roots }));
});

// results dir path tricks -------------------------------------------------------------------------
test('refuse: results dir relative, symlink, behind a symlink, in scratch space, in a git work tree, writable by others', () => {
  const w = world();
  put(w, { resultsDir: 'results' });
  refused('results-path', () => check(w));
  const link = path.join(w.base, 'rlink');
  fs.symlinkSync(w.resultsDir, link);
  put(w, { resultsDir: link });
  refused('results-symlink', () => check(w));
  put(w, { resultsDir: path.join(link, 'sub') });
  refused('results-parent-symlink', () => check(w));
  put(w);
  refused('results-scratch', () => checkRun({ approvalPath: w.file, runSet: RUN, env: {}, now: NOW, repoRoot: REPO, roots: [w.resultsDir], resolveRef: () => SHA }));
  const tree = path.join(w.base, 'tree');
  fs.mkdirSync(tree, { mode: 0o700 });
  spawnSync('git', ['init', '-q', tree]);
  put(w, { resultsDir: path.join(tree, 'out') });
  refused('results-parent-worktree', () => check(w));
  put(w); fs.chmodSync(w.resultsDir, 0o770);
  refused('results-writable', () => check(w));
  fs.chmodSync(w.resultsDir, 0o700);
  put(w, { resultsDir: path.join(w.base, 'a', 'b') });
  refused('results-parent-missing', () => check(w));
  put(w, { resultsDir: path.join(w.base, 'newdir') });
  assert.equal(check(w).createResultsDir, true);
});

// 6. ledger ----------------------------------------------------------------------------------------
test('refuse: cost caps. Cumulative reported cost plus the next per-session cap must stay within maxUsdTotal', () => {
  const w = world(); put(w);
  const a = approvalFor(w);
  reserveSession(w.resultsDir, a, 'G3/1'); finishSession(w.resultsDir, a, 'G3/1', { status: 'finished', costUsd: 9 });
  reserveSession(w.resultsDir, a, 'G3/2'); finishSession(w.resultsDir, a, 'G3/2', { status: 'finished', costUsd: 7 });
  assert.equal(spentUsd(readLedger(w.resultsDir, 'pilot-1'), 5), 16);
  refused('max-usd-total', () => check(w)); // 16 + 5 > 20
});

test('cost caps: exactly at the limit is allowed, one cent over is refused (per-session cap counted for unfinished sessions)', () => {
  const approval = { approvalId: 'x', maxSessions: 6, maxUsdPerSession: 5, maxUsdTotal: 20 };
  const l = (sessions) => ({ version: 1, approvalId: 'x', sessions });
  const fin = (slot, c) => ({ slot, startedAt: 't', status: 'finished', costUsd: c });
  assert.doesNotThrow(() => checkLedger(l([fin('G3/1', 15)]), approval, 1));
  assert.throws(() => checkLedger(l([fin('G3/1', 15.01)]), approval, 1), (e) => e.code === 'max-usd-total');
  assert.throws(() => checkLedger(l([fin('G3/1', 1), { slot: 'G3/2', startedAt: 't', status: 'started', costUsd: null }, { slot: 'G3/3', startedAt: 't', status: 'crashed', costUsd: null }, fin('G1/1', 5.01)]), approval, 1), (e) => e.code === 'max-usd-total');
});

test('ledger: a session is written before it starts; a crashed session still counts; no retries of a slot', () => {
  const w = world();
  const a = approvalFor(w);
  reserveSession(w.resultsDir, a, 'G3/1');
  let l = readLedger(w.resultsDir, 'pilot-1');
  assert.deepEqual(l.sessions.map((s) => [s.slot, s.status]), [['G3/1', 'started']]);
  finishSession(w.resultsDir, a, 'G3/1', { status: 'crashed', costUsd: null });
  l = readLedger(w.resultsDir, 'pilot-1');
  assert.equal(l.sessions[0].status, 'crashed');
  assert.equal(spentUsd(l, 5), 5, 'counted at the per-session cap');
  assert.throws(() => reserveSession(w.resultsDir, a, 'G3/1'), (e) => e.code === 'slot-used');
  put(w);
  const r = check(w);
  assert.deepEqual(r.consumed.map((s) => s.slot), ['G3/1']);
  assert.equal(r.todo.length, 5);
});

test('refuse: ledger that is a symlink, a hard link, malformed, foreign or has duplicate slots', () => {
  const w = world(); put(w);
  const lf = path.join(w.resultsDir, 'ledger.json');
  const other = path.join(w.base, 'other.json');
  fs.writeFileSync(other, '{}');
  fs.symlinkSync(other, lf);
  refused('ledger-file', () => check(w));
  fs.unlinkSync(lf);
  fs.writeFileSync(lf, '{"version":1,"approvalId":"pilot-1","sessions":[]}');
  fs.linkSync(lf, path.join(w.base, 'hard.json'));
  refused('ledger-file', () => check(w));
  fs.unlinkSync(lf);
  fs.writeFileSync(lf, 'nope');
  refused('ledger-file', () => check(w));
  fs.writeFileSync(lf, JSON.stringify({ version: 1, approvalId: 'someone-else', sessions: [] }));
  refused('ledger-approval', () => check(w));
  const s = { slot: 'G3/1', startedAt: 't', status: 'started', costUsd: null };
  fs.writeFileSync(lf, JSON.stringify({ version: 1, approvalId: 'pilot-1', sessions: [s, s] }));
  refused('ledger-file', () => check(w));
});

// `run` entry point (moved here from B5, plan test (c)) -----------------------------------------------
function runDeps(extra = {}) {
  const calls = [];
  const spawner = () => { calls.push('spawn'); throw new Error('spawner must not be called'); };
  return { calls, spawner, deps: { repoRoot: REPO, now: NOW, guardOpts: { roots, resolveRef: () => SHA }, env: {}, importLauncher: () => { calls.push('import'); return { launchAll: () => ({ outcomes: [], stopped: null }) }; }, ...extra } };
}

test('run without an approval file throws before the launcher is imported or anything is spawned', async () => {
  const { calls, deps } = runDeps();
  await assert.rejects(() => runCommand(['--run', 'G3:3,G1:3'], deps), (e) => e.code === 'approval-missing');
  await assert.rejects(() => runCommand(['--run', 'G3:3,G1:3', '--approval', '/nonexistent/approval.json'], deps), (e) => e.code === 'approval-missing');
  await assert.rejects(() => runCommand(['--approval', '/x'], deps), (e) => e.code === 'run-set');
  await assert.rejects(() => runCommand(['--run', 'G3:3,G1:3', '--bogus', '1'], deps), (e) => e.code === 'usage');
  await assert.rejects(() => runCommand(['--run', 'bad'], deps), (e) => e.code === 'run-set');
  assert.deepEqual(calls, []);
});

test('run: every refusal happens before the launcher import; a fully valid request reaches it exactly once', async () => {
  const w = world(); put(w);
  const argv = ['--run', 'G3:3,G1:3', '--approval', w.file];
  for (const [env, code] of [[{ CI: '1' }, 'ci']]) {
    const { calls, deps } = runDeps({ env });
    await assert.rejects(() => runCommand(argv, deps), (e) => e.code === code);
    assert.deepEqual(calls, []);
  }
  const mismatch = runDeps();
  await assert.rejects(() => runCommand(['--run', 'G3:2,G1:3', '--approval', w.file], mismatch.deps), (e) => e.code === 'run-set-mismatch');
  assert.deepEqual(mismatch.calls, []);
  const ok = runDeps();
  const r = await runCommand(argv, ok.deps);
  assert.deepEqual(ok.calls, ['import']);
  assert.equal(r.stopped, null);
});

// ---- M8 PR B cycle 2: Sec F4, F7, QA Minor 2 ---------------------------------------------------------------
const gitInit = (dir) => { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0); };

test('Sec F4: a case-varied path to the approval file or results dir does not get past the scratch-root check', (t) => {
  const w = world(); put(w);
  const nativeTmp = fs.realpathSync.native(os.tmpdir());
  const up = (p) => p.toUpperCase();
  if (!fs.existsSync(up(w.file))) { t.skip('case-sensitive filesystem: an upper-case path does not exist'); return; }
  // Sanity: the lower-case path is refused as scratch.
  refused('approval-scratch', () => check(w, { roots: [nativeTmp] }));
  // Upper-case approval path: must be refused, never accepted.
  assert.throws(() => check(w, { approvalPath: up(w.file), roots: [nativeTmp] }), (e) => e instanceof GuardRefusal);
  // Upper-case results dir with an approval outside the temp root (roots: [] stands for "not scratch" for the file).
  const w2 = world(); put(w2, { resultsDir: up(w2.resultsDir) });
  assert.throws(() => check(w2, { roots: [nativeTmp] }), (e) => e instanceof GuardRefusal);
  assert.throws(() => check(w2, { roots: [] }), (e) => e instanceof GuardRefusal && /results/.test(e.code));
});

test('Sec F7: an approval file under a repository .git directory is refused, even when git calls it "not inside a work tree"', () => {
  const w = world(); put(w);
  const repo = path.join(w.base, 'repo');
  gitInit(repo);
  for (const dir of [path.join(repo, '.git'), path.join(repo, '.git', 'refs')]) {
    const f = path.join(dir, 'approval.json');
    put({ ...w, file: f });
    refused('approval-worktree', () => check(w, { approvalPath: f }));
  }
  // A bare repository directory and a path with a .git component that is not a repo are refused too.
  const bare = path.join(w.base, 'bare.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  put({ ...w, file: path.join(bare, 'approval.json') });
  refused('approval-worktree', () => check(w, { approvalPath: path.join(bare, 'approval.json') }));
  const odd = path.join(w.base, 'x', '.git', 'sub');
  fs.mkdirSync(odd, { recursive: true, mode: 0o700 });
  put({ ...w, file: path.join(odd, 'approval.json') });
  refused('approval-worktree', () => check(w, { approvalPath: path.join(odd, 'approval.json') }));
});

test('Sec F7: a results dir (or its missing parent) under .git is refused', () => {
  const w = world();
  const repo = path.join(w.base, 'repo');
  gitInit(repo);
  put(w, { resultsDir: path.join(repo, '.git', 'results') });
  refused('results-parent-worktree', () => check(w));
  fs.mkdirSync(path.join(repo, '.git', 'results'), { mode: 0o700 });
  refused('results-worktree', () => check(w));
});

test('QA Minor 2: an approval file in a group- or world-writable directory is refused; a user-only directory is accepted', () => {
  const w = world(); put(w);
  assert.equal(check(w).approval.approvalId, 'pilot-1');
  for (const mode of [0o770, 0o707, 0o777, 0o720]) {
    fs.chmodSync(w.approvalDir, mode);
    refused('approval-dir-writable', () => check(w));
  }
  fs.chmodSync(w.approvalDir, 0o700);
  assert.equal(check(w).approval.approvalId, 'pilot-1');
});
