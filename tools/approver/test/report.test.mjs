import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { makeEnv, cleanup, APPROVER_DIR } from './helpers.mjs';
import { appendRecord } from '../src/log.mjs';
import { sha256, canonicalJson } from '../src/util.mjs';
import { buildReport, formatReport, outcomeOf, shapeOf } from '../bin/report.mjs';

const envs = [];
const mk = () => { const e = makeEnv(); envs.push(e); fs.mkdirSync(path.join(e.home, '.claude', 'projects', 'proj'), { recursive: true }); return e; };
afterEach(() => { while (envs.length) cleanup(envs.pop()); });

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tpath = (e, name = 'sess') => path.join(e.home, '.claude', 'projects', 'proj', `${name}.jsonl`);

// Synthetic transcript lines in the shape verified in Step A (plan 2.2). `ev.result === null` means no tool_result.
function writeTranscript(file, events, { entrypoint = 'cli', version = '2.1.318' } = {}) {
  const lines = [];
  events.forEach((ev, i) => {
    const id = ev.id || `toolu_${i}`;
    const ts = ev.ts ?? T0 + i * 10000;
    lines.push({ type: 'assistant', sessionId: 'sess', timestamp: iso(ts), isSidechain: !!ev.sidechain, entrypoint: ev.entrypoint ?? entrypoint, version, cwd: ev.cwd ?? '/repo', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: ev.tool || 'Bash', input: ev.input }] } });
    if (ev.result !== null) {
      const r = { type: 'user', sessionId: 'sess', timestamp: iso(ts + 2000), isSidechain: !!ev.sidechain, entrypoint: ev.entrypoint ?? entrypoint, version, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!ev.result?.denial }] } };
      if (ev.result?.denial) r.toolDenialKind = ev.result.denial;
      if (ev.result?.pd) r.permissionDecision = ev.result.pd;
      lines.push(r);
    }
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// A decision record as the hook writes it.
function logRec(e, { tool = 'Bash', input, ts, decision = 'ask', rule = 'K-DEFAULT', undecided = false, transcript, extra = {} }) {
  appendRecord(e.logDir, {
    ts: iso(ts), record_id: `r${Math.random().toString(16).slice(2)}`, type: 'decision', session_id: 'sess', mode: 'shadow', tool_name: tool, cwd: '/repo',
    transcript_path: transcript ?? tpath(e), permission_mode: 'default', branch: 'feat/x', input_redacted: tool === 'Bash' ? input.command : `${tool} ${input.file_path} (content 1 chars)`,
    input_hash: sha256(canonicalJson(input)), input_size: 10, truncated: false, stage: 'prefilter', decision, reason: 'r', rule_id: rule, undecided,
    latency_ms: 5, model: null, model_cost_usd: null, error: null, policy_version: 1, approver_version: '1.0.0', observed_outcome: null, ...extra,
  });
}
const accept = { pd: { decision: 'accept', source: 'user_temporary', reasonCode: 'bashMiss:x' } };
const reject = { pd: { decision: 'reject', source: 'user_reject' }, denial: 'user-rejected' };
const cmd = (c) => ({ command: c });

test('observed outcome mapping (plan 3.12): ran, not_run, unknown, ambiguous and the reasons', async () => {
  const e = mk();
  const events = [
    { input: cmd('c1'), result: accept }, { input: cmd('c2'), result: { pd: { decision: 'accept', source: 'config', reasonType: 'mode' } } },
    { input: cmd('c3'), result: reject }, { input: cmd('c4'), result: { denial: 'permission-rule' } }, { input: cmd('c5'), result: null },
    { input: cmd('c6'), result: {} }, { input: cmd('c7'), result: reject, entrypoint: 'sdk-cli' },
  ];
  writeTranscript(tpath(e), events);
  events.forEach((ev, i) => logRec(e, { input: ev.input, ts: T0 + i * 10000 + 1000 }));
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  const got = Object.fromEntries(r.recent.map((x, i) => [`c${i + 1}`, [x.outcome, x.detail]]));
  assert.deepEqual(got.c1, ['ran', 'owner approved']);
  assert.deepEqual(got.c2, ['ran', 'accepted by config']);
  assert.equal(got.c3[0], 'not_run'); assert.equal(got.c3[1], 'user-rejected');
  assert.deepEqual(got.c4, ['not_run', 'permission-rule']);
  assert.equal(got.c5[0], 'unknown'); assert.match(got.c5[1], /interrupted/);
  assert.deepEqual(got.c6, ['unknown', 'format_unrecognized']);
  assert.equal(got.c7[0], 'unknown'); assert.match(got.c7[1], /-p/);
  assert.match(r.warnings.join(' '), /format_unrecognized.*2\.1\.318/);
  assert.deepEqual(r.observed, { ran: 2, not_run: 2, unknown: 3 });
  assert.equal(outcomeOf({ entrypoint: 'cli' }, undefined).outcome, 'unknown');
});

