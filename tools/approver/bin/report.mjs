#!/usr/bin/env node
// Owner-run, read-only report: what the approver would have done next to what actually happened.
// No network, no model, writes nothing. See docs in tools/approver/README.md.
//
//   node report.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--top 10] [--selfcheck [N]]
//                   [--log-dir <dir>] [--install-dir <dir>] [--home <dir>]
//
// "Observed outcome" is read from the Claude Code session transcript (plan 3.12, flag F1): a record is
// matched to the tool_use with the same tool name and the same input hash, and the result carries the
// permission decision. The transcript format is internal to Claude Code and may change; anything
// unrecognised is reported as `unknown`, never guessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { sha256, canonicalJson, isPlainObject } from '../src/util.mjs';
import { realResolve, isInside } from '../src/paths.mjs';
import { LOG_FILE } from '../src/log.mjs';

const WINDOW_MS = 120000;
const SKEW_MS = 2000;

// ---------- transcript reading ----------
async function readTranscript(file, into) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) {
      if (!into.version && line.includes('"version"')) { try { const j = JSON.parse(line); if (typeof j.version === 'string') into.version = j.version; } catch { /* skip */ } }
      continue;
    }
    let j; try { j = JSON.parse(line); } catch { into.badLines++; continue; }
    if (!isPlainObject(j)) continue;
    if (!into.version && typeof j.version === 'string') into.version = j.version;
    const content = Array.isArray(j.message?.content) ? j.message.content : [];
    const ts = Date.parse(j.timestamp);
    for (const b of content) {
      if (!isPlainObject(b)) continue;
      if (b.type === 'tool_use' && typeof b.id === 'string' && isPlainObject(b.input)) {
        // only these fields are kept: name, a hash of the input, time. Content is never stored.
        into.uses.push({ id: b.id, name: b.name, hash: sha256(canonicalJson(b.input)), ts, cwd: typeof j.cwd === 'string' ? j.cwd : null, sidechain: !!j.isSidechain, entrypoint: j.entrypoint ?? null });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const pd = isPlainObject(j.permissionDecision) ? j.permissionDecision : null;
        into.results.set(b.tool_use_id, {
          is_error: !!b.is_error, decision: pd?.decision ?? null, source: pd?.source ?? null, reasonType: pd?.reasonType ?? null,
          denialKind: typeof j.toolDenialKind === 'string' ? j.toolDenialKind : null, entrypoint: j.entrypoint ?? null, sidechain: !!j.isSidechain,
        });
      }
    }
  }
}

function transcriptFiles(main) {
  const files = [main];
  const subDir = main.replace(/\.jsonl$/, '') + path.sep + 'subagents';
  try { for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f)); } catch { /* none */ }
  return files;
}

export function outcomeOf(use, result) {
  if (use?.entrypoint === 'sdk-cli' || result?.entrypoint === 'sdk-cli') return { outcome: 'unknown', detail: 'non-interactive session (-p): no human answered' };
  if (!result) return { outcome: 'unknown', detail: 'no tool_result (interrupted)' };
  if (result.decision === 'accept') return { outcome: 'ran', detail: /^user_/.test(result.source || '') ? 'owner approved' : `accepted by ${result.source || 'unknown source'}` };
  if (result.decision === 'reject' || result.denialKind) return { outcome: 'not_run', detail: result.denialKind || `rejected by ${result.source || 'unknown source'}` };
  return { outcome: 'unknown', detail: 'format_unrecognized' };
}

