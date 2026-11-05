// The only module that spawns `claude`. Imported only by src/runcmd.mjs, after the guard passed
// (plan 3.9). Never imported by the dry run or by any test that does not inject a stub spawner.
//
// Isolation (plan 5): launch profile with no permission bypass, a generated settings file, an empty
// strict MCP config, a constructed environment (src/env.mjs), a fake HOME, the init-event guard, a
// wall-clock timeout per invocation, and a session ledger entry written BEFORE the child starts.
// Arguments are always an array and `shell` is never used.
//
// API key (plan 5.4): the harness never reads, holds or logs the key, and the child environment
// never contains one. The nested CLI gets it through `apiKeyHelper` in the generated settings, an
// absolute `/usr/bin/security` call naming the owner's keychain item and keychain file (computed at
// run time, written only into <scratch>/out/settings.json). The harness never runs `security`.
// Residual risk: same-user Bash could call `/usr/bin/security` by absolute path; `security` is denied
// and shimmed, the transcript checker flags `sk-ant-`, and the key's spend limit and revocation bound it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createFixture, destroyFixture } from './fixture.mjs';
import { loadAll } from './missions.mjs';
import { parseTranscript, parseTranscripts } from './transcript.mjs';
import { evaluate } from './checkers/index.mjs';
import { snapshotRepo } from './checkers/isolation.mjs';
import { decide } from './owner.mjs';
import { validateRun } from './results.mjs';
import { parseUsage, addUsage, reconcile } from './usage.mjs';
import { checkInit } from './initguard.mjs';
import { reserveSession, finishSession, checkLedger, readLedger } from './ledger.mjs';
import { GuardRefusal } from './refusal.mjs';
import { resolveRefSha } from './guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(HERE, '..', 'config');
export const DEFAULT_KEYCHAIN_SERVICE = 'team-tests-pilot-key';
const SERVICE = /^[A-Za-z0-9._-]{1,64}$/;
export const FORBIDDEN_ARGS = Object.freeze(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--permission-mode', '--chrome', '--ide', '--remote-control', '--plugin-url']);
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const SHORT = /^[A-Za-z0-9._+-]{1,64}$/;

// ---- profile and settings ---------------------------------------------------------------------
export function assertNoForbidden(value, what) {
  const text = JSON.stringify(value);
  for (const f of FORBIDDEN_ARGS) if (text.includes(f)) throw new Error(`${what} contains a forbidden option`);
}

export function loadProfile(file = path.join(CONFIG, 'launch-profile.json')) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertNoForbidden(p, 'launch profile');
  return p;
}

export function loadNestedSettings(file = path.join(CONFIG, 'nested-settings.json')) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertNoForbidden(s, 'nested settings');
  return s;
}

/** Settings written to <scratch>/out/settings.json: nested-settings.json plus the apiKeyHelper. */
export function keychainPathFor(home = os.homedir()) {
  return path.join(home, 'Library', 'Keychains', 'login.keychain-db'); // string only; never opened
}

export function apiKeyHelperCommand({ keychainService = DEFAULT_KEYCHAIN_SERVICE, keychainPath = keychainPathFor() } = {}) {
  if (typeof keychainService !== 'string' || !SERVICE.test(keychainService)) throw new GuardRefusal('keychain-service', 'keychain service name is not valid');
  if (typeof keychainPath !== 'string' || !path.isAbsolute(keychainPath) || /['\0\n\r]/.test(keychainPath)) throw new GuardRefusal('keychain-path', 'keychain path is not usable');
  return `/usr/bin/security find-generic-password -s ${keychainService} -w '${keychainPath}'`;
}

export function buildSettings(nested, helper = {}) {
  const { note, ...rest } = nested; void note;
  return { ...rest, apiKeyHelper: apiKeyHelperCommand(helper) };
}

// ---- agents and prompts -----------------------------------------------------------------------
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const k = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (k) meta[k[1]] = k[2].trim();
  }
  return { meta, body: m[2] };
}

export function parseAgentFile(text) {
  const { meta, body } = frontmatter(text);
  if (!meta.name || !/^[A-Za-z0-9-]{1,64}$/.test(meta.name)) throw new Error('agent file has no valid name');
  const out = { description: meta.description ?? '', prompt: body.trim() };
  if (meta.tools) out.tools = meta.tools.split(',').map((t) => t.trim()).filter(Boolean);
  if (meta.model) out.model = meta.model;
  return { name: meta.name, def: out };
}

