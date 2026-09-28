// Rankings + matchup insights (architecture.md §7.7):
//   GET /rankings/players?season=&season_type=&position=G|F|C&scope=season|last10&limit=
//   GET /rankings/teams?season=&season_type=&scope=
//   GET /rankings/matchups?season=&season_type=&scope=&team_id=
import { Router } from 'express';
import { matchups, playerRankings, POSITION_LABEL, POSITIONS, teamRankings, TYPES, Z_STATS } from '../query/rankings.js';

const SEASON = /^\d{4}-\d{2}$/;
const POSITION_NOTE = "Positions are NBA.com's listing (G / F / C; a hybrid like G-F counts as its first position), the player's current one applied to every season.";

export function rankingsRoutes(db) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  /** Shared params; null = a 400 was sent. */
  async function common(req, res) {
    const q = req.query;
    if (q.season !== undefined && !SEASON.test(String(q.season))) { res.status(400).json({ error: 'season must look like 2025-26' }); return null; }
    const seasonType = String(q.season_type ?? 'regular');
    if (!TYPES[seasonType]) { res.status(400).json({ error: `season_type must be one of ${Object.keys(TYPES).join(', ')}` }); return null; }
    const scope = String(q.scope ?? 'season');
    if (!['season', 'last10'].includes(scope)) { res.status(400).json({ error: 'scope must be season or last10' }); return null; }
    let season = q.season ? String(q.season) : null;
    if (!season) season = (await db.query(`SELECT max(season) s FROM games WHERE status = 'final' AND season_type = 'regular'`)).rows[0].s;
    return { season, seasonType, scope };
  }

  r.get('/rankings/players', wrap(async (req, res) => {
    const c = await common(req, res); if (!c) return;
    const position = String(req.query.position ?? 'G').toUpperCase();
    if (!POSITIONS.includes(position)) return res.status(400).json({ error: 'position must be G, F or C' });
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'limit must be an integer 1-200' });
    const out = c.season ? await playerRankings(db, { ...c, position }) : { data: [], qualifier: null };
    res.json({
      data: out.data.slice(0, limit),
      meta: {
        ...c, position, position_label: POSITION_LABEL[position], stats: Z_STATS, qualifier: out.qualifier, count: out.data.length,
        notes: [
          `Score = the average of how far above or below the ${POSITION_LABEL[position].toLowerCase()}' average he is (in standard deviations) in points, rebounds, assists, steals, blocks, 3PM, TS% and turnovers (fewer is better), each counting equally. 0 = an average qualified ${POSITION_LABEL[position].toLowerCase().replace(/s$/, '')}.`,
          ...(out.qualifier ? [`Qualifier: played in at least 70% of team games (${out.qualifier.min_games} of ${out.qualifier.team_games})${c.scope === 'last10' ? '; stats from his last 10 of them' : ''}.`] : []),
          POSITION_NOTE,
        ],
      },
    });
  }));

  r.get('/rankings/teams', wrap(async (req, res) => {
    const c = await common(req, res); if (!c) return;
    const out = c.season ? await teamRankings(db, c) : { data: [] };
    res.json({ data: out.data, meta: { ...c, notes: ['Ratings are points per 100 possessions, with possessions estimated from the box score (FGA − OREB + TOV + 0.44 × FTA), so they differ slightly from NBA.com\'s play-by-play numbers. Pace = estimated possessions per game.'] } });
  }));

  r.get('/rankings/matchups', wrap(async (req, res) => {
    const c = await common(req, res); if (!c) return;
    const teamId = req.query.team_id === undefined ? null : Number(req.query.team_id);
    if (teamId !== null && !Number.isInteger(teamId)) return res.status(400).json({ error: 'team_id must be a number' });
    const out = c.season ? await matchups(db, c) : null;
    const data = out ? Object.fromEntries(POSITIONS.map((p) => [p, teamId === null ? out[p] : out[p].filter((x) => x.team_id === teamId)])) : { G: [], F: [], C: [] };
    res.json({
      data,
      league_avg: out ? Object.fromEntries(POSITIONS.map((p) => [p, out[`${p}_avg`]])) : null,
      meta: {
        ...c, teams: out?.teams ?? 0, unlisted_share: out?.unlisted_share ?? 0,
        notes: [
          'Allowed = what opposing guards / forwards / centers put up per game against this team. Rank 1 = allows the fewest; the 5 lowest are marked strong, the 5 highest weak.',
          POSITION_NOTE,
          ...(out?.unlisted_share ? [`${(out.unlisted_share * 100).toFixed(1)}% of opponents' points came from players with no listed position and aren't counted.`] : []),
        ],
      },
    });
  }));

  return r;
}
