import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { outputForMode, ALLOW_JSON, denyJson, readStdin } from '../src/hook-io.mjs';
import { main, defaultInstallDir } from '../src/approver.mjs';
import { APPROVER_DIR } from './helpers.mjs';

const allow = { decision: 'allow', rule_id: 'L-READ' };
const deny = { decision: 'deny', rule_id: 'D-NET' };
const ask = { decision: 'ask', rule_id: 'K-DEFAULT', undecided: true };

test('mode table (plan 3.2): shadow prints nothing; enforce-deny prints deny only; enforce prints allow and deny', () => {
  for (const r of [allow, deny, ask]) assert.equal(outputForMode('shadow', r), '');
  assert.equal(outputForMode('enforce-deny', allow), '');
  assert.equal(outputForMode('enforce-deny', ask), '');
  assert.equal(outputForMode('enforce-deny', deny), denyJson('D-NET'));
  assert.equal(outputForMode('enforce', allow), ALLOW_JSON);
  assert.equal(outputForMode('enforce', deny), denyJson('D-NET'));
  assert.equal(outputForMode('enforce', ask), '');
  assert.equal(outputForMode('enforce', { ...allow, error: 'x' }), '');
  assert.equal(outputForMode('bogus', allow), '');
  assert.equal(outputForMode('enforce', null), '');
});

test('allow JSON is exactly the documented shape', () => {
  assert.deepEqual(JSON.parse(ALLOW_JSON), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

test('deny JSON has a fixed message with only the rule id, and none of the forbidden keys', () => {
  const j = JSON.parse(denyJson('D-SECRET-ENVFILE'));
  assert.equal(j.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(j.hookSpecificOutput.decision.message, 'Denied by the approval policy (rule D-SECRET-ENVFILE). Ask the owner if this is needed.');
  const s = JSON.stringify(j);
  for (const k of ['interrupt', 'updatedInput', 'updatedPermissions']) assert.ok(!s.includes(k), k);
  // a hostile rule id cannot smuggle text into the message
  assert.match(JSON.parse(denyJson('x"; rm -rf /')).hookSpecificOutput.decision.message, /rule UNKNOWN\)/);
});

test('readStdin: oversized and slow input are errors, not partial data', async () => {
  const big = await readStdin(Readable.from([Buffer.alloc(100), Buffer.alloc(100)]), { max: 150 });
  assert.deepEqual(big, { ok: false, error: 'stdin_oversized' });
  const never = new Readable({ read() {} });
  const slow = await readStdin(never, { timeoutMs: 30 });
  assert.deepEqual(slow, { ok: false, error: 'stdin_timeout' });
  assert.deepEqual(await readStdin(Readable.from([Buffer.from('{"a":1}')])), { ok: true, text: '{"a":1}' });
});

test('main: a run that throws, rejects or hangs ends with empty stdout and exit 0', async () => {
  for (const [name, runFn, watchdogMs] of [
    ['throws', async () => { throw new Error('boom'); }, 1000],
    ['sync throw', () => { throw new Error('boom'); }, 1000],
    ['returns junk', async () => 42, 1000],
    ['hangs', () => new Promise(() => {}), 40],
  ]) {
    const writes = []; const exits = [];
    const p = main({ runFn, write: async (t) => writes.push(t), exit: (c) => exits.push(c), watchdogMs });
    if (name === 'hangs') await new Promise((r) => setTimeout(r, 120)); // main never settles; the watchdog exits
    else await p;
    assert.deepEqual(writes, [], name);
    assert.deepEqual(exits, [0], name);
  }
});

test('main: prints the run output exactly once, then exits 0', async () => {
  const writes = []; const exits = [];
  await main({ runFn: async () => ({ stdout: ALLOW_JSON }), write: async (t) => writes.push(t), exit: (c) => exits.push(c) });
  assert.deepEqual(writes, [ALLOW_JSON]);
  assert.deepEqual(exits, [0]);
});

test('main: a failing stdout write still exits 0', async () => {
  const exits = [];
  await main({ runFn: async () => ({ stdout: 'x' }), write: async () => { throw new Error('EPIPE'); }, exit: (c) => exits.push(c) });
  assert.deepEqual(exits, [0]);
});

test('stdout lint: only hook-io.mjs touches stdout (story 1.5)', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(path.join(APPROVER_DIR, 'src'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    if (path.basename(f) === 'hook-io.mjs') continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/process\s*\.\s*stdout|console\s*\.\s*(log|info|error|warn)|process\s*\.\s*stderr|writeSync\(\s*1\b/.test(s), `${f} writes to stdout/stderr`);
  }
});

test('defaultInstallDir is the parent of src/', () => {
  assert.equal(defaultInstallDir(), APPROVER_DIR);
});