/** Agents from the fixture's .claude/agents/*.md, keyed by name (the --agents file content). */
export function buildAgents(fixtureDir) {
  const dir = path.join(fixtureDir, '.claude', 'agents');
  const agents = {};
  if (!fs.existsSync(dir)) return agents;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const { name, def } = parseAgentFile(fs.readFileSync(path.join(dir, f), 'utf8'));
    agents[name] = def;
  }
  return agents;
}

/** run-team.md body (front matter removed) with $ARGUMENTS replaced; no regex replacement patterns. */
export function buildPrompt(runTeamText, missionPrompt) {
  const { body } = frontmatter(runTeamText);
  return body.split('$ARGUMENTS').join(missionPrompt).trim();
}

// ---- argument building (an array, never a shell string) ---------------------------------------
export function buildArgs({ profile, settingsPath, agentsPath, systemPrompt, model, maxBudgetUsd, sessionId, resumeId = null }) {
  if (!(typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0 && Number.isFinite(maxBudgetUsd))) throw new Error('buildArgs: maxBudgetUsd must be positive');
  const id = resumeId ?? sessionId;
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw new Error('buildArgs: bad session id');
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(model)) throw new Error('buildArgs: bad model');
  const args = [
    ...profile.flags,
    ...Object.entries(profile.valueFlags).flat(),
    '--tools', [...profile.tools, profile.agentTool].join(','),
    '--settings', settingsPath,
    '--agents', agentsPath,
    '--mcp-config', profile.mcpConfig,
    '--append-system-prompt', systemPrompt,
    '--model', model,
    '--max-budget-usd', maxBudgetUsd.toFixed(2),
    ...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]),
  ];
  // The prompt itself goes to stdin (see runInvocation), so no variadic flag can swallow it.
  assertNoForbidden(args.filter((a) => a !== systemPrompt), 'launch arguments');
  if (!args.every((a) => typeof a === 'string')) throw new Error('buildArgs: non-string argument');
  return args;
}

// ---- secrets ----------------------------------------------------------------------------------
// A key the agent printed is replaced in the stored stream; the number of replacements is counted
// (before scrubbing) and reaches the checkers as run.secretRedactions, so the finding survives the scrub.
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]+/g;
export function scrubText(text) {
  return String(text).replace(KEY_SHAPE, '[redacted]');
}
/** Number of key-shaped strings in `text` (detect BEFORE scrubbing; never returns the value). */
export function countKeyShapes(text) {
  return (String(text).match(KEY_SHAPE) ?? []).length;
}

/** Finds `claude` on the given PATH without running it. */
export function resolveClaude(searchPath = process.env.PATH ?? '') {
  for (const dir of searchPath.split(':').filter((d) => path.isAbsolute(d))) {
    const f = path.join(dir, 'claude');
    try {
      if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return f; }
    } catch { /* keep looking */ }
  }
  throw new GuardRefusal('claude-missing', 'claude was not found on PATH');
}

// ---- one invocation ---------------------------------------------------------------------------
// detached: the child leads its own process group, so a timeout can signal the whole tree (Sec F5).
const defaultSpawner = (cmd, args, opts) => spawn(cmd, args, { ...opts, shell: false, detached: true });

// Group signalling is used only for children the default spawner made: a stub's pid is not a group.
function signal(child, sig, group) {
  if (group && Number.isInteger(child.pid) && child.pid > 1) {
    try { process.kill(-child.pid, sig); return; } catch { /* group gone: fall through to the child */ }
  }
  try { child.kill(sig); } catch { /* already gone */ }
}
function killTree(child, graceMs, timers, group) {
  signal(child, 'SIGTERM', group);
  timers.push(setTimeout(() => signal(child, 'SIGKILL', group), graceMs));
}

/**
 * Spawns the child with an args array, writes the prompt to stdin, reads the stream as it arrives and
 * applies the init-event guard to the first `system`/`init` event (kills on any problem, and when a
 * `result` arrives or the process ends with no init). Enforces the wall-clock timeout.
 * Resolves { stdout, exitCode, signal, timedOut, initProblems, init, truncated }.
 */
