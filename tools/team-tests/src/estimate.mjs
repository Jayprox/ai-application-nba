// Cost estimate shown before a real run (plan 3.9). Deterministic text: the owner's approval file
// carries the sha256 of exactly this text, so an estimate was shown for this run set and these caps.
// No price table and no measured numbers: the worst case is sessions x per-session cap.
import crypto from 'node:crypto';
import { MISSION_IDS } from './missions.mjs';

export const MAX_SESSIONS = 6; // hard cap in code; raising it is a PR the owner approves

export function parseRunSet(spec) {
  if (typeof spec !== 'string' || !spec) throw new Error('run set: empty');
  return spec.split(',').map((part) => {
    const m = /^(G[1-7]):([1-9][0-9]?)$/.exec(part);
    if (!m || !MISSION_IDS.includes(m[1])) throw new Error('run set: expected G<n>:<repeats>[,...]');
    return { mission: m[1], repeats: Number(m[2]) };
  });
}

export const totalSessions = (runSet) => runSet.reduce((n, r) => n + r.repeats, 0);
const usd = (n) => `US$${Number(n).toFixed(2)}`;

export function estimateText({ runSet, maxSessions, maxUsdPerSession, maxUsdTotal }) {
  const n = totalSessions(runSet);
  const worst = n * maxUsdPerSession;
  return [
    'team-tests cost estimate (no price table; actual cost is the CLI-reported cost)',
    `run set: ${runSet.map((r) => `${r.mission} x${r.repeats}`).join(', ')}`,
    `sessions requested: ${n} (hard cap in code: ${MAX_SESSIONS}; approval maxSessions: ${maxSessions})`,
    `per-session cap: ${usd(maxUsdPerSession)}; total cap: ${usd(maxUsdTotal)}`,
    `worst case, sessions x per-session cap: ${usd(worst)}`,
    `binding ceiling: ${usd(Math.min(worst, maxUsdTotal))}${worst > maxUsdTotal ? ' (the total cap stops the run before every session starts)' : ''}`,
    'assumptions (UNMEASURED, from the requirements, not from any run): G3 is the cheapest session; G1 costs more; the pilot measures both',
    '',
  ].join('\n');
}

export const estimateSha256 = (params) => crypto.createHash('sha256').update(estimateText(params)).digest('hex');
