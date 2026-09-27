// Pure translation of Highlightly payloads into our columns. No I/O here, so
// every rule is unit-tested (test/map.test.js) against the real dry-run files.

/** Highlightly match state -> games.status. */
export function statusOf(state) {
  const d = String(state?.description ?? '').toLowerCase();
  if (d === 'finished' || d.startsWith('finished') || d === 'ended' || d === 'final') return 'final';
  if (d.includes('postpon')) return 'postponed';
  if (d.includes('cancel') || d.includes('abandon')) return 'cancelled';
  if (d === 'scheduled' || d === 'not started' || d === '' || d.includes('delayed')) return 'scheduled';
  // "1st quarter", "Half time", "Overtime", "Break time"... anything under way.
  return 'live';
}

/** Sum of per-period points (overtimes are extra array entries). null when nothing scored yet. */
export function totalScore(periods) {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  return periods.reduce((s, p) => s + (Number(p) || 0), 0);
}

/** Regulation 48 minutes + 5 per overtime, times 5 players. */
export const teamMinutes = (periodCount) => 240 + Math.max(0, (periodCount ?? 4) - 4) * 25;

// Highlightly stat names -> our columns (all 17 verified against NBA.com in the dry-run).
const STAT = {
  'Total Minutes Played': 'minutes',
  'Total Points Scored': 'pts',
  'Successful Field Goals': 'fgm',
  'Total Field Goals': 'fga',
  'Successful 3PT Field Goals': 'fg3m',
  'Total 3PT Field Goals': 'fg3a',
  'Successful Free Throws': 'ftm',
  'Total Free Throws': 'fta',
  'Total Rebounds': 'reb',
  'Total Assists': 'ast',
  'Total Turnovers': 'tov',
  'Total Steals': 'stl',
  'Total Blocks': 'blk',
  'Total Offensive Rebounds': 'oreb',
  'Total Defensive Rebounds': 'dreb',
  'Total Fouls': 'pf',
  'Plus Minus': 'plus_minus',
};
export const STAT_COLS = ['minutes', 'pts', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf', 'plus_minus'];

/**
 * One box-score entry -> {dnp, stats}. Highlightly lists players who didn't
 * play with an empty statistics array (NBA.com omits them entirely).
 */
export function statLine(entry) {
  const list = entry?.statistics ?? [];
  const stats = Object.fromEntries(STAT_COLS.map((c) => [c, null]));
  for (const s of list) if (STAT[s.name] && s.value !== null && s.value !== undefined) stats[STAT[s.name]] = Number(s.value);
  // Empty list = DNP. A non-empty list counts as played even at 0 minutes
  // (a few seconds on the floor rounds down to 0 but the game counts).
  if (list.length === 0) return { dnp: true, stats: Object.fromEntries(STAT_COLS.map((c) => [c, null])) };
  return { dnp: false, stats };
}

/** Sum player lines into team totals (team_games has no minutes-per-player nuance). */
export function teamTotals(lines, periodCount) {
  const t = Object.fromEntries(STAT_COLS.filter((c) => c !== 'minutes' && c !== 'plus_minus').map((c) => [c, 0]));
  for (const l of lines) if (!l.dnp) for (const c of Object.keys(t)) t[c] += l.stats[c] ?? 0;
  return { ...t, minutes: teamMinutes(periodCount) };
}

/** Starters from GET /lineups: Set of Highlightly player ids with isStarter === true. */
export function starterIds(lineups) {
  const ids = new Set();
  for (const side of ['home', 'away']) for (const p of lineups?.[side]?.lineup ?? []) if (p.isStarter === true) ids.add(String(p.id));
  return ids;
}

/** 'YYYY-MM-DD' in America/New_York — the date Highlightly's ?date= filter uses. */
export function etDate(when = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(when);
  const v = (t) => parts.find((p) => p.type === t).value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}

export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