export function runInvocation({ spawner = defaultSpawner, claudePath, args, env, cwd, prompt, expect, timeoutMs, killGraceMs }) {
  if (!Array.isArray(args)) throw new Error('runInvocation: args must be an array');
  const group = spawner === defaultSpawner;
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawner(claudePath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); } catch (e) { reject(e); return; }
    const timers = [];
    const chunks = [];
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let buf = '';
    let init = null;
    let initProblems = null;
    let timedOut = false;
    let truncated = false;
    let killed = false;
    let redactions = 0;
    const kill = () => { if (!killed) { killed = true; killTree(child, killGraceMs, timers, group); } };
    timers.push(setTimeout(() => { timedOut = true; kill(); }, timeoutMs));

    // One COMPLETE line at a time: detect key shapes in the raw line, store only the scrubbed line, and
    // run the init guard on it. A key can no longer straddle a chunk boundary (Sec F2, F3).
    const handleLine = (rawLine) => {
      if (initProblems) return;
      redactions += countKeyShapes(rawLine);
      const line = scrubText(rawLine);
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MAX_STREAM_BYTES) { truncated = true; kill(); return; }
      chunks.push(`${line}\n`);
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
      if (obj.type === 'system' && obj.subtype === 'init' && init === null) {
        init = obj;
        const problems = checkInit(obj, expect);
        if (problems.length) { initProblems = problems; kill(); }
      } else if (init === null) {
        // Plan 5.5, fail closed: the first parseable event must be the init event (Sec F6).
        initProblems = ['init-event-missing'];
        kill();
      }
    };
    const feed = (text) => {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); handleLine(l); if (initProblems || truncated) { buf = ''; return; } }
      if (Buffer.byteLength(buf) > MAX_STREAM_BYTES) { truncated = true; buf = ''; kill(); }
    };
    child.stdout.on('data', (d) => { if (!initProblems && !truncated) feed(decoder.write(d)); });
    child.stderr?.on('data', () => { /* never stored: may carry paths or secrets */ });
    child.stdin?.on('error', () => { /* child may exit before reading */ });
    child.on('error', (e) => { timers.forEach(clearTimeout); reject(e); });
    child.on('close', (exitCode, sig) => {
      timers.forEach(clearTimeout);
      if (group) signal(child, 'SIGKILL', true); // anything the child left running in its group
      if (!initProblems && !truncated) { feed(decoder.end()); if (buf.length) { const l = buf; buf = ''; handleLine(l); } }
      if (init === null && !initProblems) initProblems = ['init-event-missing'];
      resolve({ stdout: chunks.join(''), exitCode, signal: sig, timedOut, initProblems, init, truncated, redactions });
    });
    child.stdin?.end(prompt);
  });
}

// ---- one session ------------------------------------------------------------------------------
const gitHead = (repoRoot) => resolveRefSha(repoRoot, 'HEAD');
const readOr = (f, d = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };

// Events from the session JSONL files (main and subagent transcripts) that the stream did not carry,
// for the safety checkers (Sec F10). Duplicates of stream events (same tool call id, or same text)
// are dropped. Usage and result events stay with the cost reconciliation.
const EXTRA_TYPES = new Set(['tool_use', 'agent', 'tool_result', 'agent_result', 'assistant_text', 'user_text']);
export function extraSafetyEvents(streamEvents, jsonlEvents) {
  const sig = (e) => (e.toolUseId ? `${e.type}:${e.toolUseId}` : `${e.type}:${e.name ?? ''}:${JSON.stringify(e.input ?? '')}:${e.text ?? ''}`); // no id: the input is part of the key (Sec R2-4)
  const seen = new Set(streamEvents.map(sig));
  const out = [];
  for (const e of jsonlEvents) {
    if (!EXTRA_TYPES.has(e.type) || seen.has(sig(e))) continue;
    seen.add(sig(e));
    out.push(e);
  }
  out.forEach((e, k) => { e.i = streamEvents.length + k; });
  return out;
}

function sessionJsonl(homeDir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6 || out.length >= 50) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && fs.statSync(p).size <= 20 * 1024 * 1024) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  try { walk(path.join(homeDir, '.claude'), 0); } catch { /* none written */ }
  return out;
}

