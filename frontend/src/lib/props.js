// Prop display helpers (pure; tested in props.test.js).
export const MARKETS = [['pts', 'PTS'], ['reb', 'REB'], ['ast', 'AST'], ['fg3m', '3PM'], ['pra', 'PRA'], ['pr', 'P+R'], ['pa', 'P+A'], ['ra', 'R+A'],
  ['stl', 'STL'], ['blk', 'BLK'], ['stocks', 'STL+BLK'], ['tov', 'TOV']];
export const MARKET_SHORT = Object.fromEntries(MARKETS);

/** American odds: +105 / -110. */
export const price = (p) => (p == null ? '' : p > 0 ? `+${p}` : String(p));

/** "7/10" and the over share (null with no games). */
export const hits = (h) => (h?.games ? `${h.over}/${h.games}` : '—');
export const overRate = (h) => (h?.games ? h.over / h.games : null);
export const ratePct = (h) => (h?.games ? `${Math.round((h.over / h.games) * 100)}%` : '—');

/** Line movement from the opening line: {dir:'up'|'down', by:1} or null. */
export function movement(open, line) {
  if (open == null || line == null || open === line) return null;
  return { dir: line > open ? 'up' : 'down', by: Math.abs(line - open) };
}

export const RESULT = { over: 'Over', under: 'Under', push: 'Push', dnp: 'DNP' };

/**
 * Board order. l10 / season: over rate high to low (on equal rates the bigger sample first:
 * 10/10 before 1/1), then line; line: high to low; game: tip-off order, then name.
 */
export function sortRows(rows, by, gameOrder = new Map()) {
  const rate = (h) => overRate(h) ?? -1;
  const cmp = {
    l10: (a, b) => rate(b.last10) - rate(a.last10) || b.last10.games - a.last10.games || b.line - a.line,
    season: (a, b) => rate(b.season) - rate(a.season) || b.season.games - a.season.games || b.line - a.line,
    line: (a, b) => b.line - a.line,
    game: (a, b) => (gameOrder.get(a.game_id) ?? 0) - (gameOrder.get(b.game_id) ?? 0) || a.name.localeCompare(b.name),
  }[by] ?? (() => 0);
  return [...rows].sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
}
