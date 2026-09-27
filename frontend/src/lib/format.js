// Display helpers. Game dates are the home team's LOCAL date ('YYYY-MM-DD');
// parse them at noon UTC so no timezone can shift them a day.
const asDate = (ymd) => new Date(`${ymd}T12:00:00Z`);

export function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(asDate(s).getTime());

export const longDate = (ymd) => asDate(ymd).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
export const shortDate = (ymd) => asDate(ymd).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
/** "Oct 3", or "Aug 15, 2020" when the year differs from `relativeTo` (a jump across seasons). */
export const tinyDate = (ymd, relativeTo) => asDate(ymd).toLocaleDateString('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric', ...(relativeTo && relativeTo.slice(0, 4) !== ymd.slice(0, 4) ? { year: 'numeric' } : {}),
});

/** Tip-off in the viewer's own timezone, e.g. "7:30 PM". */
export const tipTime = (utc) => (utc ? new Date(utc).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'Time TBD');

export const SEASON_TYPE = { preseason: 'Preseason', regular: 'Regular season', play_in: 'Play-In', playoffs: 'Playoffs', cup_final: 'NBA Cup Final' };

const ROUND = { 1: 'First round', 2: 'Conf. semifinals', 3: 'Conf. finals', 4: 'NBA Finals' };
/** One-line context for a game card: playoff round/game, Cup stage, neutral city. */
export function gameContext(g) {
  const bits = [];
  if (g.season_type === 'playoffs' && g.series_round) bits.push(`${ROUND[g.series_round] ?? `Round ${g.series_round}`}${g.series_game_number ? ` · Game ${g.series_game_number}` : ''}`);
  else if (g.season_type === 'play_in') bits.push('Play-In');
  else if (g.season_type === 'preseason') bits.push('Preseason');
  else if (g.season_type === 'cup_final') bits.push('NBA Cup Final');
  else if (g.cup_stage) bits.push(g.cup_stage === 'group' ? 'NBA Cup group' : `NBA Cup ${g.cup_stage}`);
  if (g.is_neutral_site && g.arena_city) bits.push(`in ${g.arena_city}`);
  return bits.join(' · ');
}

/** "1 day rest", "0 days rest · 2nd night of a back-to-back", "No prior game". */
export function restLabel(rest, b2b) {
  if (rest == null) return 'no prior game this season';
  const r = `${rest} day${rest === 1 ? '' : 's'} rest`;
  if (b2b === 2) return `${r} · 2nd night of a back-to-back`;
  if (b2b === 1) return `${r} · 1st night of a back-to-back`;
  return r;
}

export const tvLabel = (tier, nets) => (tier === 'local' || !nets?.length ? 'Local TV only' : `National TV: ${nets.join(', ')}`);

export const mins = (m) => (m == null ? '' : String(Math.round(Number(m))));
export const pm = (v) => (v == null ? '' : v > 0 ? `+${v}` : String(v));
export const made = (m, a) => (m == null || a == null ? '' : `${m}-${a}`);

/** Per-game average: 27.7, or an em dash when there's no value. */
export const avg = (v) => (v == null ? '—' : Number(v).toFixed(1));
/** Shooting percentage the NBA way: .561 */
export const pct = (v) => (v == null ? '—' : v >= 1 ? '1.000' : `.${String(Math.round(v * 1000)).padStart(3, '0')}`);
/** Signed average: +4.2 / -1.0 */
export const signedAvg = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`);

/** "just now", "12 min ago", "3 h ago", "2 days ago" */
export function ago(iso, now = Date.now()) {
  if (!iso) return null;
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export const SEASON_TYPE_LOWER = { regular: 'regular season', play_in: 'play-in', playoffs: 'playoffs', all: 'all game types' };