/**
 * Runs one session (mission + repeat). The ledger entry is written before the fixture exists, so any
 * crash still counts. Returns an outcome summary; throws only after marking the ledger `crashed`.
 */
export async function runSession({ approval, configSha, resultsDir, mission, repeat, repoRoot, spawner, claudePath, keychainService, keychainPath, profile = loadProfile(), nested = loadNestedSettings(), timeoutMs, killGraceMs, createFx = createFixture, destroyFx = destroyFixture }) {
  const slot = `${mission.id}/${repeat}`;
  reserveSession(resultsDir, approval, slot);
  const t0 = Date.now();
  let fx = null;
  try {
    const runId = `${mission.id}-${repeat}`;
    fx = createFx({ runId, repoRoot, ref: configSha, variant: mission.variant });
    const agents = buildAgents(fx.fixtureDir);
    const settingsPath = path.join(fx.outDir, 'settings.json');
    const agentsPath = path.join(fx.outDir, 'agents.json');
    fs.writeFileSync(settingsPath, JSON.stringify(buildSettings(nested, { keychainService, keychainPath })), { mode: 0o600 });
    fs.writeFileSync(agentsPath, JSON.stringify(agents), { mode: 0o600 });
    const systemPrompt = readOr(path.join(fx.fixtureDir, 'CLAUDE.md'));
    const firstPrompt = buildPrompt(readOr(path.join(fx.fixtureDir, '.claude', 'commands', 'run-team.md')), mission.prompt);
    const env = { ...fx.env }; // allowlisted child env only; no key variable
    const expect = { cwd: fs.realpathSync(fx.fixtureDir), allowedTools: [...profile.tools, ...profile.initAgentToolNames], allowedModes: profile.allowedPermissionModes, apiKeySource: profile.apiKeySource, model: approval.coordinatorModel, agents: Object.keys(agents) };
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const before = snapshotRepo(repoRoot, { projectsDir });

    const sessionId = crypto.randomUUID();
    const state = { resumesUsed: 0, devStarted: false, scopeSent: false };
    const raw = [];
    const blocks = [];
    const events = [];
    let redactions = 0;
    let spent = 0;
    let usageOk = true;
    let isolationFailed = false;
    let ceilingHit = false;
    let stopReason = 'error';
    let cliVersion = 'unknown';
    let prompt = firstPrompt;
    for (let n = 0; ; n++) {
      const remaining = approval.maxUsdPerSession - spent;
      if (remaining < 0.01) { stopReason = 'budget'; ceilingHit = true; break; }
      const args = buildArgs({ profile, settingsPath, agentsPath, systemPrompt, model: approval.coordinatorModel, maxBudgetUsd: remaining, sessionId, resumeId: n === 0 ? null : sessionId });
      const inv = await runInvocation({ spawner, claudePath, args, env, cwd: fx.fixtureDir, prompt: prompt.startsWith('-') ? `Owner: ${prompt}` : prompt, expect, timeoutMs: timeoutMs ?? profile.invocationTimeoutMs, killGraceMs: killGraceMs ?? profile.killGraceMs });
      raw.push(inv.stdout);
      redactions += inv.redactions ?? 0;
      const parsed = parseTranscript(inv.stdout);
      events.push(...parsed.events);
      if (typeof inv.init?.claude_code_version === 'string' && SHORT.test(inv.init.claude_code_version)) cliVersion = inv.init.claude_code_version;
      const u = parseUsage(parsed.events);
      blocks.push(u.usage);
      if (!u.ok) usageOk = false;
      spent += u.ok ? u.usage.totalCostUsd : approval.maxUsdPerSession;
      if (inv.initProblems) { isolationFailed = true; stopReason = 'error'; break; }
      if (inv.timedOut) { stopReason = 'timeout'; ceilingHit = true; break; }
      const result = [...parsed.events].reverse().find((e) => e.type === 'result');
      if (!result || !u.ok) { stopReason = 'error'; break; }
      if (/budget/i.test(result.subtype ?? '') || spent >= approval.maxUsdPerSession) { stopReason = 'budget'; ceilingHit = true; break; }
      if (inv.exitCode !== 0 || result.isError) { stopReason = 'error'; break; }
      state.devStarted = events.some((e) => e.type === 'agent' && e.name === 'developer');
      const lastText = result.text || [...parsed.events].reverse().find((e) => e.type === 'assistant_text')?.text || '';
      const d = decide({ text: lastText }, mission, state);
      if (d.action !== 'reply') { stopReason = d.stopReason; break; }
      state.resumesUsed += 1;
      if (d.scopeSent) state.scopeSent = true;
      prompt = d.reply;
    }

    const jsonlTexts = sessionJsonl(fx.homeDir);
    const extra = parseTranscripts(jsonlTexts).events;
    const extraEvents = extraSafetyEvents(events, extra);
    const usage = reconcile(addUsage(...blocks), [...events, ...extra]);
    const after = snapshotRepo(repoRoot, { projectsDir });
    const ev = evaluate({
      mission, fixtureDir: fx.fixtureDir, scratch: fx.scratch, baseSha: fx.baseSha, baseline: fx.baseline,
      canaries: fx.canaries, env: fx.env, events, extraEvents, secretRedactions: redactions, badLines: 0, rawTranscripts: [...raw, ...jsonlTexts],
      logs: { fakeprod: readOr(path.join(fx.logDir, 'fakeprod.log')), shim: readOr(path.join(fx.logDir, 'shim.log')) },
      outDir: fx.outDir, isolation: { before, after }, testTimeoutMs: 120000,
    });
    const ref = SHORT.test(approval.configRef) ? approval.configRef : configSha.slice(0, 12);
    const record = validateRun({
      runId, mission: mission.id, repeat, configRef: ref, configSha, harnessSha: gitHead(repoRoot) ?? configSha,
      cliVersion, launchProfile: profile.id, models: Object.keys(usage.byModel).length ? Object.keys(usage.byModel) : [approval.coordinatorModel],
      stopReason, criteria: ev.results.map((r) => ({ id: r.id, kind: r.kind, category: r.category, status: r.status, pass: r.pass })),
      usage, wallMs: Date.now() - t0, ceilingHit,
    });
    const dir = path.join(resultsDir, runId);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'stream.ndjson'), raw.join(''), { mode: 0o600, flag: 'wx' });
    finishSession(resultsDir, approval, slot, { status: 'finished', costUsd: usageOk ? usage.totalCostUsd : null });
    const safetyFailed = record.criteria.some((c) => c.category === 'safety' && c.kind === 'M' && c.status !== 'passed');
    return { runId, mission: mission.id, repeat, stopReason, usageOk, isolationFailed, safetyFailed, costUsd: usage.totalCostUsd, ceilingHit };
  } catch (err) {
    try { finishSession(resultsDir, approval, slot, { status: 'crashed', costUsd: null }); } catch { /* ledger keeps `started`, which also counts */ }
    throw err;
  } finally {
    if (fx) { try { destroyFx(fx); } catch { /* scratch is under tmpdir; safeRm refusal leaves it for the owner */ } }
  }
}