// ---------- shapes for the top-asks table ----------
export function shapeOf(rec) {
  const s = String(rec.input_redacted ?? '');
  if (rec.tool_name !== 'Bash') {
    const m = /^(\w+) (\S+)/.exec(s);
    if (!m) return rec.tool_name || '?';
    const p = m[2]; const ext = path.extname(p);
    const top = p.split('/').filter(Boolean).slice(-3, -1).join('/');
    return `${m[1]} .../${top ? top + '/' : ''}*${ext}`;
  }
  // command + subcommand are kept, every other word becomes *, operators stay: `git push -u origin x` -> `git push *`
  const words = s.trim().split(/\s+/).filter(Boolean);
  const out = []; let pos = 0;
  for (const w of words.slice(0, 12)) {
    if (/^(&&|\|\||;|\|)$/.test(w)) { out.push(w); pos = 0; continue; }
    const keep = pos === 0 || (pos === 1 && /^[a-z][a-z-]*$/.test(w));
    out.push(keep ? (pos === 0 ? w.replace(/^.*\//, '') : w) : '*');
    pos++;
  }
  return out.filter((w, i) => !(w === '*' && out[i - 1] === '*')).join(' ') + (words.length > 12 ? ' ...' : '');
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// ---------- the report ----------
export async function buildReport({ logDir, home = os.homedir(), from = null, to = null, repoRoot = null, top = 10 }) {
  const out = { empty: false, warnings: [], total: 0 };
  const file = path.join(logDir, LOG_FILE);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { out.empty = true; return out; }
  const all = [];
  let bad = 0;
  for (const l of lines) { try { all.push(JSON.parse(l)); } catch { bad++; } }
  if (bad) out.warnings.push(`${bad} unreadable line(s) in the log were skipped`);
  const day = (r) => String(r.ts || '').slice(0, 10);
  const inRange = (r) => (!from || day(r) >= from) && (!to || day(r) <= to);
  const decisions = all.filter((r) => r.type === 'decision' && inRange(r));
  const models = all.filter((r) => r.type === 'model' && inRange(r));
  if (!decisions.length) { out.empty = true; return out; }
  out.total = decisions.length;
  out.range = { from: from || day(decisions[0]), to: to || day(decisions[decisions.length - 1]) };

  // observed outcome per record, transcript by transcript
  const projects = realResolve(path.join(home, '.claude', 'projects'));
  const byTranscript = new Map();
  for (const r of decisions) {
    const k = typeof r.transcript_path === 'string' ? r.transcript_path : '';
    if (!byTranscript.has(k)) byTranscript.set(k, []);
    byTranscript.get(k).push(r);
  }
  const versions = new Set();
  const autoAllowed = { count: 0 };
  for (const [tp, recs] of byTranscript) {
    const mark = (r, outcome, detail, extra = {}) => { r._obs = { outcome, detail, ...extra }; };
    const rr = tp && tp.endsWith('.jsonl') ? realResolve(tp) : { ok: false };
    if (!rr.ok || !rr.exists || !projects.ok || !isInside(rr.real, projects.real)) {
      for (const r of recs) mark(r, 'unknown', tp ? 'transcript_path_invalid_or_missing' : 'no_transcript_path');
      continue;
    }
    const T = { uses: [], results: new Map(), version: null, badLines: 0 };
    try { for (const f of transcriptFiles(rr.real)) await readTranscript(f, T); } catch { for (const r of recs) mark(r, 'unknown', 'transcript_unreadable'); continue; }
    if (T.version) versions.add(T.version);
    const claimed = new Set();
    for (const r of [...recs].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
      const t = Date.parse(r.ts);
      const cands = T.uses.filter((u) => u.name === r.tool_name && u.hash === r.input_hash && u.ts <= t + SKEW_MS && u.ts >= t - WINDOW_MS && !claimed.has(u.id));
      if (cands.length === 0) { mark(r, 'unknown', 'no_matching_tool_use'); continue; }
      if (cands.length > 1) { mark(r, 'ambiguous', 'repeated identical calls'); continue; }
      const u = cands[0]; claimed.add(u.id);
      const res = T.results.get(u.id);
      const o = outcomeOf(u, res);
      mark(r, o.outcome, o.detail, { entrypoint: res?.entrypoint ?? u.entrypoint, sidechain: !!(res?.sidechain || u.sidechain), marker: res ? { decision: res.decision, source: res.source, reasonType: res.reasonType, denialKind: res.denialKind } : null });
    }
    // calls that a settings rule approved never reached the hook
    for (const u of T.uses) {
      if (claimed.has(u.id)) continue;
      const res = T.results.get(u.id);
      if (!res || res.decision !== 'accept' || res.source !== 'config' || res.reasonType !== 'rule') continue;
      const d = new Date(u.ts).toISOString().slice(0, 10);
      if ((from && d < from) || (to && d > to)) continue;
      if (u.cwd && repoRoot && !isInside(u.cwd, repoRoot)) continue;
      autoAllowed.count++;
    }
  }
  if (versions.size) out.claude_code_versions = [...versions];

  // ----- totals -----
  out.by_decision = {}; out.by_stage = {}; out.by_mode = {}; out.by_session_type = {};
  for (const r of decisions) {
    inc(out.by_decision, r.decision); inc(out.by_stage, r.stage || 'prefilter'); inc(out.by_mode, r.mode);
    const o = r._obs;
    const type = o.entrypoint === 'sdk-cli' ? 'headless (-p)' : (o.sidechain || r.agent_id) ? 'subagent' : o.entrypoint === 'cli' ? 'interactive' : 'unknown';
    inc(out.by_session_type, type);
  }
  out.errors = decisions.filter((r) => r.error).reduce((a, r) => { inc(a, r.error); return a; }, {});
  out.observed = {}; for (const r of decisions) inc(out.observed, r._obs.outcome);
  const unrecognised = decisions.filter((r) => r._obs.detail === 'format_unrecognized').length;
  if (unrecognised) out.warnings.push(`${unrecognised} transcript result(s) had no recognisable permission marker (format_unrecognized). The Claude Code transcript format may have changed${out.claude_code_versions ? ` (seen version ${out.claude_code_versions.join(', ')}; tested with 2.1.318)` : ''}.`);

  // ----- matrix and agreement -----
  out.matrix = {};
  for (const r of decisions) { out.matrix[r.decision] ??= {}; inc(out.matrix[r.decision], r._obs.outcome); }
  const known = decisions.filter((r) => r._obs.outcome === 'ran' || r._obs.outcome === 'not_run');
  const agree = known.filter((r) => (r.decision === 'allow' && r._obs.outcome === 'ran') || ((r.decision === 'deny' || r.decision === 'ask') && r._obs.outcome === 'not_run')).length;
  out.agreement = { agree, considered: known.length, rate: known.length ? agree / known.length : null, excluded_unknown: decisions.filter((r) => r._obs.outcome === 'unknown').length, excluded_ambiguous: decisions.filter((r) => r._obs.outcome === 'ambiguous').length };
  const row = (r) => ({ ts: r.ts, tool: r.tool_name, rule_id: r.rule_id, input: r.input_redacted, mode: r.mode, detail: r._obs.detail });
  out.would_allow_but_not_run = decisions.filter((r) => r.decision === 'allow' && r._obs.outcome === 'not_run').map(row);
  out.would_deny_but_ran = decisions.filter((r) => r.decision === 'deny' && r._obs.outcome === 'ran').map(row);
  out.auto_allowed = autoAllowed.count;

  // ----- latency, model -----
  const lat = decisions.map((r) => r.latency_ms).filter((x) => Number.isFinite(x));
  out.latency_ms = { p50: pct(lat, 0.5), p95: pct(lat, 0.95), n: lat.length };
  const modelById = new Map(models.map((m) => [m.record_id, m]));
  out.model = { calls: models.filter((m) => m.model_decision).length, records: models.length, cost_usd: models.reduce((s, m) => s + (Number(m.model_cost_usd) || 0), 0), skipped: {}, errors: {}, vs: {}, latency_p95: pct(models.map((m) => m.latency_ms).filter(Number.isFinite), 0.95) };
  for (const m of models) { if (m.skipped) inc(out.model.skipped, m.skipped); if (m.error) inc(out.model.errors, m.error); }
  out.model.undecided = decisions.filter((r) => r.undecided).length;
  for (const r of decisions.filter((x) => x.undecided)) {
    const m = modelById.get(r.record_id);
    const k = `model ${m?.model_decision ?? (m ? 'none' : 'not run')} | final ${r.decision} | observed ${r._obs.outcome}`;
    inc(out.model.vs, k);
  }
  out.model.would_allow_not_run = decisions.filter((r) => r.undecided && modelById.get(r.record_id)?.model_decision === 'allow' && r._obs.outcome === 'not_run').map(row);

  // ----- top asks (Q14) -----
  const asks = {};
  for (const r of decisions.filter((x) => x.decision === 'ask')) inc(asks, `${r.rule_id || '?'} | ${shapeOf(r)}`);
  out.top_asks = Object.entries(asks).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => ({ key: k, count: n }));

  // ----- self-check material -----
  out.recent = [...decisions].slice(-20).map((r) => ({ ts: r.ts, tool: r.tool_name, decision: r.decision, outcome: r._obs.outcome, detail: r._obs.detail, marker: r._obs.marker ?? null, entrypoint: r._obs.entrypoint ?? null }));
  return out;
}

// ---------- text output ----------
const kv = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)';
export function formatReport(r, { selfcheck = 0 } = {}) {
  if (r.empty) return 'The decision log is empty or missing for this range. Nothing to report yet.\n';
  const L = [];
  const P = (s = '') => L.push(s);
  P(`Approver report ${r.range.from} .. ${r.range.to} (UTC)`);
  for (const w of r.warnings) P(`WARNING: ${w}`);
  if (selfcheck) {
    P(); P(`Self-check: the last ${Math.min(selfcheck, r.recent.length)} record(s) with the permission marker found in the transcript.`);
    P('After pressing "No" on one in-repo prompt, that record should show not_run with a reject marker below.');
    for (const x of r.recent.slice(-selfcheck)) P(`  ${x.ts}  ${x.tool}  would-be ${x.decision}  observed ${x.outcome} (${x.detail})  marker ${JSON.stringify(x.marker)}  entrypoint ${x.entrypoint}`);
    return L.join('\n') + '\n';
  }
  P(`Requests: ${r.total}   modes: ${kv(r.by_mode)}`);
  P(`Would-be decision: ${kv(r.by_decision)}`);
  P(`Stage that decided: ${kv(r.by_stage)}   (the model only logs an opinion; it decides nothing)`);
  P(`Session types: ${kv(r.by_session_type)}`);
  if (Object.keys(r.errors).length) P(`Errors logged: ${kv(r.errors)}`);
  P();
  P(`Observed outcome (from the session transcript): ${kv(r.observed)}`);
  P(`  ran = the tool call ran (owner approved or a rule accepted it); not_run = it did not run.`);
  P(`  NOTE: not_run can also mean a tool error or a block by another hook or rule, not only a human "No".`);
  P(`  Calls a settings rule approved never reached the hook: auto_allowed ${r.auto_allowed}.`);
  P();
  P('Would-be decision x observed outcome:');
  for (const d of ['allow', 'ask', 'deny']) P(`  ${d.padEnd(6)} ${kv(r.matrix[d])}`);
  const a = r.agreement;
  P(`Agreement rate (allow+ran, ask/deny+not_run): ${a.rate === null ? 'n/a' : (100 * a.rate).toFixed(1) + '%'} (${a.agree} of ${a.considered}); excluded: unknown ${a.excluded_unknown}, ambiguous ${a.excluded_ambiguous}`);
  P();
  P(`Would have ALLOWED but the call did not run (${r.would_allow_but_not_run.length}) - complete list:`);
  for (const x of r.would_allow_but_not_run) P(`  ${x.ts}  ${x.tool}  [${x.rule_id}]  ${x.input}  (${x.detail})`);
  P(`Would have DENIED but the call ran (${r.would_deny_but_ran.length}) - complete list:`);
  for (const x of r.would_deny_but_ran) P(`  ${x.ts}  ${x.tool}  [${x.rule_id}]  ${x.input}  (${x.detail})`);
  P();
  P(`Latency of the hook decision: p50 ${r.latency_ms.p50 ?? 'n/a'} ms, p95 ${r.latency_ms.p95 ?? 'n/a'} ms (n=${r.latency_ms.n})`);
  P(`Model (log only): ${r.model.calls} answered of ${r.model.undecided} undecided request(s); total cost US$${r.model.cost_usd.toFixed(4)}; p95 latency ${r.model.latency_p95 ?? 'n/a'} ms`);
  P(`  skipped: ${kv(r.model.skipped)}   errors: ${kv(r.model.errors)}`);
  for (const [k, n] of Object.entries(r.model.vs).sort((x, y) => y[1] - x[1])) P(`  ${n} x ${k}`);
  P(`  Undecided where the model said allow and the call did not run (${r.model.would_allow_not_run.length}):`);
  for (const x of r.model.would_allow_not_run) P(`    ${x.ts}  ${x.tool}  ${x.input}`);
  P();
  P('Most frequent asks (rule | command shape):');
  for (const t of r.top_asks) P(`  ${String(t.count).padStart(4)}  ${t.key}`);
  if (!r.top_asks.length) P('  (none)');
  return L.join('\n') + '\n';
}

async function cli() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const installDir = opt('--install-dir', here);
  let logDir = opt('--log-dir'); let repoRoot = null;
  try { const j = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8')); logDir ||= j.log_dir; repoRoot = j.repo_root; } catch { /* not installed here */ }
  logDir ||= path.join(os.homedir(), 'Library', 'Logs', 'claude-approver');
  const si = args.indexOf('--selfcheck');
  const selfcheck = si >= 0 ? (Number(args[si + 1]) > 0 ? Number(args[si + 1]) : 5) : 0;
  const r = await buildReport({ logDir, home: opt('--home', os.homedir()), from: opt('--from', null), to: opt('--to', null), repoRoot, top: Number(opt('--top', '10')) });
  process.stdout.write(formatReport(r, { selfcheck }));
}
if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  cli().catch((e) => { console.error('report failed: ' + e.message); process.exit(1); });
}
