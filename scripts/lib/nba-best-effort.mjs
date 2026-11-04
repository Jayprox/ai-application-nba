// Pure helpers for the NBA.com best-effort mode (M6, docs/plans/M6-highlightly-weekly.md §4.5).
// The three loaders (load-schedule, load-positions, backfill) call these when weekly.mjs passes
// --nba-best-effort. Without that flag nothing here is used and the loaders behave as before.

// What each NBA.com sub-step would have refreshed (fixed names: the runner prints them in the final line).
export const SKIPPED = {
  'schedule:nba': ['nba:arena', 'nba:tv', 'nba:cup', 'nba:season_type', 'nba:new_games'],
  'positions:nba': ['nba:positions'],
  'backfill:nba': ['nba:reconcile', 'nba:standings'],
};
export const SKIP_ALLOWLIST = new Set(Object.values(SKIPPED).flat());
export const NBA_STATES = ['ok', 'down', 'disabled', 'skipped', 'n/a'];

const ONE_LINE = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 200);

/** 'ok' | 'disabled' | 'down' from the env the runner set (WEEKLY_NBA=0, WEEKLY_NBA_STATE=down). */
export function nbaStartState(env = process.env) {
  if (env.WEEKLY_NBA === '0') return 'disabled';
  if (env.WEEKLY_NBA_STATE === 'down') return 'down';
  return 'ok';
}

export const skipMessage = (state) => (state === 'disabled' ? 'nba.com disabled by config' : 'nba.com unreachable earlier in this run, skipped');

/**
 * Classify an error from a best-effort NBA.com step.
 *  warn : the NBA.com side is at fault (unreachable, blocked, malformed or unexpected data, failed checks) -> exit 0, degraded
 *  fail : our database (or anything unknown) -> exit 1
 * @returns {{kind:'warn'|'fail', nba:'down'|'ok', reason:string}}
 */
export function classifyError(e) {
  if (e?.name === 'NbaUnavailable') return { kind: 'warn', nba: 'down', reason: `nba.com unreachable: ${ONE_LINE(e.nbaKind)}` };
  if (isDbError(e)) return { kind: 'fail', nba: 'ok', reason: `database error (${/^[0-9A-Z]{5}$/.test(e?.code ?? '') ? e.code : 'connection'})` };
  const msg = String(e?.message ?? '');
  if (e?.name === 'NbaDataError') return { kind: 'warn', nba: 'ok', reason: `nba.com data rejected: ${ONE_LINE(e.message)}` };
  if (e instanceof TypeError || e instanceof SyntaxError || e instanceof RangeError) return { kind: 'warn', nba: 'ok', reason: 'nba.com data rejected: unexpected response shape' };
  if (/^checks failed/.test(msg)) return { kind: 'warn', nba: 'ok', reason: `nba.com data rejected: ${ONE_LINE(msg.split('\n')[0])}` };
  if (/^game \S+: unknown team id/.test(msg)) return { kind: 'warn', nba: 'ok', reason: `nba.com data rejected: ${ONE_LINE(msg)}` };
  return { kind: 'fail', nba: 'ok', reason: `unexpected error (${ONE_LINE(e?.name || 'Error')})` };
}

/** pg errors carry a severity and a 5-character SQLSTATE; connection trouble has ECONN*-style codes. */
export function isDbError(e) {
  if (!e) return false;
  if (e.severity !== undefined) return true;
  if (/^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)/.test(String(e.code ?? ''))) return true;
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/.test(String(e.message ?? ''));
}

/** The one machine-readable line a best-effort step prints last (parsed by scripts/lib/weekly.mjs). */
export function weeklyLine({ step, degraded = false, nba = 'ok', skipped = [], reason = null }) {
  const clean = skipped.filter((s) => SKIP_ALLOWLIST.has(s));
  return `@@WEEKLY ${JSON.stringify({ v: 1, step, degraded, nba, skipped: clean, stop: null, hl: { requests: 0, limit: null, remaining: null }, reason: reason === null ? null : ONE_LINE(reason) })}`;
}

/**
 * Before the reconcile transaction: if the database already has final games for the season but NBA.com
 * returned zero team game-log rows, the data is not complete and the reconcile must not run (its
 * destructive step deletes Highlightly rows NBA.com "doesn't have").
 */
export function nbaSeasonComplete({ dbFinalGames, teamLogRows }) {
  return !(dbFinalGames > 0 && teamLogRows === 0);
}
