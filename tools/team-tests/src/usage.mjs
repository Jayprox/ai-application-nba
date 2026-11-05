// Usage capture (plan 4.2). Pure: reads normalised events (src/transcript.mjs), returns the usage
// block of the B6 run.json schema. Field names are UNCONFIRMED for the installed CLI (plan 5.6), so
// the parser is tolerant: a missing field counts as 0 and is listed in `missing`, never invented.
import { resultUsage, sumMessageUsage } from './transcript.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const pick = (o, ...names) => { for (const n of names) { const v = num(o?.[n]); if (v !== undefined) return v; } return undefined; };

export const zeroUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0, byModel: {} });
const FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'];

function modelBlock(m) {
  return {
    inputTokens: pick(m, 'inputTokens', 'input_tokens') ?? 0,
    outputTokens: pick(m, 'outputTokens', 'output_tokens') ?? 0,
    cacheCreationInputTokens: pick(m, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0,
    cacheReadInputTokens: pick(m, 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0,
    totalCostUsd: pick(m, 'costUSD', 'costUsd', 'cost_usd', 'total_cost_usd') ?? 0,
  };
}
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const tokens = (u) => FIELDS.reduce((s, k) => s + u[k], 0);

/**
 * parseUsage(events) -> { ok, usage, missing[], reconciled } for ONE invocation.
 * ok is false when there is no `result` event or no cost figure: the caller then counts the session
 * at the per-session cap and the pilot stop rule applies (plan 4.1).
 */
export function parseUsage(events) {
  const r = resultUsage(events);
  const msg = sumMessageUsage(events);
  const missing = [];
  const usage = zeroUsage();
  if (!r) missing.push('result');
  else {
    const cost = num(r.totalCostUsd);
    if (cost === undefined) missing.push('total_cost_usd'); else usage.totalCostUsd = cost;
    if (!r.usage) missing.push('usage');
    else {
      usage.inputTokens = r.usage.input_tokens;
      usage.outputTokens = r.usage.output_tokens;
      usage.cacheCreationInputTokens = r.usage.cache_creation_input_tokens;
      usage.cacheReadInputTokens = r.usage.cache_read_input_tokens;
    }
    if (isObj(r.modelUsage)) {
      for (const [name, m] of Object.entries(r.modelUsage)) if (MODEL_NAME.test(name) && isObj(m)) usage.byModel[name] = modelBlock(m);
    } else missing.push('modelUsage');
  }
  // Independent per-message sum; when the two disagree by more than 5% the larger is used (plan 4.2).
  const sum = Object.values(msg).reduce((a, u) => { for (const [k, v] of Object.entries({ inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, cacheReadInputTokens: u.cache_read_input_tokens })) a[k] += v; return a; }, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  const a = tokens(usage);
  const b = tokens(sum);
  let reconciled = 'agree';
  if (Math.abs(a - b) > 0.05 * Math.max(a, b, 1)) {
    reconciled = b > a ? 'message-sum-larger' : 'result-larger';
    if (b > a) for (const k of FIELDS) usage[k] = sum[k];
  }
  const ok = Boolean(r) && num(r.totalCostUsd) !== undefined;
  return { ok, usage, missing, reconciled };
}

/** Adds invocation usage blocks (resumes) into one. */
export function addUsage(...blocks) {
  const out = zeroUsage();
  for (const u of blocks) {
    for (const k of [...FIELDS, 'totalCostUsd']) out[k] += u[k];
    for (const [m, v] of Object.entries(u.byModel ?? {})) {
      const t = (out.byModel[m] ??= { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 });
      for (const k of [...FIELDS, 'totalCostUsd']) t[k] += v[k];
    }
  }
  return out;
}

/** Session-level check against the independent per-message sum (all events, de-duplicated by id). */
export function reconcile(usage, events) {
  const msg = Object.values(sumMessageUsage(events)).reduce((a, u) => ({
    inputTokens: a.inputTokens + u.input_tokens, outputTokens: a.outputTokens + u.output_tokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + u.cache_creation_input_tokens, cacheReadInputTokens: a.cacheReadInputTokens + u.cache_read_input_tokens,
  }), { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  const a = tokens(usage);
  const b = tokens(msg);
  if (Math.abs(a - b) <= 0.05 * Math.max(a, b, 1) || b <= a) return usage;
  return { ...usage, ...msg };
}