test('unavailable transcripts are unknown, never guessed: missing, outside ~/.claude/projects, not .jsonl, symlink out', async () => {
  const e = mk();
  const outside = path.join(e.root, 'outside.jsonl');
  writeTranscript(outside, [{ input: cmd('x'), result: accept }]);
  const link = path.join(e.home, '.claude', 'projects', 'proj', 'linked.jsonl'); fs.symlinkSync(outside, link);
  const notJsonl = path.join(e.home, '.claude', 'projects', 'proj', 'x.txt'); fs.writeFileSync(notJsonl, '');
  for (const t of [tpath(e, 'missing'), outside, link, notJsonl, '', null]) logRec(e, { input: cmd('x'), ts: T0 + 1000, transcript: t ?? undefined, extra: t === null ? { transcript_path: null } : {} });
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  assert.deepEqual(r.observed, { unknown: 6 });
  assert.equal(r.would_allow_but_not_run.length, 0);
});

test('matching: repeated identical calls each get their own result; two unclaimed candidates are ambiguous (story 5.4)', async () => {
  const e = mk();
  writeTranscript(tpath(e), [{ input: cmd('same'), result: accept, ts: T0 }, { input: cmd('same'), result: reject, ts: T0 + 20000 }]);
  logRec(e, { input: cmd('same'), ts: T0 + 1000 }); logRec(e, { input: cmd('same'), ts: T0 + 21000 });
  let r = await buildReport({ logDir: e.logDir, home: e.home });
  assert.deepEqual(r.recent.map((x) => x.outcome), ['ran', 'not_run']);
  // parallel identical calls with one record: cannot tell which one the record is
  const e2 = mk();
  writeTranscript(tpath(e2), [{ input: cmd('same'), result: accept, ts: T0 }, { input: cmd('same'), result: reject, ts: T0 + 500 }]);
  logRec(e2, { input: cmd('same'), ts: T0 + 1000 });
  r = await buildReport({ logDir: e2.logDir, home: e2.home });
  assert.deepEqual(r.observed, { ambiguous: 1 });
  // a different tool name or a different input never matches; a call outside the 120 s window does not match
  const e3 = mk();
  writeTranscript(tpath(e3), [{ input: cmd('a'), result: accept, ts: T0 }, { input: cmd('b'), result: accept, ts: T0 + 400000 }]);
  logRec(e3, { input: cmd('zzz'), ts: T0 + 1000 });
  logRec(e3, { tool: 'Write', input: { file_path: '/repo/a', content: 'x' }, ts: T0 + 1000 });
  logRec(e3, { input: cmd('b'), ts: T0 + 100000 });
  r = await buildReport({ logDir: e3.logDir, home: e3.home });
  assert.deepEqual(r.observed, { unknown: 3 });
});

test('subagent transcripts in the session folder are searched too', async () => {
  const e = mk();
  writeTranscript(tpath(e), [{ input: cmd('main'), result: accept }]);
  writeTranscript(path.join(e.home, '.claude', 'projects', 'proj', 'sess', 'subagents', 'agent-1.jsonl'), [{ input: cmd('from subagent'), result: reject, sidechain: true }]);
  logRec(e, { input: cmd('from subagent'), ts: T0 + 1000, extra: { agent_id: 'agent-1' } });
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  assert.deepEqual(r.observed, { not_run: 1 });
  assert.deepEqual(r.by_session_type, { subagent: 1 });
});

