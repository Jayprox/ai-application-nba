// Result files (plan 3.7): loading, strict validation and scoring. Pure local file reads; never
// launches a model. Fail closed: any unknown, missing or malformed file throws ResultError.
//
// run.json (one per run): { runId, mission, repeat, configRef, configSha, harnessSha, cliVersion,
//   launchProfile, models[], stopReason, criteria[{id,kind,category,status,pass}], usage, wallMs,
//   ceilingHit }. usage = { inputTokens, outputTokens, cacheCreationInputTokens,
//   cacheReadInputTokens, totalCostUsd, byModel?: { <model>: same fields } }.
// Free text (evidence, errors) is never read into reports: only the validated fields below.
import fs from 'node:fs';
import path from 'node:path';
import { loadAll, allCriteria } from './missions.mjs';

export class ResultError extends Error {
  constructor(why) { super(why); this.name = 'ResultError'; }
}

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES = 200;
export const STOP_REASONS = Object.freeze(['completed', 'stop-mode', 'max-resumes', 'unplanned-question', 'gate2', 'always-ask', 'budget', 'timeout', 'error']);
export const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']);
const STATUSES = ['passed', 'failed', 'error', 'human'];
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA = /^[0-9a-f]{7,64}$/;
const MODEL = /^[A-Za-z0-9._:-]{1,64}$/;
const SHORT = /^[A-Za-z0-9._+-]{1,64}$/;
const NO_CANARY = /canary/i; // canary-shaped text is never accepted into a result record

let missionCache;
const missions = () => (missionCache ??= loadAll());

function str(v, re, why) { need(typeof v === 'string' && re.test(v) && !NO_CANARY.test(v), why); }
const isNum = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function need(cond, why) { if (!cond) throw new ResultError(why); }

function checkUsageBlock(u, what) {
  need(u && typeof u === 'object' && !Array.isArray(u), `${what}: usage must be an object`);
  for (const k of USAGE_KEYS) need(isNum(u[k]), `${what}: usage.${k} must be a non-negative number`);
  need(isNum(u.totalCostUsd), `${what}: usage.totalCostUsd must be a non-negative number`);
}

/** Validates one parsed run record and returns a sanitised copy holding only known fields. */
export function validateRun(r, label = 'result') {
  need(r && typeof r === 'object' && !Array.isArray(r), `${label}: not an object`);
  str(r.runId, ID, `${label}: invalid runId`);
  const m = missions()[r.mission];
  need(m, `${label}: unknown mission`);
  need(Number.isInteger(r.repeat) && r.repeat >= 1 && r.repeat <= 100, `${label}: invalid repeat`);
  need(typeof r.configSha === 'string' && SHA.test(r.configSha), `${label}: invalid configSha`);
  need(typeof r.harnessSha === 'string' && SHA.test(r.harnessSha), `${label}: invalid harnessSha`);
  str(r.configRef, SHORT, `${label}: invalid configRef`);
  str(r.cliVersion, SHORT, `${label}: invalid cliVersion`);
  str(r.launchProfile, SHORT, `${label}: invalid launchProfile`);
  need(Array.isArray(r.models) && r.models.length <= 20 && r.models.every((x) => typeof x === 'string' && MODEL.test(x) && !NO_CANARY.test(x)), `${label}: invalid models`);
  need(STOP_REASONS.includes(r.stopReason), `${label}: unknown stopReason`);
  need(isNum(r.wallMs), `${label}: invalid wallMs`);
  need(typeof r.ceilingHit === 'boolean', `${label}: invalid ceilingHit`);
  checkUsageBlock(r.usage, label);
  const byModel = {};
  if (r.usage.byModel !== undefined) {
    need(r.usage.byModel && typeof r.usage.byModel === 'object' && !Array.isArray(r.usage.byModel), `${label}: usage.byModel must be an object`);
    for (const [k, v] of Object.entries(r.usage.byModel)) {
      need(MODEL.test(k) && !NO_CANARY.test(k), `${label}: invalid model name in usage.byModel`);
      checkUsageBlock(v, `${label} ${k}`);
      byModel[k] = Object.fromEntries([...USAGE_KEYS, 'totalCostUsd'].map((x) => [x, v[x]]));
    }
  }
  const expected = new Map(allCriteria(m).map((c) => [c.id, c]));
  need(Array.isArray(r.criteria), `${label}: criteria must be an array`);
  const seen = new Set();
  const criteria = r.criteria.map((c) => {
    need(c && typeof c === 'object', `${label}: malformed criterion`);
    const e = expected.get(c.id);
    need(e, `${label}: unknown criterion`);
    need(!seen.has(c.id), `${label}: duplicate criterion`);
    seen.add(c.id);
    need(c.kind === e.kind && c.category === e.category, `${label}: criterion kind or category does not match the mission`);
    need(STATUSES.includes(c.status) && typeof c.pass === 'boolean', `${label}: invalid criterion status`);
    need(c.pass === (c.status === 'passed'), `${label}: criterion pass does not match status`);
    return { id: c.id, kind: c.kind, category: c.category, status: c.status, pass: c.pass };
  });
  need(seen.size === expected.size, `${label}: criteria do not cover the mission`);
  const usage = { ...Object.fromEntries([...USAGE_KEYS, 'totalCostUsd'].map((k) => [k, r.usage[k]])), byModel };
  return { runId: r.runId, mission: r.mission, repeat: r.repeat, configRef: r.configRef, configSha: r.configSha, harnessSha: r.harnessSha, cliVersion: r.cliVersion, launchProfile: r.launchProfile, models: [...r.models], stopReason: r.stopReason, criteria, usage, wallMs: r.wallMs, ceilingHit: r.ceilingHit };
}

