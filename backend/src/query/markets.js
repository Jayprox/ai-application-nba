// Player prop markets (architecture.md §7.6). A line is graded against the
// box score: over if the stat beats it, under if it falls short, push on an
// exact whole-number line; a DNP has no action. Nothing is predicted.
export const MARKETS = ['pts', 'reb', 'ast', 'fg3m', 'pra', 'pr', 'pa', 'ra', 'stl', 'blk', 'stocks', 'tov'];
export const MARKET_LABEL = {
  pts: 'Points', reb: 'Rebounds', ast: 'Assists', fg3m: '3-pointers made', pra: 'Pts + Reb + Ast', pr: 'Pts + Reb',
  pa: 'Pts + Ast', ra: 'Reb + Ast', stl: 'Steals', blk: 'Blocks', stocks: 'Steals + Blocks', tov: 'Turnovers',
};
const PARTS = { pts: ['pts'], reb: ['reb'], ast: ['ast'], fg3m: ['fg3m'], pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'],
  pa: ['pts', 'ast'], ra: ['reb', 'ast'], stl: ['stl'], blk: ['blk'], stocks: ['stl', 'blk'], tov: ['tov'] };

/** SQL expression for a market's stat on a player_game_stats-shaped alias. */
export const marketSql = (alias, m) => `(${PARTS[m].map((c) => `${alias}.${c}`).join(' + ')})`;
/** Same, in JS, for a box-score row. */
export const marketValue = (row, m) => (PARTS[m].some((c) => row[c] == null) ? null : PARTS[m].reduce((s, c) => s + row[c], 0));
export const grade = (value, line) => (value == null ? null : value > line ? 'over' : value < line ? 'under' : 'push');

/** Validate { pts: 25.5, ... } -> same object, or an error string. */
export function checkLines(lines) {
  if (typeof lines !== 'object' || lines === null || Array.isArray(lines)) return 'lines must be an object like {"pts": 25.5}';
  const keys = Object.keys(lines);
  if (!keys.length || keys.length > MARKETS.length) return 'lines must name 1-12 markets';
  for (const [k, v] of Object.entries(lines)) {
    if (!MARKETS.includes(k)) return `unknown market "${k}" (allowed: ${MARKETS.join(', ')})`;
    if (typeof v !== 'number' || !(v >= 0 && v < 200) || !Number.isInteger(v * 2)) return `line for ${k} must be a number like 25.5 (0-199.5, halves)`;
  }
  return null;
}