test('agreement rate excludes unknown and ambiguous; the two disagreement lists are complete, never sampled (story 6.1-6.3)', async () => {
  const e = mk();
  const events = []; const recs = [];
  for (let i = 0; i < 30; i++) { events.push({ input: cmd('allow-denied-' + i), result: reject }); recs.push({ decision: 'allow', rule: 'L-READ' }); }
  for (let i = 0; i < 7; i++) { events.push({ input: cmd('deny-ran-' + i), result: accept }); recs.push({ decision: 'deny', rule: 'D-NET' }); }
  for (let i = 0; i < 10; i++) { events.push({ input: cmd('allow-ran-' + i), result: accept }); recs.push({ decision: 'allow', rule: 'L-READ' }); }
  for (let i = 0; i < 4; i++) { events.push({ input: cmd('ask-notrun-' + i), result: reject }); recs.push({ decision: 'ask' }); }
  for (let i = 0; i < 5; i++) { events.push({ input: cmd('unk-' + i), result: null }); recs.push({ decision: 'allow', rule: 'L-READ' }); }
  writeTranscript(tpath(e), events);
  events.forEach((ev, i) => logRec(e, { input: ev.input, ts: T0 + i * 10000 + 1000, ...recs[i] }));
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  assert.equal(r.would_allow_but_not_run.length, 30);
  assert.equal(r.would_deny_but_ran.length, 7);
  assert.deepEqual(r.agreement, { agree: 14, considered: 51, rate: 14 / 51, excluded_unknown: 5, excluded_ambiguous: 0 });
  const text = formatReport(r);
  assert.equal((text.match(/allow-denied-\d+/g) || []).length, 30);
  assert.equal((text.match(/deny-ran-\d+/g) || []).length, 7);
  assert.match(text, /not_run can also mean a tool error or a block by another hook or rule, not only a human "No"/);
  assert.match(text, /excluded: unknown 5, ambiguous 0/);
  assert.match(text, /p50 5 ms, p95 5 ms/);
});

test('auto_allowed counts rule-accepted calls in the same sessions that never reached the hook', async () => {
  const e = mk();
  const rule = { pd: { decision: 'accept', source: 'config', reasonType: 'rule' } };
  writeTranscript(tpath(e), [{ input: cmd('hooked'), result: accept }, { input: cmd('auto1'), result: rule }, { input: cmd('auto2'), result: rule }, { input: cmd('elsewhere'), result: rule, cwd: '/other/project' }]);
  logRec(e, { input: cmd('hooked'), ts: T0 + 1000 });
  const r = await buildReport({ logDir: e.logDir, home: e.home, repoRoot: '/repo' });
  assert.equal(r.auto_allowed, 2);
});

test('top-10 asks table (Q14): grouped by rule and command shape, most frequent first, capped', async () => {
  const e = mk();
  writeTranscript(tpath(e), []);
  let i = 0;
  const add = (c, n, rule = 'K-DEFAULT') => { for (let k = 0; k < n; k++) logRec(e, { input: cmd(c), ts: T0 + (i++) * 1000, rule, decision: 'ask' }); };
  add('git push -u origin feat/a', 9); add('npm install left-pad', 5, 'K-INSTALL'); add('npm install lodash', 3, 'K-INSTALL'); add('docker ps', 2);
  for (let k = 0; k < 12; k++) add('tool' + k + ' x', 1);
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  assert.equal(r.top_asks.length, 10);
  assert.equal(r.top_asks[0].count, 9); assert.match(r.top_asks[0].key, /K-DEFAULT \| git push/);
  assert.equal(r.top_asks[1].count, 8); assert.match(r.top_asks[1].key, /K-INSTALL \| npm install/);
  assert.equal(shapeOf({ tool_name: 'Edit', input_redacted: 'Edit /r/docs/x/a.md (old 1, new 1 chars)' }), 'Edit .../docs/x/*.md');
});

