// Browse routes: lists and detail pages. Stats always come from POST /query.
import { Router } from 'express';
import { matchesSearch } from '../lib/names.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_CAP = 100;

export function browseRoutes(db, { currentSeason = '2026-27' } = {}) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  r.get('/teams', wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT t.id, t.abbreviation, t.city, t.name, t.full_name, t.conference, t.division,
              a.name AS arena, a.city AS arena_city, a.elevation_ft, a.is_high_altitude
         FROM teams t LEFT JOIN arenas a ON a.id = t.home_arena_id ORDER BY t.conference, t.division, t.full_name`);
    res.json({ data: rows });
  }));

  r.get('/teams/:id', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'team not found' });
    const { rows: [team] } = await db.query(
      `SELECT t.*, a.name AS arena, a.city AS arena_city, a.elevation_ft, a.is_high_altitude
         FROM teams t LEFT JOIN arenas a ON a.id = t.home_arena_id WHERE t.id = $1`, [Number(req.params.id)]);
    if (!team) return res.status(404).json({ error: 'team not found' });
    const { rows: roster } = await db.query(
      `SELECT id, full_name, listed_position, height_in, weight_lb, birth_date FROM players
        WHERE current_team_id = $1 AND is_active ORDER BY full_name`, [team.id]);
    res.json({ data: { ...team, roster } });
  }));

  // Seasons that have finished games, newest first, with the season types
  // played in each: drives every season picker (and the "latest season" default).
  r.get('/seasons', wrap(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT season, array_agg(DISTINCT season_type ORDER BY season_type) AS types, count(*)::int AS final_games
         FROM games WHERE status = 'final' AND season_type <> 'preseason' GROUP BY season ORDER BY season DESC`);
    res.json({ data: rows, meta: { current_season: currentSeason, latest_with_games: rows[0]?.season ?? null } });
  }));

  // Everyone who played for a team in a season (trades included), per-game averages.
  r.get('/teams/:id/players', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'team not found' });
    const season = String(req.query.season ?? '');
    if (!/^\d{4}-\d{2}$/.test(season)) return res.status(400).json({ error: 'season=YYYY-YY is required' });
    const types = { regular: ['regular'], play_in: ['play_in'], playoffs: ['playoffs'], all: ['regular', 'play_in', 'playoffs'] }[req.query.season_type ?? 'regular'];
    if (!types) return res.status(400).json({ error: 'season_type must be regular, play_in, playoffs or all' });
    const { rows } = await db.query(
      `SELECT p.id AS player_id, p.full_name, count(*)::int AS gp,
              round(avg(s.minutes)::numeric, 1)::float8 AS minutes, round(avg(s.pts)::numeric, 1)::float8 AS pts,
              round(avg(s.reb)::numeric, 1)::float8 AS reb, round(avg(s.ast)::numeric, 1)::float8 AS ast
         FROM player_game_stats s JOIN games g ON g.id = s.game_id JOIN players p ON p.id = s.player_id
        WHERE s.team_id = $1 AND g.season = $2 AND g.season_type = ANY($3::text[]) AND g.status = 'final' AND NOT s.dnp
        GROUP BY p.id, p.full_name ORDER BY pts DESC NULLS LAST, gp DESC, p.full_name`, [Number(req.params.id), season, types]);
    res.json({ data: rows, meta: { season, season_type: req.query.season_type ?? 'regular', count: rows.length } });
  }));

  // Name search is accent/suffix/punctuation tolerant ("jokic", "cook", "pj").
  r.get('/players', wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const active = req.query.active !== 'false';
    const team = req.query.team;
    if (team !== undefined && !/^\d+$/.test(String(team))) return res.status(400).json({ error: 'team must be a team id' });
    const { rows } = await db.query(
      `SELECT p.id, p.full_name, p.listed_position, p.is_active, p.first_season_start, t.id AS team_id, t.abbreviation AS team
         FROM players p LEFT JOIN teams t ON t.id = p.current_team_id
        WHERE ($1::bool IS FALSE OR p.is_active) AND ($2::int IS NULL OR p.current_team_id = $2)
        ORDER BY p.is_active DESC, p.full_name`, [active, team === undefined ? null : Number(team)]);
    const hits = q ? rows.filter((p) => matchesSearch(p.full_name, q)) : rows;
    res.json({ data: hits.slice(0, SEARCH_CAP), meta: { total: hits.length, truncated: hits.length > SEARCH_CAP, active_only: active } });
  }));

  r.get('/players/:id', wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'player not found' });
    const { rows: [p] } = await db.query(
      `SELECT p.*, t.abbreviation AS team, t.full_name AS team_name FROM players p LEFT JOIN teams t ON t.id = p.current_team_id WHERE p.id = $1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'player not found' });
    const { rows: seasons } = await db.query(
      `SELECT DISTINCT g.season FROM player_game_stats s JOIN games g ON g.id = s.game_id WHERE s.player_id = $1 ORDER BY 1 DESC`, [p.id]);
    const { rows: [injury] } = await db.query(
      `SELECT status, description, reported_at, source FROM injury_reports WHERE player_id = $1 ORDER BY reported_at DESC LIMIT 1`, [p.id]);
    res.json({ data: { ...p, seasons: seasons.map((s) => s.season), current_injury: injury ?? null } });
  }));

  r.get('/games', wrap(async (req, res) => {
    const date = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
    const { rows } = await db.query(
      `SELECT g.id, g.season, g.season_type, g.cup_stage, g.game_date_local AS date, g.tipoff_utc, g.status,
              g.is_neutral_site, g.national_tv_tier, g.national_broadcasters,
              ht.abbreviation AS home, g.home_score, at.abbreviation AS away, g.away_score, a.name AS arena, a.city AS arena_city,
              ps.round AS series_round, g.series_game_number
         FROM games g JOIN teams ht ON ht.id = g.home_team_id JOIN teams at ON at.id = g.away_team_id
         LEFT JOIN arenas a ON a.id = g.arena_id LEFT JOIN playoff_series ps ON ps.id = g.playoff_series_id
        WHERE g.game_date_local = $1 ORDER BY g.tipoff_utc NULLS LAST, ht.abbreviation`, [date]);
    // Nearest game days either side, so the scoreboard can skip empty days
    // (offseason, All-Star break) instead of stepping one day at a time.
    const { rows: [nav] } = await db.query(
      `SELECT (SELECT max(game_date_local) FROM games WHERE game_date_local < $1)::text AS prev_date,
              (SELECT min(game_date_local) FROM games WHERE game_date_local > $1)::text AS next_date`, [date]);
    res.json({ data: rows, meta: { date, count: rows.length, prev_date: nav.prev_date, next_date: nav.next_date } });
  }));

  r.get('/games/:id', wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'game not found' });
    const { rows: [g] } = await db.query(
      `SELECT g.*, a.name AS arena, a.city AS arena_city, a.is_high_altitude FROM games g LEFT JOIN arenas a ON a.id = g.arena_id WHERE g.id = $1`, [req.params.id]);
    if (!g) return res.status(404).json({ error: 'game not found' });
    const { rows: teams } = await db.query(
      `SELECT tg.*, t.abbreviation, t.full_name FROM team_games tg JOIN teams t ON t.id = tg.team_id WHERE tg.game_id = $1
        ORDER BY (t.id = $2) DESC`, [g.id, g.away_team_id]);
    const { rows: players } = await db.query(
      `SELECT s.*, p.full_name FROM player_game_stats s JOIN players p ON p.id = s.player_id WHERE s.game_id = $1
        ORDER BY s.team_id, s.dnp, s.started DESC NULLS LAST, s.minutes DESC NULLS LAST`, [g.id]);
    res.json({ data: { game: g, teams: teams.map((t) => ({ ...t, players: players.filter((p) => p.team_id === t.team_id) })) } });
  }));

  return r;
}
