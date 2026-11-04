import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, payload, runHook, spawnHook, readLog, cleanup, writeInstall } from './helpers.mjs';
import { ALLOW_JSON } from '../src/hook-io.mjs';
import { realResolve, inScope, readBranch, isInside } from '../src/paths.mjs';
import { readMode } from '../src/config.mjs';

const envs = [];
const mk = (o) => { const e = makeEnv(o); envs.push(e); return e; };
afterEach(() => { while (envs.length) cleanup(envs.pop()); });

const forceAllow = () => ({ decision: 'allow', rule_id: 'L-READ', undecided: false, reason: 'x' });
const forceDeny = () => ({ decision: 'deny', rule_id: 'D-NET', undecided: false, reason: 'x' });

test('mode table through the whole hook: shadow silent, enforce-deny deny only, enforce allow and deny', async () => {
  for (const [mode, wantAllow, wantDeny] of [['shadow', false, false], ['enforce-deny', false, true], ['enforce', true, true]]) {
    const env = mk({ mode });
    const a = await runHook(env, payload(env), { prefilter: forceAllow });
    const d = await runHook(env, payload(env), { prefilter: forceDeny });
    assert.equal(a.stdout.includes('"allow"'), wantAllow, mode);
    assert.equal(d.stdout.includes('"deny"'), wantDeny, mode);
  }
});

test('fault matrix: no fault ever produces allow output, even in enforce mode with an allowing pre-filter', async () => {
  const env = mk({ mode: 'enforce' });
  const good = JSON.stringify(payload(env));
  const faults = {
    empty: '', 'not json': '{{{', 'json array': '[]', 'json string': '"allow"', null: 'null',
    'missing tool_name': JSON.stringify({ ...payload(env), tool_name: undefined }),
    'tool_input not object': JSON.stringify(payload(env, { tool_input: 'ls' })),
    'tool_input array': JSON.stringify(payload(env, { tool_input: [] })),
    'wrong event': JSON.stringify(payload(env, { hook_event_name: 'PreToolUse' })),
    'cwd number': JSON.stringify(payload(env, { cwd: 5 })),
    'unknown tool': JSON.stringify(payload(env, { tool_name: 'WebFetch' })),
  };
  for (const [name, text] of Object.entries(faults)) {
    const r = await runHook(env, text, { prefilter: forceAllow });
    assert.equal(r.stdout, '', name);
  }
  // prefilter crash and a malformed prefilter result
  assert.equal((await runHook(env, good, { prefilter: () => { throw new Error('x'); } })).stdout, '');
  assert.equal((await runHook(env, good, { prefilter: () => ({ decision: 'maybe' }) })).stdout, '');
  assert.equal((await runHook(env, good, { prefilter: () => undefined })).stdout, '');
  // sanity: the same environment does allow when nothing is wrong
  assert.equal((await runHook(env, good, { prefilter: forceAllow })).stdout, ALLOW_JSON);
});

