// Detached background worker. It asks the model about a request the pre-filter left undecided and appends
// the answer to the log. Its stdout/stderr go nowhere and the hook has already answered, so nothing it
// does can reach Claude Code. The answer is advisory and is never used for a decision.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { loadInstall } from '../config.mjs';
import { sha256, isPlainObject } from '../util.mjs';
import { appendRecord, redact } from '../log.mjs';
import { readKey } from './keychain.mjs';
import { askModel, buildPrompt, buildBody, estimateCostUsd, costFromUsage, httpsTransport } from './client.mjs';
import { dailySpend, addSpend, acquireLock, releaseLock, breakerOpen, recordOutcome } from './budget.mjs';

export const MAX_WORKER_INPUT = 64 * 1024;

function validConfig(m) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return isPlainObject(m) && m.enabled === true && typeof m.name === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(m.name)
    && Number.isInteger(m.max_tokens) && m.max_tokens > 0 && m.max_tokens <= 1000 && num(m.per_call_cap_usd) && num(m.daily_cap_usd) && num(m.timeout_ms)
    && isPlainObject(m.prices) && num(m.prices.input_per_mtok) && num(m.prices.output_per_mtok);
}

function validRequest(r) {
  return isPlainObject(r) && ['record_id', 'tool', 'command_or_path', 'cwd'].every((k) => typeof r[k] === 'string') && (r.branch === null || typeof r.branch === 'string');
}

export async function runWorker({ input, installDir, now = Date.now, deps = {} }) {
  const t0 = now();
  const d = { readKey, transport: httpsTransport, appendRecord, ...deps };
  const inst = loadInstall(installDir);
  if (!inst.ok) return null;
  const install = inst.install; const logDir = install.log_dir;
  let request; try { request = typeof input === 'string' ? JSON.parse(input) : input; } catch { request = null; }
  if (!validRequest(request)) return null;
  const model = install.model;
  const base = { type: 'model', ts: new Date(now()).toISOString(), record_id: request.record_id, session_id: typeof request.session_id === 'string' ? request.session_id : null, model: null, model_decision: null, model_reason: null, latency_ms: null, model_cost_usd: null, skipped: null, error: null };
  const finish = (extra) => {
    const rec = { ...base, ...extra, latency_ms: now() - t0 };
    try { d.appendRecord(logDir, rec); } catch { /* nothing else to do */ }
    return rec;
  };
  if (!validConfig(model)) return finish({ skipped: 'bad_config' });
  base.model = model.name;

  let policyMd;
  try {
    const buf = fs.readFileSync(path.join(installDir, 'policy.md'));
    if (sha256(buf) !== install.files['policy.md']) return finish({ skipped: 'policy_checksum_mismatch' });
    policyMd = buf.toString('utf8');
  } catch { return finish({ skipped: 'policy_missing' }); }

  const breakerCfg = isPlainObject(model.breaker) ? model.breaker : {};
  try {
    if (breakerOpen(logDir, now())) return finish({ skipped: 'breaker_open' });
    if (dailySpend(logDir, now()) >= model.daily_cap_usd) return finish({ skipped: 'daily_cap' });
    const { system, user } = buildPrompt({ policyMd, request: { tool: request.tool, command_or_path: redact(request.command_or_path), cwd: request.cwd, branch: request.branch } });
    if (estimateCostUsd({ system, user, maxTokens: model.max_tokens }, model.prices) > model.per_call_cap_usd) return finish({ skipped: 'per_call_cap' });
    if (!acquireLock(logDir, now())) return finish({ skipped: 'busy' });
    try {
      const k = await d.readKey({ service: install.keychain?.service, account: install.keychain?.account, execFile: d.execFile });
      if (!k.ok) return finish({ skipped: 'key_unavailable' });
      const r = await askModel({ key: k.key, body: buildBody({ model: model.name, maxTokens: model.max_tokens, system, user }), transport: d.transport, timeoutMs: model.timeout_ms });
      const cost = r.ok ? costFromUsage(r.usage, model.prices) : 0;
      if (cost > 0) addSpend(logDir, now(), cost, request.record_id);
      recordOutcome(logDir, now(), r.ok, breakerCfg);
      if (!r.ok) return finish({ error: r.error });
      return finish({ model_decision: r.decision, model_reason: r.reason, model_cost_usd: cost });
    } finally { releaseLock(logDir); }
  } catch {
    return finish({ error: 'worker_exception' });
  }
}

async function readAll(stream, max) {
  const chunks = []; let size = 0;
  for await (const c of stream) { size += c.length; if (size > max) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

function isEntry() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntry()) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  const installDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const hardStop = setTimeout(() => process.exit(0), 20000); // never linger
  readAll(process.stdin, MAX_WORKER_INPUT)
    .then((text) => (text === null ? null : runWorker({ input: text, installDir })))
    .finally(() => { clearTimeout(hardStop); process.exit(0); });
}
