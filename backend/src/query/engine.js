// The one shared query engine (PLATFORM.md §2). Humans (web/iOS) and agents
// call exactly this; every result carries sample size + freshness.
// No predictive calculations: filtered averages/totals computed at query time.
//
// Request: { entity, id, scope, season, season_type, splits, stat, limit }
// Decisions: architecture.md §5 (scopes), §6.1 (splits), §7.2 (history).

export class QueryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SCOPES = ['season', 'last5', 'last10', 'career', 'game_log', 'leaderboard'];
const SEASON_TYPES = { regular: ['regular'], play_in: ['play_in'], playoffs: ['playoffs'], all: ['regular', 'play_in', 'playoffs'] };
const SPLITS = {
  venue: ['home', 'away'],
  b2b: [1, 2],                 // TEAM schedule: did the team play yesterday / tomorrow
  rest: [0, 1, 2, '3+'],       // TEAM schedule: days since the team's last game
  player_b2b: [1, 2],          // PLAYER's own games (player queries only) — matches NBA.com
  player_rest: [0, 1, 2, '3+'],
  national_tv: ['major', 'nba_tv', 'local'],
  altitude: [true, false],
};
export const STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m', 'fgm', 'fga', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'pf', 'plus_minus', 'minutes'];
const LEADERBOARD_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'fg3m', 'tov', 'minutes', 'plus_minus'];
const QUALIFIER = 0.7; // played in >= 70% of games (Chalk That's rule, not the NBA's)
export const FIRST_SEASON = '2003-04';

export function validate(q) {
  if (!q || typeof q !== 'object') throw new QueryError(400, 'body must be a JSON object');
  const scope = q.scope ?? 'season';
  if (!SCOPES.includes(scope)) throw new QueryError(400, `scope must be one of ${SCOPES.join(', ')}`);
  const entity = q.entity ?? 'player';
  if (!['player', 'team'].includes(entity)) throw new QueryError(400, 'entity must be player or team');
  if (scope === 'leaderboard' && entity !== 'player') throw new QueryError(400, 'leaderboard is player-only');
  if (scope !== 'leaderboard' && (q.id === undefined || q.id === null || q.id === '')) throw new QueryError(400, 'id is required');
  if (entity === 'player' && scope !== 'leaderboard' && !/^[0-9a-f-]{36}$/i.test(String(q.id))) throw new QueryError(404, 'player not found');
  if (entity === 'team' && !/^\d+$/.test(String(q.id))) throw new QueryError(404, 'team not found');
  const needsSeason = scope !== 'career';
  if (needsSeason && !/^\d{4}-\d{2}$/.test(String(q.season ?? ''))) throw new QueryError(400, 'season must look like 2025-26');
  if (q.season && !/^\d{4}-\d{2}$/.test(String(q.season))) throw new QueryError(400, 'season must look like 2025-26');
  const seasonType = q.season_type ?? 'regular';
  if (!SEASON_TYPES[seasonType]) throw new QueryError(400, `season_type must be one of ${Object.keys(SEASON_TYPES).join(', ')}`);
  const splits = q.splits ?? {};
  if (typeof splits !== 'object' || Array.isArray(splits)) throw new QueryError(400, 'splits must be an object');
  for (const [k, v] of Object.entries(splits)) {
    if (!SPLITS[k]) throw new QueryError(400, `unknown split "${k}" (allowed: ${Object.keys(SPLITS).join(', ')})`);
    if (!SPLITS[k].includes(v)) throw new QueryError(400, `split ${k} must be one of ${SPLITS[k].map((x) => JSON.stringify(x)).join(', ')}`);
  }
  if (entity === 'team' && (splits.player_rest !== undefined || splits.player_b2b !== undefined))
    throw new QueryError(400, 'player_rest / player_b2b apply to player queries; use rest / b2b for teams');
  if (scope === 'leaderboard') {
    if (Object.keys(splits).length) throw new QueryError(400, 'splits are not supported on leaderboards (v1)');
    if (!LEADERBOARD_STATS.includes(q.stat ?? 'pts')) throw new QueryError(400, `stat must be one of ${LEADERBOARD_STATS.join(', ')}`);
  }
  const limit = q.limit === undefined ? 10 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new QueryError(400, 'limit must be an integer 1-50');
  return { entity, id: q.id, scope, season: q.season ?? null, seasonType, splits, stat: q.stat ?? 'pts', limit };
}

