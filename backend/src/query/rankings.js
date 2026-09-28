// Rankings + matchup insights (architecture.md §7.7). Deterministic, from
// stored box scores only — no model, no prediction (PLATFORM.md).
//
// JD's calls (2026-09-27):
//  - positions G / F / C from NBA.com's listing; a hybrid counts toward its
//    first-listed position (G-F = G, F-C = F). The listing is the player's
//    CURRENT one, applied to every season.
//  - player score = equal-weight z-scores within the position group over
//    PTS, REB, AST, STL, BLK, 3PM, TS% and TOV (fewer is better).
//  - matchups: what each defense allows per game to each position group,
//    ranked 1-30 (1 = allows the fewest) and shown against the league
//    average; the 5 best are "strong", the 5 worst "weak".
import { QUALIFIER } from './engine.js';
import { MARKETS } from './markets.js';

export const POSITIONS = ['G', 'F', 'C'];
export const POSITION_LABEL = { G: 'Guards', F: 'Forwards', C: 'Centers' };
export const TYPES = { regular: ['regular'], playoffs: ['playoffs'], all: ['regular', 'play_in', 'playoffs'] };
export const Z_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'fg3m', 'ts_pct', 'tov'];
const LOWER_IS_BETTER = new Set(['tov']);
const BASE = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'tov'];
const COMBO = { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'], stocks: ['stl', 'blk'] };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/** NBA.com listing -> G / F / C (first-listed wins), or null. */
export const posGroup = (listed) => ({ G: 'G', F: 'F', C: 'C' })[String(listed ?? '').trim().charAt(0).toUpperCase()] ?? null;

/**
 * Competition ranking ("1224"): equal values share a rank. `better` is 'high' or 'low'.
 * Returns a Map row -> rank.
 */
export function ranks(rows, value, better = 'high') {
  const sorted = [...rows].filter((r) => value(r) != null).sort((a, b) => (better === 'high' ? value(b) - value(a) : value(a) - value(b)));
  const out = new Map();
  sorted.forEach((r, i) => out.set(r, i > 0 && value(sorted[i - 1]) === value(r) ? out.get(sorted[i - 1]) : i + 1));
  return out;
}

/**
 * Equal-weight z-score composite (pure; unit-tested). Population SD within the
 * group; a stat with no spread contributes 0; TOV counts negatively.
 * Adds z: {stat: z} and score (mean of the z's), sorted best first with rank.
 */
export function composite(rows, stats = Z_STATS) {
  const spread = Object.fromEntries(stats.map((k) => {
    const xs = rows.map((r) => r[k]).filter((v) => v != null);
    const mean = xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length || 1));
    return [k, { mean, sd }];
  }));
  const scored = rows.map((r) => {
    const z = Object.fromEntries(stats.map((k) => {
      const { mean, sd } = spread[k];
      const raw = r[k] == null || !sd ? 0 : (r[k] - mean) / sd;
      return [k, Math.round((LOWER_IS_BETTER.has(k) ? -raw : raw) * 100) / 100];
    }));
    return { ...r, z, score: Math.round((stats.reduce((s, k) => s + z[k], 0) / stats.length) * 100) / 100 };
  });
  const rk = ranks(scored, (r) => r.score, 'high');
  return scored.map((r) => ({ ...r, rank: rk.get(r) })).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/** Qualifier: 70% of the most games any team has played (same rule as leaderboards). */
async function qualifier(db, season, types) {
  const { rows: [m] } = await db.query(
    `SELECT coalesce(max(n), 0)::int AS team_games FROM (SELECT tg.team_id, count(*) n FROM team_games tg JOIN games g ON g.id = tg.game_id
      WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' GROUP BY 1) t`, [season, types]);
  return { team_games: m.team_games, min_games: Math.max(1, Math.ceil(m.team_games * QUALIFIER)) };
}

