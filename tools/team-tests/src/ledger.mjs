// Session ledger (plan 3.9 item 6): `<resultsDir>/ledger.json`. A session is written BEFORE it
// starts, so a crash still counts. Sessions with no reported cost (started, crashed, unreadable
// usage) are counted at the per-session cap, the worst case. Fails closed: a symlinked, malformed or
// foreign ledger is refused, never repaired.
import fs from 'node:fs';
import path from 'node:path';
import { GuardRefusal } from './refusal.mjs';

export const LEDGER_NAME = 'ledger.json';
const STATUSES = ['started', 'finished', 'crashed'];
const SLOT = /^G[1-7]\/[0-9]{1,3}$/;

const fileOf = (dir) => path.join(dir, LEDGER_NAME);

export function readLedger(resultsDir, approvalId) {
  const f = fileOf(resultsDir);
  let st;
  try { st = fs.lstatSync(f); } catch { return { version: 1, approvalId, sessions: [] }; }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) throw new GuardRefusal('ledger-file', 'ledger is not a plain file');
  if (st.size > 1_000_000) throw new GuardRefusal('ledger-file', 'ledger too large');
  let l;
  try { l = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new GuardRefusal('ledger-file', 'ledger is not valid JSON'); }
  if (!l || l.version !== 1 || !Array.isArray(l.sessions)) throw new GuardRefusal('ledger-file', 'ledger has an unknown shape');
  if (l.approvalId !== approvalId) throw new GuardRefusal('ledger-approval', 'ledger belongs to a different approval');
  const seen = new Set();
  for (const s of l.sessions) {
    const ok = s && SLOT.test(s.slot) && STATUSES.includes(s.status) && (s.costUsd === null || (typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) && s.costUsd >= 0));
    if (!ok || seen.has(s.slot)) throw new GuardRefusal('ledger-file', 'ledger has a malformed or duplicate session');
    seen.add(s.slot);
  }
  return l;
}

function write(resultsDir, ledger) {
  const f = fileOf(resultsDir);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, f);
}

/** Cost counted so far: reported cost of finished sessions, the per-session cap for all others. */
export function spentUsd(ledger, maxUsdPerSession) {
  return ledger.sessions.reduce((n, s) => n + (s.status === 'finished' && typeof s.costUsd === 'number' ? s.costUsd : maxUsdPerSession), 0);
}

/**
 * Checks the caps for `requested` further sessions: started + requested <= maxSessions, and
 * cumulative cost + one more per-session cap <= maxUsdTotal. Throws GuardRefusal.
 */
export function checkLedger(ledger, approval, requested) {
  if (ledger.sessions.length + requested > approval.maxSessions) {
    throw new GuardRefusal('max-sessions', `${ledger.sessions.length} started + ${requested} requested exceeds maxSessions ${approval.maxSessions}`);
  }
  if (requested > 0 && spentUsd(ledger, approval.maxUsdPerSession) + approval.maxUsdPerSession > approval.maxUsdTotal) {
    throw new GuardRefusal('max-usd-total', 'cumulative cost plus the next per-session cap exceeds maxUsdTotal');
  }
}

/** Slots of the run set already in the ledger (consumed, never re-run), and the ones still to run. */
export function remainingSlots(ledger, runSet) {
  const all = runSet.flatMap((r) => Array.from({ length: r.repeats }, (_, i) => ({ mission: r.mission, repeat: i + 1, slot: `${r.mission}/${i + 1}` })));
  const used = new Set(ledger.sessions.map((s) => s.slot));
  return { consumed: all.filter((s) => used.has(s.slot)), todo: all.filter((s) => !used.has(s.slot)) };
}

/** Writes the session as `started` BEFORE anything runs. Re-checks the caps under the same read. */
export function reserveSession(resultsDir, approval, slot) {
  if (!SLOT.test(slot)) throw new GuardRefusal('ledger-file', 'bad slot');
  const l = readLedger(resultsDir, approval.approvalId);
  if (l.sessions.some((s) => s.slot === slot)) throw new GuardRefusal('slot-used', 'this session slot is already in the ledger (no retries)');
  checkLedger(l, approval, 1);
  l.sessions.push({ slot, startedAt: new Date().toISOString(), status: 'started', costUsd: null });
  write(resultsDir, l);
}

export function finishSession(resultsDir, approval, slot, { status, costUsd }) {
  if (!['finished', 'crashed'].includes(status)) throw new Error('ledger: bad status');
  const l = readLedger(resultsDir, approval.approvalId);
  const s = l.sessions.find((x) => x.slot === slot);
  if (!s) throw new GuardRefusal('ledger-file', 'session not in ledger');
  s.status = status;
  s.costUsd = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
  write(resultsDir, l);
}
