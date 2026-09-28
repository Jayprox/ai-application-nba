// Pure translation of The Odds API payloads (unit-tested in test/odds.test.js).

/** Odds API market key -> our prop_lines.market. JD's pick (2026-09-27): all 12. */
export const ODDS_MARKETS = {
  player_points: 'pts', player_rebounds: 'reb', player_assists: 'ast', player_threes: 'fg3m',
  player_points_rebounds_assists: 'pra', player_points_rebounds: 'pr', player_points_assists: 'pa', player_rebounds_assists: 'ra',
  player_steals: 'stl', player_blocks: 'blk', player_blocks_steals: 'stocks', player_turnovers: 'tov',
};

/** American odds -> implied probability (vig included). */
export const implied = (p) => (p < 0 ? -p / (-p + 100) : 100 / (p + 100));

/**
 * One event's odds -> one line per (player, market) for `book`.
 * A book sometimes lists more than one line for a player in the main market;
 * keep the one priced closest to even (the "main" line), and only lines that
 * have BOTH an Over and an Under.
 * @returns [{name, market, line, over_price, under_price, book_updated_at}]
 */
export function linesFromEvent(ev, book = 'draftkings') {
  const bm = (ev?.bookmakers ?? []).find((b) => b.key === book);
  if (!bm) return [];
  const out = [];
  for (const m of bm.markets ?? []) {
    const market = ODDS_MARKETS[m.key];
    if (!market) continue;
    const pairs = new Map();                       // "name|point" -> {over, under}
    for (const o of m.outcomes ?? []) {
      const name = String(o.description ?? '').trim();
      const side = String(o.name).toLowerCase();
      if (!name || o.point == null || !['over', 'under'].includes(side)) continue;
      const k = `${name}|${o.point}`;
      const pr = pairs.get(k) ?? { name, point: Number(o.point) };
      pr[side] = Number(o.price);
      pairs.set(k, pr);
    }
    const best = new Map();                        // name -> pair
    for (const pr of pairs.values()) {
      if (pr.over == null || pr.under == null || !(pr.point >= 0 && pr.point < 200)) continue;
      const gap = Math.abs(implied(pr.over) - implied(pr.under));
      const cur = best.get(pr.name);
      if (!cur || gap < cur.gap) best.set(pr.name, { ...pr, gap });
    }
    for (const pr of best.values()) {
      out.push({ name: pr.name, market, line: pr.point, over_price: pr.over, under_price: pr.under, book_updated_at: m.last_update ?? bm.last_update ?? null });
    }
  }
  return out;
}

/**
 * Odds API team name -> our team id. Their names are full names ("Los Angeles
 * Clippers") while NBA.com's is "LA Clippers", so match on the nickname
 * (teams.name: "Clippers", "Trail Blazers", "76ers"), which is unique.
 */
export function teamIdFor(oddsName, teams) {
  const n = String(oddsName ?? '').toLowerCase().trim();
  const hits = teams.filter((t) => n === t.full_name.toLowerCase() || n.endsWith(` ${t.name.toLowerCase()}`));
  return hits.length === 1 ? hits[0].id : null;
}
