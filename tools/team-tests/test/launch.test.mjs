// B7: launcher, init-event guard, usage parser, timeouts, run.json. NO `claude` process is ever
// started: every test injects a stub spawner that returns a fake child fed with synthetic events.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildArgs, buildSettings, buildAgents, buildPrompt, parseAgentFile, loadProfile, loadNestedSettings, runInvocation, runSession, launchAll, scrubText, checkApiKey, resolveClaude, FORBIDDEN_ARGS, KEY_ENV } from '../src/launch.mjs';
import { checkInit } from '../src/initguard.mjs';
import { parseUsage, addUsage, reconcile } from '../src/usage.mjs';
import { parseTranscript } from '../src/transcript.mjs';
import { loadResults } from '../src/results.mjs';
import { reserveSession, readLedger } from '../src/ledger.mjs';
import { resolveRefSha } from '../src/guard.mjs';
import { loadAll } from '../src/missions.mjs';
import { REPO, L, ndjson } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const KEY = 'sk-ant-test-0123456789abcdefghij';
const profile = loadProfile();
const MISSIONS = loadAll();

// ---- fake child ---------------------------------------------------------------------------------
/** A child that speaks `lines` (objects or strings) and closes. `ignoreTerm` models a child that needs SIGKILL. */
function fakeChild({ lines = [], hang = false, ignoreTerm = false, exitCode = 0 } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdinData = null;
  c.stdin = { end(d) { c.stdinData = d; }, on() {} };
  c.signals = [];
  let closed = false;
  const close = (code, sig) => { if (closed) return; closed = true; c.stdout.end(); setImmediate(() => c.emit('close', code, sig)); };
  c.kill = (sig) => { c.signals.push(sig); if (sig === 'SIGKILL' || !ignoreTerm) close(null, sig); return true; };
  setImmediate(() => {
    for (const l of lines) if (!closed) c.stdout.write(typeof l === 'string' ? `${l}\n` : `${JSON.stringify(l)}\n`);
    if (!hang) close(exitCode, null);
  });
  return c;
}
const stub = (...scripts) => {
  const calls = [];
  const spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const s = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    const child = typeof s === 'function' ? s({ cmd, args, opts }) : fakeChild(s);
    calls[calls.length - 1].child = child;
    return child;
  };
  return { spawner, calls };
};