// --------------------------------------------------------------- players ----
export async function playerRankings(db, { season, seasonType = 'regular', position, scope = 'season' }) {
  const types = TYPES[seasonType];
  const q = await qualifier(db, season, types);
  // Every qualified player's games this season; last10 = his 10 most recent of them.
  const { rows } = await db.query(
    `WITH base AS (
       SELECT s.*, p.full_name, p.listed_position, t.abbreviation AS team, g.game_date_local,
              row_number() OVER (PARTITION BY s.player_id ORDER BY g.game_date_local DESC) AS rn,
              count(*) OVER (PARTITION BY s.player_id) AS season_gp
         FROM player_game_stats s JOIN games g ON g.id = s.game_id JOIN players p ON p.id = s.player_id JOIN teams t ON t.id = s.team_id
        WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' AND NOT s.dnp
          AND upper(left(trim(p.listed_position), 1)) = $3)
     SELECT player_id, full_name AS name, listed_position, max(season_gp)::int AS season_gp, count(*)::int AS gp,
            (array_agg(team ORDER BY game_date_local DESC))[1] AS team,
            avg(pts)::float8 AS pts, avg(reb)::float8 AS reb, avg(ast)::float8 AS ast, avg(stl)::float8 AS stl,
            avg(blk)::float8 AS blk, avg(fg3m)::float8 AS fg3m, avg(tov)::float8 AS tov, avg(minutes)::float8 AS minutes,
            (sum(pts)::numeric / nullif(2 * (sum(fga) + 0.44 * sum(fta)), 0))::float8 AS ts_pct
       FROM base WHERE season_gp >= $4 AND ($5::bool IS FALSE OR rn <= 10)
      GROUP BY player_id, full_name, listed_position`,
    [season, types, position, q.min_games, scope === 'last10']);
  const ranked = composite(rows).map((r) => ({
    ...r, pts: r1(r.pts), reb: r1(r.reb), ast: r1(r.ast), stl: r1(r.stl), blk: r1(r.blk), fg3m: r1(r.fg3m), tov: r1(r.tov),
    minutes: r1(r.minutes), ts_pct: r3(r.ts_pct),
  }));
  return { data: ranked, qualifier: { ...q, qualified_players: ranked.length } };
}