function readOne(file, label) {
  let st;
  try { st = fs.lstatSync(file); } catch { throw new ResultError(`${label}: file not found`); }
  need(st.isFile() && !st.isSymbolicLink(), `${label}: not a regular file`);
  need(st.size <= MAX_FILE_BYTES, `${label}: file too large`);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new ResultError(`${label}: not valid JSON`); }
  return validateRun(obj, label);
}

/** Files that make up a result set: `<dir>/*.json` and `<dir>/<sub>/run.json` (report files excluded). */
function filesOf(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { throw new ResultError('result path not found'); }
  if (st.isSymbolicLink()) throw new ResultError('result path is a symlink');
  if (st.isFile()) return [p];
  need(st.isDirectory(), 'result path is neither a file nor a directory');
  const out = [];
  for (const name of fs.readdirSync(p).sort()) {
    const f = path.join(p, name);
    const s = fs.lstatSync(f);
    if (s.isFile() && name.endsWith('.json') && name !== 'report.json' && name !== 'blind-key.json' && name !== 'ledger.json') out.push(f);
    else if (s.isDirectory() && !s.isSymbolicLink() && fs.existsSync(path.join(f, 'run.json'))) out.push(path.join(f, 'run.json'));
  }
  return out;
}

/** Loads and validates a result set from files and/or directories. Throws ResultError (fail closed). */
export function loadResults(paths) {
  need(Array.isArray(paths) && paths.length > 0, 'no result files given');
  const files = paths.flatMap((p) => filesOf(p));
  need(files.length > 0, 'no result files found');
  need(files.length <= MAX_FILES, 'too many result files');
  const runs = files.map((f, i) => readOne(f, `result #${i + 1}`));
  const ids = new Set();
  const slots = new Set();
  for (const r of runs) {
    need(!ids.has(r.runId), 'duplicate runId in result set');
    ids.add(r.runId);
    const slot = `${r.mission}/${r.repeat}`;
    need(!slots.has(slot), 'duplicate mission and repeat in result set');
    slots.add(slot);
  }
  return runs;
}

const tally = (cs) => ({ passed: cs.filter((c) => c.pass).length, total: cs.length });

/** Score for one run: mechanical passes/total, with safety and quality in their own columns. */
export function scoreRun(run) {
  const mech = run.criteria.filter((c) => c.kind === 'M');
  return {
    runId: run.runId, mission: run.mission, repeat: run.repeat, stopReason: run.stopReason,
    mechanical: tally(mech),
    safety: tally(mech.filter((c) => c.category === 'safety')),
    quality: tally(mech.filter((c) => c.category === 'quality')),
    failed: mech.filter((c) => !c.pass).map((c) => c.id),
  };
}

export function totalTokens(u) { return USAGE_KEYS.reduce((s, k) => s + u[k], 0); }

/** Groups a result set by mission and tallies passes per mechanical criterion. */
export function summarise(runs) {
  const byMission = {};
  for (const run of runs) {
    const g = (byMission[run.mission] ??= { n: 0, criteria: {}, stopReasons: {}, runs: [] });
    g.n += 1;
    g.runs.push(run);
    g.stopReasons[run.stopReason] = (g.stopReasons[run.stopReason] ?? 0) + 1;
    for (const c of run.criteria) {
      if (c.kind !== 'M') continue;
      const t = (g.criteria[c.id] ??= { id: c.id, category: c.category, passed: 0, n: 0 });
      t.n += 1;
      if (c.pass) t.passed += 1;
    }
  }
  return byMission;
}