/** WHERE fragments for season / season type / splits. `tg` = team_games, `g` = games, `a` = arenas. */
function filters(v, params, { withSeason = true } = {}) {
  const w = ["g.status = 'final'"];
  const p = (x) => { params.push(x); return `$${params.length}`; };
  w.push(`g.season_type = ANY(${p(SEASON_TYPES[v.seasonType])}::text[])`);
  if (withSeason && v.season) w.push(`g.season = ${p(v.season)}`);
  const s = v.splits;
  if (s.venue) w.push(`tg.venue_split = ${p(s.venue)}`);        // neutral sites excluded from both (§6.1)
  if (s.b2b) w.push(`tg.b2b_night = ${p(s.b2b)}`);
  if (s.rest !== undefined) w.push(s.rest === '3+' ? 'tg.rest_days >= 3' : `tg.rest_days = ${p(s.rest)}`);
  if (s.player_b2b) w.push(`s.player_b2b_night = ${p(s.player_b2b)}`);
  if (s.player_rest !== undefined) w.push(s.player_rest === '3+' ? 's.player_rest_days >= 3' : `s.player_rest_days = ${p(s.player_rest)}`);
  if (s.national_tv) w.push(`g.national_tv_tier = ${p(s.national_tv)}`);
  if (s.altitude !== undefined) w.push(`coalesce(a.is_high_altitude, false) = ${p(s.altitude)}`);
  return w.join(' AND ');
}

const avgCols = (alias) => STATS.map((c) => `round(avg(${alias}.${c})::numeric, 1)::float8 AS ${c}`).join(', ');
const pctCols = (alias) => `
  round((sum(${alias}.fgm)::numeric / nullif(sum(${alias}.fga), 0)), 3)::float8 AS fg_pct,
  round((sum(${alias}.fg3m)::numeric / nullif(sum(${alias}.fg3a), 0)), 3)::float8 AS fg3_pct,
  round((sum(${alias}.ftm)::numeric / nullif(sum(${alias}.fta), 0)), 3)::float8 AS ft_pct`;

async function freshness(db) {
  const { rows: [r] } = await db.query(`SELECT max(finished_at) AS synced_at FROM ingestion_runs WHERE status = 'success'`);
  return { synced_at: r?.synced_at ?? null, source: 'nba_stats' };
}

// ------------------------------------------------------------------ player --
async function playerQuery(db, v) {
  const { rows: [player] } = await db.query('SELECT id, full_name, first_season_start FROM players WHERE id = $1', [v.id]);
  if (!player) throw new QueryError(404, 'player not found');
  const params = [v.id];
  const where = `s.player_id = $1 AND NOT s.dnp AND ${filters(v, params, { withSeason: v.scope !== 'career' })}`;
  const base = `FROM player_game_stats s
     JOIN games g ON g.id = s.game_id
     JOIN team_games tg ON tg.game_id = s.game_id AND tg.team_id = s.team_id
     LEFT JOIN arenas a ON a.id = g.arena_id
    WHERE ${where}`;
  const notes = [];
  if (v.scope === 'career' && player.first_season_start && player.first_season_start < 2003)
    notes.push(`Stats begin ${FIRST_SEASON}; ${player.full_name}'s career started in ${player.first_season_start}-${String((player.first_season_start + 1) % 100).padStart(2, '0')}, so earlier seasons aren't included.`);
  if (v.splits.venue) notes.push('Neutral-site games (international, NBA Cup knockouts in Las Vegas, the 2020 Orlando bubble) are excluded from home/away.');

  if (v.scope === 'game_log') {
    const { rows } = await db.query(
      `SELECT g.id AS game_id, g.game_date_local AS date, g.season, g.season_type, tg.venue_split AS venue,
              ot.abbreviation AS opponent, tg.won, tg.rest_days, tg.b2b_night, g.national_tv_tier, coalesce(a.is_high_altitude, false) AS altitude,
              s.player_rest_days, s.player_b2b_night, s.started, ${STATS.map((c) => `s.${c}`).join(', ')}
         ${base.replace('LEFT JOIN arenas a ON a.id = g.arena_id', 'LEFT JOIN arenas a ON a.id = g.arena_id JOIN teams ot ON ot.id = tg.opponent_team_id')}
        ORDER BY g.game_date_local DESC`, params);
    return { data: rows.map((r) => ({ ...r, minutes: r.minutes === null ? null : Number(r.minutes) })), sample: rows.length, record: record(rows), notes, player };
  }

  if (v.scope === 'career') {
    const { rows } = await db.query(
      `SELECT g.season, count(*)::int AS gp, count(*) FILTER (WHERE tg.won)::int AS w, ${avgCols('s')}, ${pctCols('s')}
         ${base} GROUP BY g.season ORDER BY g.season`, params);
    const { rows: [tot] } = await db.query(`SELECT count(*)::int AS gp, count(*) FILTER (WHERE tg.won)::int AS w, ${avgCols('s')}, ${pctCols('s')} ${base}`, params);
    return { data: { totals: stripCounts(tot), by_season: rows.map(stripCounts) }, sample: tot.gp, record: `${tot.w}-${tot.gp - tot.w}`, notes, player };
  }

  // season / last5 / last10 — splits first, then the window ("Last 10 + Home" = last 10 home games)
  const n = v.scope === 'last5' ? 5 : v.scope === 'last10' ? 10 : null;
  const inner = `SELECT s.*, tg.won ${base} ORDER BY g.game_date_local DESC${n ? ` LIMIT ${n}` : ''}`;
  const { rows: [r] } = await db.query(`SELECT count(*)::int AS gp, count(*) FILTER (WHERE x.won)::int AS w, ${avgCols('x')}, ${pctCols('x')} FROM (${inner}) x`, params);
  return { data: r.gp ? stripCounts(r) : null, sample: r.gp, record: `${r.w}-${r.gp - r.w}`, notes, player };
}

