// League-wide views: standings and the playoff/play-in bracket.
import { Router } from 'express';

const SEASON = /^\d{4}-\d{2}$/;

/** Postseason format by season: play-in exists from 2020-21 (2019-20 bubble had its own 8v9). */
export function formatOf(season) {
  if (season >= '2020-21') return { playoff_seeds: 6, play_in_seeds: [7, 8, 9, 10] };
  if (season === '2019-20') return { playoff_seeds: 7, play_in_seeds: [8, 9] };
  return { playoff_seeds: 8, play_in_seeds: [] };
}

/**
 * Team rows -> standings for one conference. Pure (unit-tested): W-L, home/road
 * (neutral sites count for neither, like NBA.com), conference record, last 10,
 * streak, games back. Rank = NBA.com's official rank when its W-L matches ours
 * (tiebreakers are the NBA's call), otherwise win% (flagged rank_source='computed').
 */
export function buildStandings(teams, games, official) {
  const out = teams.map((t) => {
    const mine = games.filter((g) => g.team_id === t.id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const rec = (list) => { const w = list.filter((g) => g.won).length; return { w, l: list.length - w }; };
    const all = rec(mine);
    let streak = null;
    if (mine.length) {
      const last = mine.at(-1).won;
      let n = 0;
      for (let i = mine.length - 1; i >= 0 && mine[i].won === last; i--) n++;
      streak = `${last ? 'W' : 'L'} ${n}`;
    }
    const fmt = (r) => `${r.w}-${r.l}`;
    const off = official.get(t.id);
    return {
      team_id: t.id, abbreviation: t.abbreviation, name: t.full_name, conference: t.conference, division: t.division,
      wins: all.w, losses: all.l, pct: mine.length ? Math.round((all.w / mine.length) * 1000) / 1000 : null,
      home: fmt(rec(mine.filter((g) => g.venue === 'home'))), road: fmt(rec(mine.filter((g) => g.venue === 'away'))),
      conf: fmt(rec(mine.filter((g) => g.opp_conference === t.conference))),
      last10: fmt(rec(mine.slice(-10))), streak,
      official: off && off.wins === all.w && off.losses === all.l ? off : null,
    };
  });
  const byPct = (a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.wins - a.wins || a.name.localeCompare(b.name);
  const rows = [...out].sort((a, b) =>
    a.official && b.official ? a.official.conference_rank - b.official.conference_rank : byPct(a, b));
  const leader = rows[0];
  return rows.map((r, i) => ({
    ...r,
    rank: r.official ? r.official.conference_rank : i + 1,
    rank_source: r.official ? 'nba_stats' : 'computed',
    clinch: r.official?.clinch ?? null,
    gb: leader ? ((leader.wins - r.wins) + (r.losses - leader.losses)) / 2 : null,
    official: undefined,
  }));
}

export function leagueRoutes(db) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  async function seasonFrom(req, res) {
    const q = req.query.season;
    if (q !== undefined && !SEASON.test(String(q))) { res.status(400).json({ error: 'season must look like 2025-26' }); return null; }
    if (q) return String(q);
    const { rows: [x] } = await db.query(`SELECT max(season) s FROM games WHERE status = 'final' AND season_type = 'regular'`);
    return x.s;
  }

  r.get('/standings', wrap(async (req, res) => {
    const season = await seasonFrom(req, res);
    if (!season) return res.headersSent ? undefined : res.json({ data: { East: [], West: [] }, meta: { season: null } });
    const { rows: teams } = await db.query('SELECT id, abbreviation, full_name, conference, division FROM teams');
    const { rows: games } = await db.query(
      `SELECT tg.team_id, tg.won, tg.venue_split AS venue, g.game_date_local AS date, ot.conference AS opp_conference
         FROM team_games tg JOIN games g ON g.id = tg.game_id JOIN teams ot ON ot.id = tg.opponent_team_id
        WHERE g.season = $1 AND g.season_type = 'regular' AND g.status = 'final' AND tg.won IS NOT NULL`, [season]);
    const { rows: off } = await db.query('SELECT * FROM team_seasons WHERE season = $1', [season]);
    const official = new Map(off.map((o) => [o.team_id, o]));
    const data = Object.fromEntries(['East', 'West'].map((c) => [c, buildStandings(teams.filter((t) => t.conference === c), games, official)]));
    const computed = [...data.East, ...data.West].filter((t) => t.rank_source === 'computed').length;
    res.json({
      data,
      meta: {
        season, games: games.length / 2, format: formatOf(season),
        notes: [
          'Home/road leave out neutral-site games, as NBA.com does.',
          ...(computed ? [`${computed} team(s) ranked by win % until NBA.com's official standings (with tiebreakers) are synced (npm run db:standings).`] : []),
        ],
      },
    });
  }));

  r.get('/bracket', wrap(async (req, res) => {
    const season = await seasonFrom(req, res);
    if (!season) return res.headersSent ? undefined : res.json({ data: [], meta: { season: null } });
    const { rows } = await db.query(
      `SELECT ps.id, ps.round, ps.conference, ps.bracket_slot, ps.best_of, ps.higher_seed, ps.lower_seed,
              ht.id AS higher_id, ht.abbreviation AS higher_abbr, ht.full_name AS higher_name,
              lt.id AS lower_id, lt.abbreviation AS lower_abbr, lt.full_name AS lower_name, ps.winner_team_id,
              count(*) FILTER (WHERE tg.team_id = ps.higher_seed_team_id AND tg.won)::int AS higher_wins,
              count(*) FILTER (WHERE tg.team_id = ps.lower_seed_team_id AND tg.won)::int AS lower_wins,
              min(g.game_date_local)::text AS first_game, max(g.game_date_local)::text AS last_game
         FROM playoff_series ps
         LEFT JOIN teams ht ON ht.id = ps.higher_seed_team_id LEFT JOIN teams lt ON lt.id = ps.lower_seed_team_id
         LEFT JOIN games g ON g.playoff_series_id = ps.id AND g.status = 'final'
         LEFT JOIN team_games tg ON tg.game_id = g.id
        WHERE ps.season = $1
        GROUP BY ps.id, ht.id, lt.id ORDER BY ps.id`, [season]);
    res.json({ data: rows, meta: { season, format: formatOf(season), count: rows.length } });
  }));

  return r;
}