/** Runs the remaining sessions of a checked plan in order. Stops at the first stop-rule trigger. */
export async function launchAll({ plan, repoRoot, env = process.env, spawner, claudePath, keychainService = DEFAULT_KEYCHAIN_SERVICE, keychainPath = keychainPathFor(), timeoutMs, killGraceMs, log = () => {} }) {
  apiKeyHelperCommand({ keychainService, keychainPath }); // validate before anything starts
  const exe = claudePath ?? resolveClaude(env.PATH);
  if (plan.createResultsDir) fs.mkdirSync(plan.resultsDir, { mode: 0o700 });
  const missions = loadAll();
  const outcomes = [];
  let stopped = null;
  for (const s of plan.todo) {
    try { checkLedger(readLedger(plan.resultsDir, plan.approval.approvalId), plan.approval, 1); } catch (e) { stopped = e.code ?? 'refused'; break; }
    const o = await runSession({ approval: plan.approval, configSha: plan.configSha, resultsDir: plan.resultsDir, mission: missions[s.mission], repeat: s.repeat, repoRoot, spawner, claudePath: exe, keychainService, keychainPath, timeoutMs, killGraceMs });
    outcomes.push(o);
    log(o);
    if (o.isolationFailed || o.safetyFailed || !o.usageOk) { stopped = o.isolationFailed ? 'isolation-failed' : o.safetyFailed ? 'safety-failure' : 'usage-unreadable'; break; }
  }
  return { outcomes, stopped };
}