// ----------------------------------------------------------------- teams ----
export async function teamRankings(db, { season, seasonType = 'regular', scope = 'season' }) {
  const types = TYPES[seasonType];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT tg.*, (SELECT o.pts FROM team_games o WHERE o.game_id = tg.game_id AND o.team_id = tg.opponent_team_id) AS opp_pts,
              row_number() OVER (PARTITION BY tg.team_id ORDER BY g.game_date_local DESC) AS rn
         FROM team_games tg JOIN games g ON g.id = tg.game_id
        WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' AND tg.won IS NOT NULL)
     SELECT t.id AS team_id, t.abbreviation AS abbr, t.full_name AS name, count(*)::int AS gp,
            count(*) FILTER (WHERE b.won)::int AS w, avg(b.pts)::float8 AS pts, avg(b.opp_pts)::float8 AS opp_pts,
            (sum(b.fga) - sum(b.oreb) + sum(b.tov) + 0.44 * sum(b.fta))::float8 AS poss, sum(b.pts)::float8 AS pts_sum, sum(b.opp_pts)::float8 AS opp_sum
       FROM base b JOIN teams t ON t.id = b.team_id
      WHERE ($3::bool IS FALSE OR b.rn <= 10)
      GROUP BY t.id, t.abbreviation, t.full_name`,
    [season, types, scope === 'last10']);
  const data = rows.map((r) => {
    const off = r.poss ? (100 * r.pts_sum) / r.poss : null, def = r.poss ? (100 * r.opp_sum) / r.poss : null;
    return { team_id: r.team_id, abbr: r.abbr, name: r.name, gp: r.gp, w: r.w, l: r.gp - r.w, pts: r1(r.pts), opp_pts: r1(r.opp_pts),
      off_rtg: r1(off), def_rtg: r1(def), net_rtg: off == null ? null : r1(off - def), pace: r1(r.poss / r.gp) };
  });
  const rk = { off_rtg: ranks(data, (r) => r.off_rtg, 'high'), def_rtg: ranks(data, (r) => r.def_rtg, 'low'),
    net_rtg: ranks(data, (r) => r.net_rtg, 'high'), pace: ranks(data, (r) => r.pace, 'high') };
  const out = data.map((r) => ({ ...r, ranks: Object.fromEntries(Object.entries(rk).map(([k, m]) => [k, m.get(r) ?? null])) }));
  return { data: out.sort((a, b) => a.ranks.net_rtg - b.ranks.net_rtg || a.abbr.localeCompare(b.abbr)) };
}

// -------------------------------------------------------------- matchups ----
/**
 * What each defense allows per game to each position group (pure part; unit-tested).
 * @param games   [{def_id, abbr, games}] — every team in scope and its game count
 * @param sums    [{def_id, pos, pts, reb, ...}] — opponents' totals by position group
 * @returns {G: [...], F: [...], C: [...]} each row: per-game allowed for all 12 markets,
 *          rank (1 = allows the fewest), vs league average, strong/weak label.
 */
export function matchupTable(games, sums) {
  const out = {};
  const n = games.length;
  for (const pos of POSITIONS) {
    const rows = games.map((g) => {
      const s = sums.find((x) => x.def_id === g.def_id && x.pos === pos) ?? {};
      const per = Object.fromEntries(BASE.map((k) => [k, g.games ? (Number(s[k] ?? 0)) / g.games : null]));
      for (const [k, parts] of Object.entries(COMBO)) per[k] = parts.some((p) => per[p] == null) ? null : parts.reduce((a, p) => a + per[p], 0);
      return { team_id: g.def_id, abbr: g.abbr, games: g.games, allowed: per };
    });
    const avg = Object.fromEntries(MARKETS.map((k) => {
      const xs = rows.map((r) => r.allowed[k]).filter((v) => v != null);
      return [k, xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null];
    }));
    const rk = Object.fromEntries(MARKETS.map((k) => [k, ranks(rows, (r) => (r.allowed[k] == null ? null : Math.round(r.allowed[k] * 100) / 100), 'low')]));
    out[pos] = rows.map((r) => ({
      team_id: r.team_id, abbr: r.abbr, games: r.games,
      allowed: Object.fromEntries(MARKETS.map((k) => [k, r1(r.allowed[k])])),
      vs_avg: Object.fromEntries(MARKETS.map((k) => [k, r.allowed[k] == null || avg[k] == null ? null : r1(r.allowed[k] - avg[k])])),
      rank: Object.fromEntries(MARKETS.map((k) => [k, rk[k].get(r) ?? null])),
      label: Object.fromEntries(MARKETS.map((k) => {
        const x = rk[k].get(r);
        return [k, x == null || n < 10 ? null : x <= 5 ? 'strong' : x > n - 5 ? 'weak' : null];
      })),
    })).sort((a, b) => (a.rank.pts ?? 99) - (b.rank.pts ?? 99) || a.abbr.localeCompare(b.abbr));
    out[`${pos}_avg`] = Object.fromEntries(MARKETS.map((k) => [k, r1(avg[k])]));
  }
  return out;
}

/** Load + compute. `before` (YYYY-MM-DD) limits to games before a date (the Props board never peeks). */
export async function matchups(db, { season, seasonType = 'regular', scope = 'season', before = null }) {
  const types = TYPES[seasonType];
  const params = [season, types, before, scope === 'last10'];
  const scopeCte = `d AS (
       SELECT tg.team_id AS def_id, tg.game_id,
              row_number() OVER (PARTITION BY tg.team_id ORDER BY g.game_date_local DESC) AS rn
         FROM team_games tg JOIN games g ON g.id = tg.game_id
        WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' AND tg.won IS NOT NULL
          AND ($3::date IS NULL OR g.game_date_local < $3::date)),
     ds AS (SELECT * FROM d WHERE $4::bool IS FALSE OR rn <= 10)`;
  const { rows: games } = await db.query(
    `WITH ${scopeCte} SELECT t.id AS def_id, t.abbreviation AS abbr, count(ds.game_id)::int AS games
       FROM teams t JOIN ds ON ds.def_id = t.id GROUP BY t.id, t.abbreviation`, params);
  const { rows: sums } = await db.query(
    `WITH ${scopeCte}
     SELECT ds.def_id, upper(left(trim(p.listed_position), 1)) AS pos, ${BASE.map((k) => `sum(s.${k})::float8 AS ${k}`).join(', ')}
       FROM ds JOIN player_game_stats s ON s.game_id = ds.game_id AND s.team_id <> ds.def_id AND NOT s.dnp
       JOIN players p ON p.id = s.player_id
      GROUP BY 1, 2`, params);
  const table = matchupTable(games, sums.filter((x) => POSITIONS.includes(x.pos)));
  const totalPts = sums.reduce((a, x) => a + Number(x.pts ?? 0), 0);
  const unlistedPts = sums.filter((x) => !POSITIONS.includes(x.pos)).reduce((a, x) => a + Number(x.pts ?? 0), 0);
  return { ...table, unlisted_share: totalPts ? Math.round((unlistedPts / totalPts) * 1000) / 1000 : 0, teams: games.length };
}
