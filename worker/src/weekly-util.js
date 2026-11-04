// Small helpers shared by the weekly Highlightly modules.
import { addDays } from './map.js';

/** Vendor strings are printed with control characters removed and capped, so a crafted value can't forge a log/result line. */
export const clean = (s, n = 80) => String(s ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, n);

/** First `max` items of a list of already-clean strings, plus how many were left out. */
export const capList = (list, max = 15) => (list.length > max ? [...list.slice(0, max), `+${list.length - max} more`] : [...list]);

/** ET dates around `today`, nearest first: today, -1, +1, -2, +2 ... so a cap cuts the far future first. */
export function nearestFirst(today, back, ahead) {
  const out = [today];
  for (let k = 1; k <= Math.max(back, ahead); k++) {
    if (k <= back) out.push(addDays(today, -k));
    if (k <= ahead) out.push(addDays(today, k));
  }
  return out;
}

/**
 * One short transaction: BEGIN, lock_timeout 5 s, fn, COMMIT (or ROLLBACK for a dry run). A lock timeout
 * (55P03) rolls back and retries the write phase once; the second one throws with a fixed reason.
 * Any other database error rolls back and rethrows with `reason` set (never the raw message).
 */
export async function inTransaction(db, fn, { dryRun = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL lock_timeout = '5s'`);
      const out = await fn();
      await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');
      return out;
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      if (e?.code === '55P03' && attempt < 2) continue;
      if (e?.reason) throw e;
      const err = new Error(e?.code === '55P03' ? 'database error (lock timeout)' : `database error (${/^[0-9A-Z]{5}$/.test(e?.code ?? '') ? e.code : 'unknown'})`);
      err.reason = err.message;
      throw err;
    }
  }
}
