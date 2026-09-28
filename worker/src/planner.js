// What should the worker do right now? Pure function of the clock, the games
// around now, and what it did last — so the cadence is unit-tested.
//
// JD's choice (2026-09-27), "live-ish":
//   * a game in its window (tip-off -10 min .. +8 h, not final) -> poll that
//     date's scores every 5 min (30 min when the quota runs low);
//   * box score when a game goes final, re-checked once ~3 h later
//     (handled by sync.boxDue on every poll of that date);
//   * once a day (after 06:00 ET): yesterday + today, plus any past game still
//     not final (postponements, missed finals).
import { addDays, etDate } from './map.js';

const MIN = 60e3, HOUR = 60 * MIN;
export const POLL_EVERY = 5 * MIN;
export const POLL_EVERY_LOW_QUOTA = 30 * MIN;
export const LOW_QUOTA = 500;

/**
 * @param now Date
 * @param games [{tipoff_utc, status, box_score_checks, box_score_synced_at}] — current season, ~4 days around now
 * @param state {lastPollAt:number|null, lastDailyEt:string|null, quotaRemaining:number|null}
 * @returns {dates:string[], reason:string, daily:boolean}
 */
export function plan(now, games, state) {
  const t = now.getTime();
  const dates = new Set();
  const reasons = [];
  const open = (g) => !['final', 'postponed', 'cancelled'].includes(g.status);
  const tip = (g) => (g.tipoff_utc ? new Date(g.tipoff_utc).getTime() : null);

  const active = games.filter((g) => open(g) && tip(g) !== null && tip(g) <= t + 10 * MIN && tip(g) >= t - 8 * HOUR);
  const recheck = games.filter((g) => g.status === 'final' && g.box_score_checks === 1 && g.box_score_synced_at && t - new Date(g.box_score_synced_at).getTime() >= 3 * HOUR);
  const missingBox = games.filter((g) => g.status === 'final' && g.box_score_checks === 0 && tip(g) !== null && tip(g) >= t - 2 * 24 * HOUR);
  const every = state.quotaRemaining !== null && state.quotaRemaining < LOW_QUOTA ? POLL_EVERY_LOW_QUOTA : POLL_EVERY;
  const due = state.lastPollAt === null || t - state.lastPollAt >= every;

  if (due) {
    for (const g of [...active, ...recheck, ...missingBox]) dates.add(etDate(new Date(tip(g) ?? t)));
    if (active.length) reasons.push(`${active.length} game(s) in window`);
    if (recheck.length) reasons.push(`${recheck.length} box score re-check(s)`);
    if (missingBox.length) reasons.push(`${missingBox.length} final(s) without a box score`);
  }

  const today = etDate(now);
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const daily = state.lastDailyEt !== today && etHour >= 6;
  if (daily) {
    dates.add(addDays(today, -1)); dates.add(today);
    const stale = games.filter((g) => open(g) && g.status !== 'postponed' && tip(g) !== null && tip(g) < t - 8 * HOUR);
    for (const g of stale.slice(0, 5)) dates.add(etDate(new Date(tip(g))));
    reasons.push(`daily sweep${stale.length ? ` + ${stale.length} past game(s) not final` : ''}`);
  }
  return { dates: [...dates].sort(), reason: reasons.join('; '), daily };
}

// ---- player props (The Odds API) ------------------------------------------
// JD's choice (2026-09-27): DraftKings, two snapshots per game.
//   open  : the morning of the game (from 09:00 ET), retried hourly until the
//           book has posted lines, and never later than 90 min before tip;
//   close : in the 35 minutes before tip-off (the line that grades the prop).
// Preseason is skipped. Quota guard: under 1,000 credits only closing lines
// are pulled; under 150, nothing (a call costs up to 120).
export const PROP_TYPES = ['regular', 'cup_final', 'play_in', 'playoffs'];
export const PROPS_CLOSE_BEFORE = 35 * MIN;
export const PROPS_OPEN_LAST = 90 * MIN;
export const PROPS_OPEN_RETRY = HOUR;
export const PROPS_OPEN_FROM_ET_HOUR = 9;
export const PROPS_LOW_QUOTA = 1000;
export const PROPS_MIN_QUOTA = 150;

/**
 * @param games [{id, tipoff_utc, status, season_type, props_open_at, props_close_at}]
 * @param state {openTries: Map<gameId, ms>, quotaRemaining: number|null}
 * @returns {open: string[], close: string[], reason: string}
 */
export function planProps(now, games, state) {
  const t = now.getTime();
  const q = state.quotaRemaining;
  const out = { open: [], close: [], reason: '' };
  if (q !== null && q < PROPS_MIN_QUOTA) return { ...out, reason: `quota ${q} < ${PROPS_MIN_QUOTA}: no prop pulls` };
  const today = etDate(now);
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
  for (const g of games) {
    if (!PROP_TYPES.includes(g.season_type) || g.status !== 'scheduled' || !g.tipoff_utc) continue;
    const tip = new Date(g.tipoff_utc).getTime();
    if (!g.props_close_at && t >= tip - PROPS_CLOSE_BEFORE && t < tip) { out.close.push(g.id); continue; }
    const lowQuota = q !== null && q < PROPS_LOW_QUOTA;
    const lastTry = state.openTries?.get(g.id);
    if (!lowQuota && !g.props_open_at && !g.props_close_at && etDate(new Date(tip)) === today && etHour >= PROPS_OPEN_FROM_ET_HOUR
        && t < tip - PROPS_OPEN_LAST && (lastTry === undefined || t - lastTry >= PROPS_OPEN_RETRY)) out.open.push(g.id);
  }
  const parts = [];
  if (out.open.length) parts.push(`${out.open.length} opening line pull(s)`);
  if (out.close.length) parts.push(`${out.close.length} closing line pull(s)`);
  if (q !== null && q < PROPS_LOW_QUOTA) parts.push(`quota ${q}: closing lines only`);
  out.reason = parts.join('; ');
  return out;
}