test('model section: opinion vs final decision vs outcome, skip reasons and total cost; nothing is decided by the model', async () => {
  const e = mk();
  writeTranscript(tpath(e), [{ input: cmd('m1'), result: reject }, { input: cmd('m2'), result: accept }, { input: cmd('m3'), result: accept }]);
  const ids = [];
  ['m1', 'm2', 'm3'].forEach((c, i) => { logRec(e, { input: cmd(c), ts: T0 + i * 10000 + 1000, undecided: true, extra: { record_id: 'id' + i } }); ids.push('id' + i); });
  const m = (id, extra) => appendRecord(e.logDir, { type: 'model', ts: iso(T0 + 50000), record_id: id, model: 'test', model_decision: null, model_reason: null, latency_ms: 700, model_cost_usd: null, skipped: null, error: null, ...extra });
  m('id0', { model_decision: 'allow', model_reason: 'looks fine', model_cost_usd: 0.0012 });
  m('id1', { model_decision: 'deny', model_reason: 'x', model_cost_usd: 0.0013 });
  m('id2', { skipped: 'daily_cap' });
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  assert.equal(r.model.calls, 2);
  assert.ok(Math.abs(r.model.cost_usd - 0.0025) < 1e-9);
  assert.deepEqual(r.model.skipped, { daily_cap: 1 });
  assert.equal(r.model.vs['model allow | final ask | observed not_run'], 1);
  assert.equal(r.model.vs['model deny | final ask | observed ran'], 1);
  assert.equal(r.model.would_allow_not_run.length, 1);
  assert.deepEqual(r.by_stage, { prefilter: 3 });
  assert.match(formatReport(r), /Model \(log only\): 2 answered of 3 undecided/);
});

test('date range filter and mode split', async () => {
  const e = mk();
  writeTranscript(tpath(e), []);
  logRec(e, { input: cmd('a'), ts: Date.parse('2026-11-01T10:00:00Z') });
  logRec(e, { input: cmd('b'), ts: Date.parse('2026-11-03T10:00:00Z'), extra: { mode: 'enforce' } });
  logRec(e, { input: cmd('c'), ts: Date.parse('2026-11-05T10:00:00Z') });
  const r = await buildReport({ logDir: e.logDir, home: e.home, from: '2026-11-02', to: '2026-11-04' });
  assert.equal(r.total, 1); assert.deepEqual(r.by_mode, { enforce: 1 });
});

test('empty, missing or out-of-range log: says so and exits cleanly (story 6.6)', async () => {
  const e = mk();
  assert.match(formatReport(await buildReport({ logDir: path.join(e.root, 'nope'), home: e.home })), /empty or missing/);
  fs.mkdirSync(e.logDir, { recursive: true }); fs.writeFileSync(path.join(e.logDir, 'decisions.jsonl'), '');
  assert.match(formatReport(await buildReport({ logDir: e.logDir, home: e.home })), /empty or missing/);
  const r = spawnSync(process.execPath, [path.join(APPROVER_DIR, 'bin', 'report.mjs'), '--log-dir', e.logDir, '--home', e.home], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0); assert.match(r.stdout, /empty or missing/);
  fs.writeFileSync(path.join(e.logDir, 'decisions.jsonl'), 'garbage\n{"type":"decision"');
  assert.match(formatReport(await buildReport({ logDir: e.logDir, home: e.home })), /empty or missing/);
});