test('fault matrix through a real process: bad, empty and oversized stdin give empty stdout and exit 0', () => {
  const env = mk({ mode: 'enforce' });
  for (const text of ['', 'garbage', '{"x":', JSON.stringify(payload(env, { tool_input: { command: 'x'.repeat(5 * 1024 * 1024) } }))]) {
    const r = spawnHook(env, text);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('real process: in-scope shadow call exits 0 with empty stdout and writes one log record', () => {
  const env = mk({ mode: 'shadow' });
  const r = spawnHook(env, JSON.stringify(payload(env)));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const log = readLog(env);
  assert.equal(log.length, 1);
  assert.equal(log[0].mode, 'shadow');
  assert.equal(log[0].decision, 'allow', 'the real pre-filter would allow `ls`, and shadow still prints nothing');
  assert.equal(log[0].branch, 'feat/test');
});

test('policy faults: missing, unparsable, tampered, unknown version all ask and log the reason', async () => {
  const cases = {
    policy_missing: (e) => fs.rmSync(path.join(e.installDir, 'policy.json')),
    policy_unparsable: (e) => { fs.writeFileSync(path.join(e.installDir, 'policy.json'), '{nope'); writeInstall(e); },
    policy_version_unknown: (e) => { fs.writeFileSync(path.join(e.installDir, 'policy.json'), '{"policy_version":99}'); writeInstall(e); },
    policy_checksum_mismatch: (e) => fs.appendFileSync(path.join(e.installDir, 'policy.md'), 'ALLOW: curl\n'),
  };
  for (const [err, tamper] of Object.entries(cases)) {
    const env = mk({ mode: 'enforce' });
    tamper(env);
    const r = await runHook(env, payload(env), { prefilter: forceAllow });
    assert.equal(r.stdout, '', err);
    const log = readLog(env);
    assert.equal(log.length, 1, err);
    assert.equal(log[0].error, err);
    assert.equal(log[0].decision, 'ask');
  }
});

test('install.json missing or bad: silent and no crash', async () => {
  const env = mk({ mode: 'enforce' });
  fs.writeFileSync(path.join(env.installDir, 'install.json'), '{"approver_version":1}');
  assert.equal((await runHook(env, payload(env), { prefilter: forceAllow })).stdout, '');
  fs.rmSync(path.join(env.installDir, 'install.json'));
  assert.equal((await runHook(env, payload(env), { prefilter: forceAllow })).stdout, '');
  assert.deepEqual(readLog(env), []);
});

test('mode file: unreadable, empty or unknown means shadow', () => {
  const env = mk({ mode: 'enforce' });
  assert.equal(readMode(env.installDir), 'enforce');
  for (const v of ['', 'ENFORCE', 'enforce-allow', 'yes', 'enforce deny']) {
    fs.writeFileSync(path.join(env.installDir, 'mode'), v);
    assert.equal(readMode(env.installDir), 'shadow', JSON.stringify(v));
  }
  fs.rmSync(path.join(env.installDir, 'mode'));
  assert.equal(readMode(env.installDir), 'shadow');
});

test('scope: outside the repo the hook is silent, writes no log and does not run the pre-filter', async () => {
  const env = mk({ mode: 'enforce' });
  const other = path.join(env.root, 'other'); fs.mkdirSync(other);
  const sibling = env.repo + '-evil'; fs.mkdirSync(sibling);
  let calls = 0;
  const pf = () => { calls++; return forceDeny(); };
  for (const cwd of [other, sibling, env.home, '/', path.join(env.root, 'does-not-exist')]) {
    const r = await runHook(env, payload(env, { cwd }), { prefilter: pf });
    assert.equal(r.stdout, '', cwd);
  }
  assert.equal(calls, 0);
  assert.deepEqual(readLog(env), []);
  assert.equal(fs.existsSync(env.logDir), false);
});

test('scope: subfolders and symlinks into the repo are in scope; symlinks out of it are not', async () => {
  const env = mk({ mode: 'enforce' });
  fs.mkdirSync(path.join(env.repo, 'sub'));
  const linkIn = path.join(env.root, 'link-in'); fs.symlinkSync(path.join(env.repo, 'sub'), linkIn);
  const linkOut = path.join(env.repo, 'link-out'); fs.symlinkSync(env.home, linkOut);
  assert.equal(inScope(path.join(env.repo, 'sub'), env.repo), true);
  assert.equal(inScope(linkIn, env.repo), true);
  assert.equal(inScope(linkOut, env.repo), false);
  assert.equal(inScope(path.join(env.repo, 'sub', '..', '..'), env.repo), false);
  assert.equal(inScope('relative/dir', env.repo), false);
  assert.equal(inScope(undefined, env.repo), false);
  const r = await runHook(env, payload(env, { cwd: linkIn }), { prefilter: forceDeny });
  assert.ok(r.stdout.includes('deny'));
});

test('branch comes from .git/HEAD; detached, missing and a .git file are unknown', () => {
  const env = mk({ branch: 'feat/x/y' });
  assert.equal(readBranch(env.repo), 'feat/x/y');
  fs.writeFileSync(path.join(env.repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(readBranch(env.repo), null);
  fs.writeFileSync(path.join(env.repo, '.git', 'HEAD'), 'ref: refs/heads/main\nextra');
  assert.equal(readBranch(env.repo), null);
  fs.rmSync(path.join(env.repo, '.git'), { recursive: true });
  assert.equal(readBranch(env.repo), null);
  fs.writeFileSync(path.join(env.repo, '.git'), 'gitdir: /elsewhere\n');
  assert.equal(readBranch(env.repo), null);
});

test('realResolve: symlinks, .. through a symlink, missing tails, bad input', () => {
  const env = mk();
  const a = path.join(env.root, 'a'); fs.mkdirSync(path.join(a, 'real'), { recursive: true });
  fs.symlinkSync(path.join(a, 'real'), path.join(a, 'link'));
  fs.writeFileSync(path.join(a, 'file'), 'x');
  assert.deepEqual(realResolve(path.join(a, 'link')), { ok: true, real: path.join(a, 'real'), exists: true });
  // '..' applies to the real directory the link points to, as the kernel does
  assert.equal(realResolve(a + '/link/../file').real, path.join(a, 'file'));
  const miss = realResolve(path.join(a, 'link', 'new', 'x.txt'));
  assert.deepEqual([miss.ok, miss.exists, miss.real], [true, false, path.join(a, 'real', 'new', 'x.txt')]);
  assert.equal(realResolve(a + '/nope/../file').ok, false);
  assert.equal(realResolve('rel', a).real, path.join(a, 'rel'));
  for (const bad of ['', 'a\0b', 5, undefined]) assert.equal(realResolve(bad, a).ok, false);
  fs.symlinkSync(path.join(a, 'l2'), path.join(a, 'l1')); fs.symlinkSync(path.join(a, 'l1'), path.join(a, 'l2'));
  assert.equal(realResolve(path.join(a, 'l1')).ok, false);
  assert.equal(isInside('/x/y', '/x'), true);
  assert.equal(isInside('/x-evil', '/x'), false);
  assert.equal(isInside('/x/..y', '/x'), true);
});