// -------------------------------------------------------------------- team --
async function teamQuery(db, v) {
  const { rows: [team] } = await db.query('SELECT id, abbreviation, full_name FROM teams WHERE id = $1', [Number(v.id)]);
  if (!team) throw new QueryError(404, 'team not found');
  const params = [Number(v.id)];
  const where = `tg.team_id = $1 AND ${filters(v, params, { withSeason: v.scope !== 'career' })}`;
  const base = `FROM team_games tg JOIN games g ON g.id = tg.game_id LEFT JOIN arenas a ON a.id = g.arena_id WHERE ${where}`;
  const notes = v.splits.venue ? ['Neutral-site games are excluded from home/away.'] : [];
  const oppPts = '(SELECT o.pts FROM team_games o WHERE o.game_id = tg.game_id AND o.team_id = tg.opponent_team_id)';
  if (v.scope === 'game_log') {
    const { rows } = await db.query(
      `SELECT g.id AS game_id, g.game_date_local AS date, g.season, g.season_type, tg.venue_split AS venue, ot.abbreviation AS opponent,
              tg.won, tg.pts, ${oppPts} AS opp_pts, tg.rest_days, tg.b2b_night, g.national_tv_tier, coalesce(a.is_high_altitude, false) AS altitude
         ${base.replace('LEFT JOIN arenas a ON a.id = g.arena_id', 'LEFT JOIN arenas a ON a.id = g.arena_id JOIN teams ot ON ot.id = tg.opponent_team_id')}
        ORDER BY g.game_date_local DESC`, params);
    return { data: rows, sample: rows.length, record: record(rows), notes, team };
  }
  const n = v.scope === 'last5' ? 5 : v.scope === 'last10' ? 10 : null;
  const group = v.scope === 'career' ? 'GROUP BY x.season ORDER BY x.season' : '';
  const inner = `SELECT tg.*, g.season, ${oppPts} AS opp_pts ${base} ORDER BY g.game_date_local DESC${n ? ` LIMIT ${n}` : ''}`;
  const sel = `count(*)::int AS gp, count(*) FILTER (WHERE x.won)::int AS w, ${avgCols('x')}, round(avg(x.opp_pts)::numeric, 1)::float8 AS opp_pts, ${pctCols('x')}`;
  const { rows: [r] } = await db.query(`SELECT ${sel} FROM (${inner}) x`, params);
  const data = r.gp ? stripCounts(r) : null;
  if (v.scope === 'career') {
    const { rows } = await db.query(`SELECT x.season, ${sel} FROM (${inner}) x ${group}`, params);
    return { data: { totals: data, by_season: rows.map(stripCounts) }, sample: r.gp, record: `${r.w}-${r.gp - r.w}`, notes, team };
  }
  return { data, sample: r.gp, record: `${r.w}-${r.gp - r.w}`, notes, team };
}