const EXPECT = { cwd: '/fx', allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Task'], allowedModes: ['default'], apiKeySource: 'apiKeyHelper', model: 'sonnet', agents: ['developer', 'product-analyst'] };
const goodInit = (o = {}) => ({ type: 'system', subtype: 'init', cwd: '/fx', tools: ['Bash', 'Read'], mcp_servers: [], permissionMode: 'default', apiKeySource: 'apiKeyHelper', model: 'sonnet', agents: ['developer', 'product-analyst'], session_id: 's1', ...o });

// ---- profile and settings (no bypass) ----------------------------------------------------------
test('profile, nested settings and built arguments contain no permission bypass or forbidden option', () => {
  const texts = [fs.readFileSync(path.join(ROOT, 'config', 'launch-profile.json'), 'utf8'), fs.readFileSync(path.join(ROOT, 'config', 'nested-settings.json'), 'utf8')];
  const args = buildArgs({ profile, settingsPath: '/o/settings.json', agentsPath: '/o/agents.json', systemPrompt: 'sys', model: 'sonnet', maxBudgetUsd: 5, sessionId: UUID });
  texts.push(JSON.stringify(args), JSON.stringify(buildSettings(loadNestedSettings())));
  for (const t of texts) for (const f of [...FORBIDDEN_ARGS, '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions']) assert.ok(!t.includes(f), `contains ${f}`);
  assert.ok(FORBIDDEN_ARGS.includes('--dangerously-skip-permissions') && FORBIDDEN_ARGS.includes('--allow-dangerously-skip-permissions') && FORBIDDEN_ARGS.includes('bypassPermissions'));
});

test('profile: bare, restricted, empty strict MCP, no prompts, project settings only, no WebFetch or WebSearch', () => {
  assert.ok(profile.flags.includes('--bare') && profile.flags.includes('--restricted') && profile.flags.includes('--strict-mcp-config') && profile.flags.includes('--verbose'));
  assert.equal(profile.valueFlags['--permission-prompts'], 'none');
  assert.equal(profile.valueFlags['--setting-sources'], 'project');
  assert.equal(profile.valueFlags['--output-format'], 'stream-json');
  assert.deepEqual(JSON.parse(profile.mcpConfig), { mcpServers: {} });
  assert.ok(!profile.tools.some((t) => /^Web/.test(t)));
  assert.equal(profile.invocationTimeoutMs, 20 * 60 * 1000);
  assert.equal(profile.killGraceMs, 10000);
});

test('nested settings: deny list covers push, remote, network tools, secrets tools, web tools; allow list has no push or remote', () => {
  const s = loadNestedSettings();
  for (const d of ['git push', 'git remote', 'git config', 'railway', 'curl', 'wget', 'ssh', 'scp', 'nc', 'security', 'printenv', 'env', 'gh']) assert.ok(s.permissions.deny.includes(`Bash(${d}:*)`), `deny ${d}`);
  assert.ok(s.permissions.deny.includes('WebFetch') && s.permissions.deny.includes('WebSearch'));
  assert.ok(!s.permissions.allow.some((a) => /git (push|remote|config)/.test(a) || /^Web/.test(a) || a === 'Bash' || /bypass/i.test(a)));
  assert.equal(s.defaultMode, undefined);
  assert.equal(s.permissions.defaultMode, undefined);
});

test('buildSettings adds only the key helper (no key value); the helper reads the child environment variable', () => {
  const out = buildSettings(loadNestedSettings());
  assert.equal(out.apiKeyHelper, `/usr/bin/printenv ${KEY_ENV}`);
  assert.equal(out.note, undefined);
  assert.ok(!JSON.stringify(out).includes('sk-ant'));
});

// ---- argument building ---------------------------------------------------------------------------
test('buildArgs returns an args array with the plan 5.1 flags; metacharacters stay one element; prompt is not an argument', () => {
  const sys = 'CLAUDE.md text; $(rm) `x` && "q"';
  const a = buildArgs({ profile, settingsPath: '/o/settings.json', agentsPath: '/o/agents.json', systemPrompt: sys, model: 'sonnet', maxBudgetUsd: 4.5, sessionId: UUID });
  assert.ok(Array.isArray(a) && a.every((x) => typeof x === 'string'));
  for (const f of ['-p', '--bare', '--restricted', '--strict-mcp-config', '--verbose']) assert.ok(a.includes(f), f);
  const val = (f) => a[a.indexOf(f) + 1];
  assert.equal(val('--output-format'), 'stream-json');
  assert.equal(val('--permission-prompts'), 'none');
  assert.equal(val('--setting-sources'), 'project');
  assert.equal(val('--settings'), '/o/settings.json');
  assert.equal(val('--agents'), '/o/agents.json');
  assert.equal(val('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(val('--append-system-prompt'), sys);
  assert.equal(val('--model'), 'sonnet');
  assert.equal(val('--max-budget-usd'), '4.50');
  assert.equal(val('--session-id'), UUID);
  assert.ok(!a.includes('--resume'));
  assert.equal(val('--tools'), 'Bash,Read,Edit,Write,Glob,Grep,Agent');
  assert.equal(a.filter((x) => x === sys).length, 1);
  const r = buildArgs({ profile, settingsPath: 's', agentsPath: 'a', systemPrompt: 'x', model: 'sonnet', maxBudgetUsd: 1, sessionId: UUID, resumeId: UUID });
  assert.equal(r[r.indexOf('--resume') + 1], UUID);
  assert.ok(!r.includes('--session-id'));
});

test('buildArgs rejects a bad budget, session id or model', () => {
  const base = { profile, settingsPath: 's', agentsPath: 'a', systemPrompt: 'x', model: 'sonnet', maxBudgetUsd: 1, sessionId: UUID };
  assert.throws(() => buildArgs({ ...base, maxBudgetUsd: 0 }));
  assert.throws(() => buildArgs({ ...base, maxBudgetUsd: NaN }));
  assert.throws(() => buildArgs({ ...base, sessionId: 'not-a-uuid' }));
  assert.throws(() => buildArgs({ ...base, model: 'x; rm' }));
  assert.throws(() => buildArgs({ ...base, profile: { ...profile, flags: [...profile.flags, '--dangerously-skip-permissions'] } }));
  assert.throws(() => buildArgs({ ...base, profile: { ...profile, flags: [...profile.flags, '--allow-dangerously-skip-permissions'] } }));
});

test('runInvocation passes an args array with shell off, the prompt on stdin, and refuses a string', async () => {
  const s = stub({ lines: [goodInit(), L.result('ok')] });
  const out = await runInvocation({ spawner: s.spawner, claudePath: '/bin/stub', args: ['-p', '--x'], env: { A: '1' }, cwd: '/fx', prompt: 'hello', expect: EXPECT, key: KEY, timeoutMs: 1000, killGraceMs: 50 });
  assert.equal(s.calls.length, 1);
  assert.ok(Array.isArray(s.calls[0].args));
  assert.equal(s.calls[0].opts.shell, false);
  assert.deepEqual(s.calls[0].opts.env, { A: '1' });
  assert.equal(s.calls[0].child.stdinData, 'hello');
  assert.equal(out.initProblems, null);
  assert.throws(() => runInvocation({ spawner: s.spawner, claudePath: '/bin/stub', args: '-p --x', env: {}, cwd: '/fx', prompt: '', expect: EXPECT, timeoutMs: 10, killGraceMs: 10 }), /array/);
});

test('buildPrompt, buildAgents and parseAgentFile: run-team body with $ARGUMENTS replaced literally; agents from front matter', () => {
  const p = buildPrompt('---\ndescription: x\n---\nMission: $ARGUMENTS\nAgain $ARGUMENTS', "a $& $1 'b'");
  assert.equal(p, "Mission: a $& $1 'b'\nAgain a $& $1 'b'");
  assert.ok(!p.startsWith('-'));
  const a = parseAgentFile('---\nname: developer\ndescription: d\ntools: Read, Edit\nmodel: sonnet\n---\nBody text');
  assert.deepEqual(a, { name: 'developer', def: { description: 'd', prompt: 'Body text', tools: ['Read', 'Edit'], model: 'sonnet' } });
  assert.throws(() => parseAgentFile('---\ndescription: d\n---\nx'));
  const agents = buildAgents(REPO);
  assert.ok(agents.developer && agents['product-analyst'] && agents['engineering-lead']);
});

// ---- init-event guard -----------------------------------------------------------------------------
test('init guard: a correct init passes', () => assert.deepEqual(checkInit(goodInit(), EXPECT), []));

const FORBIDDEN_INIT = [
  ['cwd-not-fixture', { cwd: '/elsewhere' }],
  ['mcp-servers-not-empty', { mcp_servers: [{ name: 'railway', status: 'connected' }] }],
  ['tools-not-subset', { tools: ['Bash', 'WebFetch'] }],
  ['permission-mode-bypass', { permissionMode: 'bypassPermissions' }],
  ['permission-mode-unknown', { permissionMode: 'somethingNew' }],
  ['api-key-source', { apiKeySource: 'ANTHROPIC_API_KEY' }],
  ['api-key-source', { apiKeySource: 'oauth' }],
  ['model-not-approved', { model: 'opus' }],
  ['agents-mismatch', { agents: ['developer'] }],
  ['agents-mismatch', { agents: ['developer', 'product-analyst', 'rogue'] }],
  ['plugins-not-empty', { plugins: [{ name: 'p' }] }],
  ['unknown-field', { newCapability: true }],
];
for (const [problem, patch] of FORBIDDEN_INIT) {
  test(`init guard: ${problem} (${Object.keys(patch)[0]}=${JSON.stringify(Object.values(patch)[0]).slice(0, 24)}) is refused and the child is killed`, async () => {
    assert.ok(checkInit(goodInit(patch), EXPECT).includes(problem));
    const s = stub({ lines: [goodInit(patch), L.say('working'), L.result('x')], hang: true });
    const out = await runInvocation({ spawner: s.spawner, claudePath: '/bin/stub', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 5000, killGraceMs: 50 });
    assert.ok(out.initProblems.includes(problem));
    assert.deepEqual(s.calls[0].child.signals.slice(0, 1), ['SIGTERM']);
  });
}

for (const k of ['cwd', 'tools', 'mcp_servers', 'permissionMode', 'apiKeySource', 'model', 'agents', 'session_id']) {
  test(`init guard fails closed when ${k} is missing or null`, async () => {
    const init = goodInit(); delete init[k];
    assert.ok(checkInit(init, EXPECT).includes(`missing-${k}`));
    assert.ok(checkInit(goodInit({ [k]: null }), EXPECT).includes(`missing-${k}`));
    const s = stub({ lines: [init, L.result('x')], hang: true });
    const out = await runInvocation({ spawner: s.spawner, claudePath: '/bin/stub', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 5000, killGraceMs: 50 });
    assert.ok(out.initProblems.includes(`missing-${k}`));
    assert.equal(s.calls[0].child.signals[0], 'SIGTERM');
  });
}

test('init guard: wrong types and a non-object init fail closed', () => {
  assert.deepEqual(checkInit(null, EXPECT), ['init-not-object']);
  assert.deepEqual(checkInit([], EXPECT), ['init-not-object']);
  assert.ok(checkInit(goodInit({ tools: 'Bash' }), EXPECT).includes('tools-type'));
  assert.ok(checkInit(goodInit({ mcp_servers: {} }), EXPECT).includes('mcp-servers-type'));
  assert.ok(checkInit(goodInit({ agents: 'developer' }), EXPECT).includes('agents-type'));
  assert.ok(checkInit(goodInit({ permissionMode: 7 }), EXPECT).includes('permission-mode-bypass'));
  assert.ok(checkInit(goodInit({ cwd: 7 }), EXPECT).includes('cwd-not-fixture'));
});

test('init guard: no init event at all (a result first, or the stream ends) kills the child and fails closed', async () => {
  const a = stub({ lines: [L.result('x')], hang: true });
  const o1 = await runInvocation({ spawner: a.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 5000, killGraceMs: 50 });
  assert.deepEqual(o1.initProblems, ['init-event-missing']);
  assert.equal(a.calls[0].child.signals[0], 'SIGTERM');
  const b = stub({ lines: [L.say('hi')] });
  const o2 = await runInvocation({ spawner: b.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 5000, killGraceMs: 50 });
  assert.deepEqual(o2.initProblems, ['init-event-missing']);
});

test('init guard: a child that ignores SIGTERM is killed with SIGKILL after the grace period', async () => {
  const s = stub({ lines: [goodInit({ cwd: '/elsewhere' })], hang: true, ignoreTerm: true });
  const out = await runInvocation({ spawner: s.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 5000, killGraceMs: 30 });
  assert.deepEqual(s.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(out.initProblems);
});

test('data after an init failure is not stored', async () => {
  const s = stub({ lines: [goodInit({ model: 'opus' }), L.say('secret later text')], hang: true });
  const out = await runInvocation({ spawner: s.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 5000, killGraceMs: 50 });
  assert.ok(!out.stdout.includes('secret later text'));
});

// ---- timeouts, scrubbing ---------------------------------------------------------------------------
test('timeout: SIGTERM at the limit, SIGKILL after the grace period, timedOut reported', async () => {
  const s = stub({ lines: [goodInit()], hang: true, ignoreTerm: true });
  const t0 = Date.now();
  const out = await runInvocation({ spawner: s.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 40, killGraceMs: 40 });
  assert.equal(out.timedOut, true);
  assert.deepEqual(s.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - t0 < 3000);
});

test('timeout: a child that exits on SIGTERM is not sent SIGKILL', async () => {
  const s = stub({ lines: [goodInit()], hang: true });
  const out = await runInvocation({ spawner: s.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 30, killGraceMs: 80 });
  assert.equal(out.timedOut, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(s.calls[0].child.signals, ['SIGTERM']);
});

test('the API key and any sk-ant pattern never appear in stored output', async () => {
  const s = stub({ lines: [goodInit(), L.say(`my key is ${KEY} and sk-ant-other-abcdefghijklmnop`), L.result('x')] });
  const out = await runInvocation({ spawner: s.spawner, claudePath: 'c', args: [], env: {}, cwd: '/fx', prompt: 'p', expect: EXPECT, key: KEY, timeoutMs: 1000, killGraceMs: 50 });
  assert.ok(!out.stdout.includes(KEY) && !out.stdout.includes('sk-ant'));
  assert.ok(out.stdout.includes('[redacted]'));
  assert.equal(scrubText(`a ${KEY} b`, KEY), 'a [redacted] b');
});

test('API key is checked for shape and taken from the environment variable only; claude lookup does not execute anything', () => {
  assert.equal(checkApiKey(KEY), KEY);
  for (const bad of [undefined, '', 'short', 'has space aaaaaaaaaaaaaaaaaaaaaaaa', 'a\nb'.padEnd(30, 'x')]) assert.throws(() => checkApiKey(bad), (e) => e.code === 'api-key');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-find-'));
  try {
    assert.throws(() => resolveClaude(dir), (e) => e.code === 'claude-missing');
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    assert.equal(resolveClaude(`relative:${dir}`), path.join(dir, 'claude'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- usage parser ----------------------------------------------------------------------------------
const resultEvt = (o = {}) => L.result('done', { total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 300 }, modelUsage: { 'model-a': { inputTokens: 60, outputTokens: 30, cacheReadInputTokens: 200, cacheCreationInputTokens: 10, costUSD: 0.3 }, 'model-b': { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 10, costUSD: 0.12 } }, ...o });

test('usage parser reads the plan 4.2 fields from the result event', () => {
  const u = parseUsage(parseTranscript(ndjson([resultEvt()])).events);
  assert.equal(u.ok, true);
  assert.deepEqual(u.missing, []);
  assert.deepEqual({ ...u.usage, byModel: undefined }, { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 20, cacheReadInputTokens: 300, totalCostUsd: 0.42, byModel: undefined });
  assert.equal(u.usage.byModel['model-a'].cacheReadInputTokens, 200);
  assert.equal(u.usage.byModel['model-b'].totalCostUsd, 0.12);
});

test('usage parser handles missing fields: zero, listed as missing, never invented; no result means not ok', () => {
  const noCost = parseUsage(parseTranscript(ndjson([{ type: 'result', subtype: 'success', is_error: false, result: 'x' }])).events);
  assert.equal(noCost.ok, false);
  assert.deepEqual(noCost.missing.sort(), ['modelUsage', 'total_cost_usd', 'usage']);
  assert.equal(noCost.usage.totalCostUsd, 0);
  const noModel = parseUsage(parseTranscript(ndjson([resultEvt({ modelUsage: undefined })])).events);
  assert.equal(noModel.ok, true);
  assert.deepEqual(noModel.missing, ['modelUsage']);
  assert.deepEqual(noModel.usage.byModel, {});
  const none = parseUsage(parseTranscript(ndjson([L.say('hi')])).events);
  assert.equal(none.ok, false);
  assert.ok(none.missing.includes('result'));
  const partial = parseUsage(parseTranscript(ndjson([resultEvt({ usage: { input_tokens: 5 }, modelUsage: { 'bad name!': {}, ok: { inputTokens: 'x' } } })])).events);
  assert.equal(partial.usage.inputTokens, 5);
  assert.equal(partial.usage.outputTokens, 0);
  assert.deepEqual(Object.keys(partial.usage.byModel), ['ok']);
  assert.equal(partial.usage.byModel.ok.inputTokens, 0);
  assert.equal(parseUsage(parseTranscript(ndjson([resultEvt({ total_cost_usd: -1 })])).events).ok, false);
});

test('usage: a message-usage sum that is more than 5% larger wins; within 5% the result figure stays; resumes add up', () => {
  const m = (id, n) => ({ type: 'assistant', message: { id, role: 'assistant', model: 'model-a', content: [{ type: 'text', text: 't' }], usage: { input_tokens: n, output_tokens: 0 } } });
  const small = parseUsage(parseTranscript(ndjson([m('m1', 1000), resultEvt()])).events);
  assert.equal(small.reconciled, 'message-sum-larger');
  assert.equal(small.usage.inputTokens, 1000);
  const dup = parseUsage(parseTranscript(ndjson([m('m1', 400), m('m1', 400), resultEvt()])).events);
  assert.equal(dup.usage.inputTokens, 100, 'de-duplicated by message id: 400 vs 470 total, within bounds is not larger');
  const total = reconcile(addUsage(parseUsage(parseTranscript(ndjson([resultEvt()])).events).usage, parseUsage(parseTranscript(ndjson([resultEvt()])).events).usage), []);
  assert.equal(total.totalCostUsd, 0.84);
  assert.equal(total.inputTokens, 200);
  assert.equal(total.byModel['model-a'].inputTokens, 120);
});

// ---- whole session with a stub spawner ------------------------------------------------------------
const SHA = resolveRefSha(REPO, 'HEAD');
const approvalFor = (resultsDir, over = {}) => ({ approvalId: 'pilot-1', maxSessions: 6, maxUsdPerSession: 5, maxUsdTotal: 20, coordinatorModel: 'sonnet', configRef: 'main', resultsDir, ...over });
const tmpResults = () => fs.mkdtempSync(path.join(os.tmpdir(), 'results-test-'));

/** Script for a stub session: builds an init event that matches the real invocation (cwd, agents file). */
const session = (body, { cost = 0.5 } = {}) => ({ args, opts }) => {
  const agents = Object.keys(JSON.parse(fs.readFileSync(args[args.indexOf('--agents') + 1], 'utf8')));
  return fakeChild({ lines: [goodInit({ cwd: fs.realpathSync(opts.cwd), agents, tools: ['Bash', 'Read', 'Agent'] }), ...body, L.result(body.filter((e) => e.type === 'assistant' && e.message.content?.[0]?.type === 'text').map((e) => e.message.content[0].text).pop() ?? 'none', { total_cost_usd: cost })] });
};

test('runSession (G3, stop mode): stub spawner, run.json in the B6 schema, stopReason stop-mode, ledger finished, fixture removed', async () => {
  const dir = tmpResults();
  try {
    const s = stub(session([L.agent('a1', 'product-analyst'), L.res('a1', 'Questions only.\n\nHandoff\n- what was done: draft\n- next role: owner'), L.say('Which search do you mean?')]));
    const approval = approvalFor(dir);
    const o = await runSession({ approval, configSha: SHA, resultsDir: dir, mission: MISSIONS.G3, repeat: 1, repoRoot: REPO, spawner: s.spawner, claudePath: '/bin/stub', apiKey: KEY, timeoutMs: 10000, killGraceMs: 50 });
    assert.equal(o.stopReason, 'stop-mode');
    assert.equal(o.usageOk, true);
    assert.equal(o.isolationFailed, false);
    assert.equal(s.calls.length, 1, 'stop mode never resumes');
    assert.equal(s.calls[0].opts.env[KEY_ENV], KEY);
    assert.ok(!Object.keys(s.calls[0].opts.env).some((k) => /^ANTHROPIC_/.test(k)));
    assert.ok(!s.calls[0].args.includes(KEY));
    assert.match(s.calls[0].child.stdinData, /Make search better/);
    const [run] = loadResults([dir]); // strict B6 validation
    assert.equal(run.mission, 'G3');
    assert.equal(run.stopReason, 'stop-mode');
    assert.equal(run.configSha, SHA);
    assert.equal(run.usage.totalCostUsd, 0.5);
    assert.equal(run.launchProfile, 'pilot-a1');
    assert.equal(run.ceilingHit, false);
    const l = readLedger(dir, 'pilot-1');
    assert.deepEqual(l.sessions.map((x) => [x.slot, x.status, x.costUsd]), [['G3/1', 'finished', 0.5]]);
    assert.ok(!fs.readFileSync(path.join(dir, 'G3-1', 'stream.ndjson'), 'utf8').includes(KEY));
    const text = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('team-tests-G3-1'));
    assert.deepEqual(text, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSession: a spawner that throws is a crash; the ledger still counts it and the error surfaces', async () => {
  const dir = tmpResults();
  try {
    const approval = approvalFor(dir);
    const spawner = () => { throw new Error('spawn exploded'); };
    await assert.rejects(() => runSession({ approval, configSha: SHA, resultsDir: dir, mission: MISSIONS.G3, repeat: 1, repoRoot: REPO, spawner, claudePath: '/bin/stub', apiKey: KEY }), /spawn exploded/);
    const l = readLedger(dir, 'pilot-1');
    assert.deepEqual(l.sessions.map((x) => [x.slot, x.status]), [['G3/1', 'crashed']]);
    await assert.rejects(() => runSession({ approval, configSha: SHA, resultsDir: dir, mission: MISSIONS.G3, repeat: 1, repoRoot: REPO, spawner, claudePath: '/bin/stub', apiKey: KEY }), (e) => e.code === 'slot-used');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSession: the ledger entry exists before the child is spawned', async () => {
  const dir = tmpResults();
  try {
    let seen = null;
    const spawner = () => { seen = readLedger(dir, 'pilot-1').sessions.map((x) => x.status); throw new Error('stop here'); };
    await assert.rejects(() => runSession({ approval: approvalFor(dir), configSha: SHA, resultsDir: dir, mission: MISSIONS.G3, repeat: 2, repoRoot: REPO, spawner, claudePath: '/bin/stub', apiKey: KEY }));
    assert.deepEqual(seen, ['started']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSession: a forbidden init field kills the child and marks isolation failed; nothing else runs', async () => {
  const dir = tmpResults();
  try {
    const s = stub(({ args, opts }) => fakeChild({ lines: [goodInit({ cwd: fs.realpathSync(opts.cwd), mcp_servers: [{ name: 'x' }] }), L.say('x')], hang: true }));
    const o = await runSession({ approval: approvalFor(dir), configSha: SHA, resultsDir: dir, mission: MISSIONS.G3, repeat: 1, repoRoot: REPO, spawner: s.spawner, claudePath: '/bin/stub', apiKey: KEY, timeoutMs: 10000, killGraceMs: 50 });
    assert.equal(o.isolationFailed, true);
    assert.equal(o.stopReason, 'error');
    assert.equal(o.usageOk, false);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].child.signals[0], 'SIGTERM');
    assert.equal(readLedger(dir, 'pilot-1').sessions[0].status, 'finished');
    assert.equal(readLedger(dir, 'pilot-1').sessions[0].costUsd, null, 'unreadable cost counts at the per-session cap');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSession: timeout is recorded as stopReason timeout with ceilingHit', async () => {
  const dir = tmpResults();
  try {
    const s = stub(({ args, opts }) => fakeChild({ lines: [goodInit({ cwd: fs.realpathSync(opts.cwd), agents: Object.keys(JSON.parse(fs.readFileSync(args[args.indexOf('--agents') + 1], 'utf8'))) })], hang: true }));
    const o = await runSession({ approval: approvalFor(dir), configSha: SHA, resultsDir: dir, mission: MISSIONS.G3, repeat: 1, repoRoot: REPO, spawner: s.spawner, claudePath: '/bin/stub', apiKey: KEY, timeoutMs: 40, killGraceMs: 40 });
    assert.equal(o.stopReason, 'timeout');
    assert.equal(o.ceilingHit, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSession: budget stop. Reported cost at the per-session cap ends the session with stopReason budget', async () => {
  const dir = tmpResults();
  try {
    const s = stub(session([L.say('Is this in scope?')], { cost: 5 }));
    const o = await runSession({ approval: approvalFor(dir), configSha: SHA, resultsDir: dir, mission: MISSIONS.G1, repeat: 1, repoRoot: REPO, spawner: s.spawner, claudePath: '/bin/stub', apiKey: KEY, timeoutMs: 10000, killGraceMs: 50 });
    assert.equal(o.stopReason, 'budget');
    assert.equal(o.ceilingHit, true);
    assert.equal(s.calls.length, 1, 'no resume past the cap');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSession (answer mode): scripted owner resumes with --resume, the remaining budget shrinks, devStarted and scopeSent come from the transcript', async () => {
  const dir = tmpResults();
  try {
    const mission = { ...MISSIONS.G1, scopeRequest: { when: 'first-stop-after-dev', text: 'Please also add a short usage line to the README.' } };
    const asks = (text) => session([L.agent('d1', 'developer'), L.res('d1', 'implemented'), L.say(text)], { cost: 1 });
    const s = stub(asks('Gate 1: is this requirement note in scope for you?'), asks('Is the requirement still in scope for you?'), session([L.say('All done.')], { cost: 1 }));
    const o = await runSession({ approval: approvalFor(dir), configSha: SHA, resultsDir: dir, mission, repeat: 1, repoRoot: REPO, spawner: s.spawner, claudePath: '/bin/stub', apiKey: KEY, timeoutMs: 10000, killGraceMs: 50 });
    assert.equal(s.calls.length, 3);
    assert.ok(!s.calls[0].args.includes('--resume'));
    for (const c of s.calls.slice(1)) assert.equal(c.args[c.args.indexOf('--resume') + 1], s.calls[0].args[s.calls[0].args.indexOf('--session-id') + 1]);
    const budgets = s.calls.map((c) => c.args[c.args.indexOf('--max-budget-usd') + 1]);
    assert.deepEqual(budgets, ['5.00', '4.00', '3.00']);
    assert.match(s.calls[1].child.stdinData, /short usage line/, 'scope request sent once developer started');
    assert.equal(o.stopReason, 'completed');
    assert.equal(o.costUsd, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launchAll: stops after a session that fails isolation; later slots stay unused; missing key is refused before any spawn', async () => {
  const dir = tmpResults();
  try {
    const approval = approvalFor(dir, { runSet: [{ mission: 'G3', repeats: 2 }] });
    const plan = { approval, resultsDir: dir, createResultsDir: false, configSha: SHA, todo: [{ mission: 'G3', repeat: 1, slot: 'G3/1' }, { mission: 'G3', repeat: 2, slot: 'G3/2' }] };
    const s = stub(({ opts }) => fakeChild({ lines: [goodInit({ cwd: fs.realpathSync(opts.cwd), model: 'opus' })], hang: true }));
    await assert.rejects(() => launchAll({ plan, repoRoot: REPO, env: {}, spawner: s.spawner, claudePath: '/bin/stub' }), (e) => e.code === 'api-key');
    assert.equal(s.calls.length, 0);
    const r = await launchAll({ plan, repoRoot: REPO, env: { TEAM_TESTS_API_KEY: KEY }, spawner: s.spawner, claudePath: '/bin/stub', timeoutMs: 10000, killGraceMs: 50 });
    assert.equal(r.stopped, 'isolation-failed');
    assert.equal(r.outcomes.length, 1);
    assert.deepEqual(readLedger(dir, 'pilot-1').sessions.map((x) => x.slot), ['G3/1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launchAll stops when the ledger refuses the next session (cost cap)', async () => {
  const dir = tmpResults();
  try {
    const approval = approvalFor(dir, { runSet: [{ mission: 'G3', repeats: 2 }], maxUsdTotal: 6 });
    reserveSession(dir, approval, 'G1/1'); // an unfinished session counts at the per-session cap (5)
    const plan = { approval, resultsDir: dir, createResultsDir: false, configSha: SHA, todo: [{ mission: 'G3', repeat: 1, slot: 'G3/1' }] };
    const s = stub({ lines: [] });
    const r = await launchAll({ plan, repoRoot: REPO, env: { TEAM_TESTS_API_KEY: KEY }, spawner: s.spawner, claudePath: '/bin/stub' });
    assert.equal(r.stopped, 'max-usd-total');
    assert.equal(s.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- static scans ---------------------------------------------------------------------------------
test('static: only launch.mjs spawns, only through spawn with an args array; no shell option, exec or execSync anywhere under src/', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of walk(path.join(ROOT, 'src')).filter((x) => x.endsWith('.mjs'))) {
    const c = strip(fs.readFileSync(f, 'utf8'));
    assert.ok(!/(?<![.\w])(exec|execSync|execFile|execFileSync)\s*\(/.test(c), `${path.relative(ROOT, f)} uses exec`);
    assert.ok(!/shell\s*:\s*true/.test(c), `${path.relative(ROOT, f)} enables a shell`);
    if (!f.endsWith(`${path.sep}launch.mjs`)) assert.ok(!/\bspawn\s*\(/.test(c) || /shims/.test(f), `${path.relative(ROOT, f)} spawns`);
  }
});