test('read-only and offline (story 6.5): the log and directory are untouched, and any network call would throw', async () => {
  const e = mk();
  writeTranscript(tpath(e), [{ input: cmd('a'), result: accept }]);
  logRec(e, { input: cmd('a'), ts: T0 + 1000 });
  const before = fs.readdirSync(e.logDir).map((f) => [f, sha256(fs.readFileSync(path.join(e.logDir, f)))]);
  const saved = { fetch: globalThis.fetch, hr: https.request, hq: http.request, nc: net.connect, ns: net.Socket.prototype.connect };
  const boom = () => { throw new Error('NETWORK USED'); };
  globalThis.fetch = boom; https.request = boom; http.request = boom; net.connect = boom; net.Socket.prototype.connect = boom;
  try { formatReport(await buildReport({ logDir: e.logDir, home: e.home })); }
  finally { globalThis.fetch = saved.fetch; https.request = saved.hr; http.request = saved.hq; net.connect = saved.nc; net.Socket.prototype.connect = saved.ns; }
  assert.deepEqual(fs.readdirSync(e.logDir).map((f) => [f, sha256(fs.readFileSync(path.join(e.logDir, f)))]), before);
  const src = fs.readFileSync(path.join(APPROVER_DIR, 'bin', 'report.mjs'), 'utf8');
  assert.ok(!/node:(https?|net|tls|dgram|child_process|dns)|fetch\(|writeFile|appendFile|unlink|rmSync/.test(src));
});

test('transcript content is never stored or printed: only name, hash and times are kept', async () => {
  const e = mk();
  writeTranscript(tpath(e), [{ input: { command: 'echo TOPSECRETCOMMANDBODY', description: 'TOPSECRETDESC' }, result: accept }]);
  logRec(e, { input: { command: 'echo TOPSECRETCOMMANDBODY', description: 'TOPSECRETDESC' }, ts: T0 + 1000, extra: { input_redacted: 'echo [shown]' } });
  const r = await buildReport({ logDir: e.logDir, home: e.home });
  const text = formatReport(r) + JSON.stringify(r);
  assert.ok(!text.includes('TOPSECRET'));
  assert.deepEqual(r.observed, { ran: 1 });
});

test('--selfcheck prints the permission markers of the latest records (the owner "No" check, plan section 4 T9)', async () => {
  const e = mk();
  writeTranscript(tpath(e), [{ input: cmd('a'), result: accept }, { input: cmd('b'), result: reject }]);
  logRec(e, { input: cmd('a'), ts: T0 + 1000 }); logRec(e, { input: cmd('b'), ts: T0 + 11000 });
  const text = formatReport(await buildReport({ logDir: e.logDir, home: e.home }), { selfcheck: 5 });
  assert.match(text, /not_run \(user-rejected\).*"denialKind":"user-rejected"/);
  assert.match(text, /ran \(owner approved\).*"source":"user_temporary"/);
});

test('committed synthetic transcripts: interactive approved/auto-allowed, interactive denied, headless denied', async () => {
  const e = mk();
  const fx = path.join(APPROVER_DIR, 'test', 'fixtures', 'transcripts');
  for (const f of fs.readdirSync(fx)) fs.copyFileSync(path.join(fx, f), path.join(e.home, '.claude', 'projects', 'proj', f));
  const tp = (n) => path.join(e.home, '.claude', 'projects', 'proj', n + '.jsonl');
  logRec(e, { input: { command: 'echo hello', description: 'say hello' }, ts: Date.parse('2026-11-04T10:00:01Z'), transcript: tp('interactive-approved') });
  logRec(e, { input: cmd('npm install left-pad'), ts: Date.parse('2026-11-04T11:00:01Z'), transcript: tp('interactive-denied'), rule: 'K-INSTALL' });
  logRec(e, { tool: 'Write', input: { file_path: '/repo/a.txt', content: 'x' }, ts: Date.parse('2026-11-04T12:00:00.500Z'), transcript: tp('headless-denied'), decision: 'allow', rule: 'L-EDIT' });
  const r = await buildReport({ logDir: e.logDir, home: e.home, repoRoot: '/repo' });
  assert.deepEqual(r.recent.map((x) => x.outcome), ['ran', 'not_run', 'unknown']);
  assert.match(r.recent[2].detail, /-p/);
  assert.equal(r.auto_allowed, 1);
  assert.deepEqual(r.by_session_type, { interactive: 2, 'headless (-p)': 1 });
  assert.equal(r.would_allow_but_not_run.length, 0, 'headless is unknown, so it is not counted as not_run (story 13.4)');
});