// ------------------------------------------------------------- leaderboard --
async function leaderboard(db, v) {
  const types = SEASON_TYPES[v.seasonType];
  // Qualifier: games played >= 70% of the most games any team has played in this
  // season + season type so far (fair to traded players; scales early season).
  const { rows: [m] } = await db.query(
    `SELECT max(n)::int AS team_games FROM (SELECT tg.team_id, count(*) n FROM team_games tg JOIN games g ON g.id = tg.game_id
      WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' GROUP BY 1) t`, [v.season, types]);
  const teamGames = m?.team_games ?? 0;
  const minGp = Math.ceil(teamGames * QUALIFIER);
  const { rows } = await db.query(
    `SELECT p.id AS player_id, p.full_name, count(*)::int AS gp,
            round(avg(s.${v.stat})::numeric, 1)::float8 AS value,
            (SELECT t.abbreviation FROM player_game_stats s2 JOIN games g2 ON g2.id = s2.game_id JOIN teams t ON t.id = s2.team_id
              WHERE s2.player_id = p.id AND g2.season = $1 ORDER BY g2.game_date_local DESC LIMIT 1) AS team
       FROM player_game_stats s JOIN games g ON g.id = s.game_id JOIN players p ON p.id = s.player_id
      WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' AND NOT s.dnp
      GROUP BY p.id, p.full_name HAVING count(*) >= $3
      ORDER BY value DESC NULLS LAST, gp DESC, p.full_name LIMIT $4`, [v.season, types, Math.max(minGp, 1), v.limit]);
  const { rows: [q] } = await db.query(
    `SELECT count(*)::int n FROM (SELECT s.player_id FROM player_game_stats s JOIN games g ON g.id = s.game_id
      WHERE g.season = $1 AND g.season_type = ANY($2::text[]) AND g.status = 'final' AND NOT s.dnp GROUP BY 1 HAVING count(*) >= $3) t`,
    [v.season, types, Math.max(minGp, 1)]);
  return {
    data: rows.map((r, i) => ({ rank: i + 1, ...r })),
    sample: q.n,
    record: null,
    notes: [`Qualifier: played in at least ${Math.round(QUALIFIER * 100)}% of team games (${minGp} of ${teamGames}) — Chalk That's rule, not the NBA's official one.`],
    qualifier: { min_games: minGp, team_games: teamGames, qualified_players: q.n },
  };
}

const stripCounts = ({ w, ...rest }) => rest;
const record = (rows) => { const w = rows.filter((r) => r.won).length; return `${w}-${rows.length - w}`; };

/** Run a validated query; cache is optional. */
export async function runQuery(db, cache, body, { currentSeason = '2026-27' } = {}) {
  const v = validate(body);
  const key = 'q:v1:' + JSON.stringify(v, Object.keys(v).sort()) + JSON.stringify(Object.entries(v.splits).sort());
  const hit = await cache.get(key);
  if (hit) return { ...hit, meta: { ...hit.meta, cached: true } };
  const r = v.scope === 'leaderboard' ? await leaderboard(db, v) : v.entity === 'team' ? await teamQuery(db, v) : await playerQuery(db, v);
  const out = {
    query: v,
    subject: r.player ? { type: 'player', id: r.player.id, name: r.player.full_name } : r.team ? { type: 'team', id: r.team.id, name: r.team.full_name, abbreviation: r.team.abbreviation } : { type: 'league' },
    data: r.data,
    meta: {
      sample_size: r.sample,
      record: r.record,
      filters_applied: { season: v.season, season_type: v.seasonType, ...v.splits },
      ...(r.qualifier ? { qualifier: r.qualifier } : {}),
      notes: r.notes,
      freshness: await freshness(db),
      cached: false,
    },
  };
  // Finished seasons don't change: cache a day. Current season / career: 5 minutes.
  const ttl = v.season && v.season < currentSeason && v.scope !== 'career' ? 86400 : 300;
  await cache.set(key, out, ttl);
  return out;
}
