// PermissionRequest hook entry. Orchestration only: every fallback prints nothing and exits 0
// (that is "ask"). The decision comes from the deterministic pre-filter alone (Q8 b); the model
// never decides. Only hook-io.mjs writes to stdout, once, as the last step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readStdin, outputForMode, writeStdout } from './hook-io.mjs';
import { loadInstall, readMode, loadPolicy, APPROVER_VERSION } from './config.mjs';
import { inScope, readBranch } from './paths.mjs';
import { prefilter as defaultPrefilter } from './prefilter.mjs';
import { appendRecord, summarizeInput } from './log.mjs';
import { sha256, canonicalJson, isPlainObject } from './util.mjs';

export const TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'];
const SILENT = { stdout: '' };

function baseRecord(mode, payload, extra) {
  return {
    ts: new Date().toISOString(),
    record_id: crypto.randomUUID(),
    type: 'decision',
    session_id: typeof payload?.session_id === 'string' ? payload.session_id : null,
    mode,
    tool_name: typeof payload?.tool_name === 'string' ? payload.tool_name.slice(0, 80) : null,
    cwd: typeof payload?.cwd === 'string' ? payload.cwd.slice(0, 500) : null,
    transcript_path: typeof payload?.transcript_path === 'string' ? payload.transcript_path.slice(0, 500) : null,
    permission_mode: typeof payload?.permission_mode === 'string' ? payload.permission_mode.slice(0, 40) : null,
    agent_id: typeof payload?.agent_id === 'string' ? payload.agent_id.slice(0, 80) : undefined,
    agent_type: typeof payload?.agent_type === 'string' ? payload.agent_type.slice(0, 80) : undefined,
    branch: null,
    input_redacted: null,
    input_hash: null,
    input_size: null,
    truncated: false,
    stage: 'prefilter',
    decision: 'ask',
    reason: null,
    rule_id: null,
    undecided: false,
    latency_ms: null,
    model: null,
    model_cost_usd: null,
    error: null,
    policy_version: null,
    approver_version: APPROVER_VERSION,
    observed_outcome: null,
    ...extra,
  };
}

export async function run({ stdin, installDir, deps = {} }) {
  const t0 = performance.now();
  const d = { prefilter: defaultPrefilter, appendRecord, readBranch, home: os.homedir(), ...deps };
  const inst = loadInstall(installDir);
  const logIt = (rec) => {
    if (!inst.ok) return;
    rec.latency_ms = Math.round(performance.now() - t0);
    try { d.appendRecord(inst.install.log_dir, rec); } catch { /* a log failure never changes the flow */ }
  };

  const rd = await readStdin(stdin);
  if (!rd.ok) { logIt(baseRecord('shadow', null, { error: rd.error })); return SILENT; }
  let payload;
  try { payload = JSON.parse(rd.text); } catch { payload = undefined; }
  if (!isPlainObject(payload)) { logIt(baseRecord('shadow', null, { error: 'bad_json', input_size: rd.text.length })); return SILENT; }
  if (!inst.ok) return SILENT;
  const install = inst.install;

  // Scope (Q9): outside this repo the hook is invisible: empty stdout, no log, no model.
  if (typeof payload.cwd === 'string' && !inScope(payload.cwd, install.repo_root)) return SILENT;

  const mode = readMode(installDir);
  const rec = (extra) => baseRecord(mode, payload, extra);
  const shapeOk = payload.hook_event_name === 'PermissionRequest' && typeof payload.tool_name === 'string'
    && isPlainObject(payload.tool_input) && typeof payload.cwd === 'string' && typeof payload.session_id === 'string';
  if (!shapeOk) { logIt(rec({ error: 'bad_shape', rule_id: 'K-SHAPE', reason: 'Unexpected request shape.' })); return SILENT; }

  const pol = loadPolicy(installDir, install);
  if (!pol.ok) {
    logIt(rec({ error: pol.error, rule_id: 'K-POLICY', reason: 'Policy unavailable; everything asks.' }));
    return SILENT;
  }
  const policy_version = pol.policy.policy_version;
  const tool = payload.tool_name;
  const input = payload.tool_input;
  const hash = sha256(canonicalJson(input));
  const common = { policy_version, input_hash: hash, input_size: canonicalJson(input).length };

  if (!TOOLS.includes(tool)) {
    logIt(rec({ ...common, rule_id: 'K-TOOL', reason: 'Tool not covered by the approver.' }));
    return SILENT;
  }

  const branch = d.readBranch(install.repo_root);
  let result;
  try {
    result = d.prefilter({
      tool, input, cwd: payload.cwd, branch,
      ctx: {
        repoRoot: install.repo_root, repoVisibility: install.repo_visibility, home: d.home,
        installDir: install.install_dir, actualInstallDir: installDir, logDir: install.log_dir,
        policy: pol.policy, runGit: d.runGit,
      },
    });
    if (!result || !['allow', 'ask', 'deny'].includes(result.decision)) throw new Error('bad_result');
  } catch {
    result = { decision: 'ask', rule_id: 'K-ERROR', undecided: false, reason: 'Internal error; asking.', error: 'prefilter_exception' };
  }
  const record = rec({
    ...common, branch, decision: result.decision, rule_id: result.rule_id || null,
    undecided: !!result.undecided, reason: result.reason || null, error: result.error || null,
    input_redacted: summarizeInput(tool, input),
  });
  logIt(record);
  return { stdout: outputForMode(mode, result), record };
}

export function defaultInstallDir() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

// Process wrapper. Everything here fails to "empty stdout, exit 0".
export async function main({
  runFn = run, stdin = process.stdin, write = writeStdout, exit = (c) => process.exit(c),
  watchdogMs = 3000, installDir = defaultInstallDir(),
} = {}) {
  let finished = false;
  const timer = setTimeout(() => { if (!finished) { finished = true; exit(0); } }, watchdogMs);
  const finish = async (text) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { if (text) await write(text); } catch { /* nothing else to do */ }
    exit(0);
  };
  try {
    const r = await runFn({ stdin, installDir });
    await finish(r && typeof r.stdout === 'string' ? r.stdout : '');
  } catch {
    await finish('');
  }
}

function isEntry() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntry()) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  main();
}
