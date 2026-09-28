// Player props: DraftKings lines (The Odds API, pulled by the worker) next to
// what actually happened. Hit rates are counts over real games — no model.
//   GET /props?date=YYYY-MM-DD&market=pts   the board for one ET date
//   GET /players/:id/props                  his next game's lines + his record vs past lines
import { Router } from 'express';
import { grade, MARKET_LABEL, marketValue, MARKETS } from '../query/markets.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ['regular', 'cup_final', 'play_in', 'playoffs'];
const STAT_COLS = 'pts, reb, ast, fg3m, stl, blk, tov';
export const etToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
const prevSeason = (s) => `${Number(s.slice(0, 4)) - 1}-${s.slice(2, 4)}`;

/** Over/under/push of `line` across box-score rows (pure; unit-tested). */
export function hitRate(rows, market, line) {
  const out = { over: 0, under: 0, push: 0, games: 0, avg: null };
  let sum = 0;
  for (const r of rows) {
    const v = marketValue(r, market);
    if (v == null) continue;
    out[grade(v, line)]++; out.games++; sum += v;
  }
  if (out.games) out.avg = Math.round((sum / out.games) * 10) / 10;
  return out;
}

export function propsRoutes(db) {
  const r = Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  r.get('/props', wrap(async (req, res) => {
    const market = String(req.query.market ?? 'pts');
    if (!MARKETS.includes(market)) return res.status(400).json({ error: `market must be one of ${MARKETS.join(', ')}` });
    if (req.query.date !== undefined && !DATE.test(String(req.query.date))) return res.status(400).json({ error: 'date must look like 2026-10-21' });
    const today = etToday();
    let date = req.query.date ? String(req.query.date) : null;
    if (!date) {   // today if it has lines, else the next date that does, else the latest one, else today
      const { rows: [d] } = await db.query(
        `SELECT coalesce(
           (SELECT min(g.game_date_local) FROM prop_lines l JOIN games g ON g.id = l.game_id WHERE g.game_date_local >= $1 AND g.season_type = ANY($2::text[])),
           (SELECT max(g.game_date_local) FROM prop_lines l JOIN games g ON g.id = l.game_id WHERE g.season_type = ANY($2::text[])))::text AS d`, [today, TYPES]);
      date = d.d ?? today;
    }
    const { rows: [nav] } = await db.query(
      `SELECT (SELECT max(g.game_date_local) FROM prop_lines l JOIN games g ON g.id = l.game_id WHERE g.game_date_local < $1 AND g.season_type = ANY($2::text[]))::text AS prev_date,
              (SELECT min(g.game_date_local) FROM prop_lines l JOIN games g ON g.id = l.game_id WHERE g.game_date_local > $1 AND g.season_type = ANY($2::text[]))::text AS next_date`, [date, TYPES]);
    const { rows: games } = await db.query(
      `SELECT g.id, g.season, g.season_type, g.tipoff_utc, g.status, g.home_score, g.away_score, g.props_open_at, g.props_close_at,
              h.id AS home_id, h.abbreviation AS home, a.id AS away_id, a.abbreviation AS away
         FROM games g JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
        WHERE g.game_date_local = $1 AND g.season_type = ANY($2::text[]) ORDER BY g.tipoff_utc, h.abbreviation`, [date, TYPES]);
    const byGame = new Map(games.map((g) => [g.id, g]));
    const { rows: lines } = await db.query(
      `SELECT l.game_id, l.player_id, p.full_name AS name, p.current_team_id, l.line::float8 AS line, l.over_price, l.under_price, l.snapshot, l.fetched_at,
              o.line::float8 AS open_line, s.team_id AS played_for, s.dnp, ${STAT_COLS.split(', ').map((c) => `s.${c}`).join(', ')}
         FROM (SELECT DISTINCT ON (game_id, player_id) * FROM prop_lines
                WHERE market = $2 AND book = 'draftkings' AND game_id = ANY($1::uuid[])
                ORDER BY game_id, player_id, (snapshot = 'close') DESC) l
         JOIN players p ON p.id = l.player_id
         LEFT JOIN prop_lines o ON o.game_id = l.game_id AND o.player_id = l.player_id AND o.market = $2 AND o.book = l.book AND o.snapshot = 'open'
         LEFT JOIN player_game_stats s ON s.game_id = l.game_id AND s.player_id = l.player_id`, [games.map((g) => g.id), market]);

    // His games before this date (this season + last), newest first: last 10 and season hit rates at THIS line.
    const season = games[0]?.season;
    const history = new Map();
    if (lines.length) {
      const { rows } = await db.query(
        `SELECT s.player_id, s.team_id, g.season, ${STAT_COLS.split(', ').map((c) => `s.${c}`).join(', ')}
           FROM player_game_stats s JOIN games g ON g.id = s.game_id
          WHERE s.player_id = ANY($1::uuid[]) AND NOT s.dnp AND g.status = 'final' AND g.season_type = ANY($2::text[])
            AND g.game_date_local < $3 AND g.season IN ($4, $5)
          ORDER BY g.game_date_local DESC`, [[...new Set(lines.map((l) => l.player_id))], TYPES, date, season, prevSeason(season)]);
      for (const x of rows) { if (!history.has(x.player_id)) history.set(x.player_id, []); history.get(x.player_id).push(x); }
    }

    const data = lines.map((l) => {
      const g = byGame.get(l.game_id);
      const past = history.get(l.player_id) ?? [];
      const teamId = l.played_for ?? ([g.home_id, g.away_id].includes(l.current_team_id) ? l.current_team_id : past[0]?.team_id ?? null);
      const home = teamId === g.home_id;
      const played = l.dnp === false;
      const actual = played ? marketValue(l, market) : null;
      const thisSeason = past.filter((x) => x.season === season);
      return {
        game_id: l.game_id, player_id: l.player_id, name: l.name,
        team: teamId === g.home_id ? g.home : teamId === g.away_id ? g.away : null,
        opponent: teamId == null ? null : home ? g.away : g.home, venue: teamId == null ? null : home ? 'home' : 'away',
        line: l.line, over_price: l.over_price, under_price: l.under_price, snapshot: l.snapshot, fetched_at: l.fetched_at, open_line: l.open_line,
        actual, result: g.status !== 'final' ? null : played ? grade(actual, l.line) : 'dnp',   // not in the box score = no action
        last10: hitRate(past.slice(0, 10), market, l.line),
        season: hitRate(thisSeason, market, l.line),
        ...(thisSeason.length < 10 ? { last_season: hitRate(past.filter((x) => x.season !== season), market, l.line) } : {}),
      };
    });
    res.json({
      data,
      games: games.map((g) => ({ id: g.id, tipoff_utc: g.tipoff_utc, status: g.status, home: g.home, away: g.away, home_score: g.home_score, away_score: g.away_score,
        season_type: g.season_type, lines: data.filter((x) => x.game_id === g.id).length, open_pulled: !!g.props_open_at, close_pulled: !!g.props_close_at })),
      meta: {
        date, market, market_label: MARKET_LABEL[market], markets: MARKETS.map((m) => [m, MARKET_LABEL[m]]), season: season ?? null,
        prev_date: nav.prev_date, next_date: nav.next_date, book: 'DraftKings', count: data.length,
        notes: [
          'Lines: DraftKings via The Odds API — the closing line (~30 min before tip) once pulled, the opening line (morning) until then.',
          'Hit rates count his real games before this date at this exact line; a push is an exact whole-number line; DNPs are not counted.',
        ],
      },
    });
  }));

  r.get('/players/:id/props', wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'player not found' });
    const id = req.params.id;
    const { rows: [p] } = await db.query('SELECT id, full_name FROM players WHERE id = $1', [id]);
    if (!p) return res.status(404).json({ error: 'player not found' });
    // Next game with lines that hasn't finished (today's slate, or the live game).
    const { rows: [next] } = await db.query(
      `SELECT g.id, g.game_date_local::text AS date, g.tipoff_utc, g.status, h.abbreviation AS home, a.abbreviation AS away
         FROM games g JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id
        WHERE g.status IN ('scheduled', 'live') AND EXISTS (SELECT 1 FROM prop_lines l WHERE l.game_id = g.id AND l.player_id = $1)
        ORDER BY g.tipoff_utc LIMIT 1`, [id]);
    let upcoming = null;
    if (next) {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (l.market) l.market, l.line::float8 AS line, l.over_price, l.under_price, l.snapshot, l.fetched_at,
                (SELECT o.line::float8 FROM prop_lines o WHERE o.game_id = l.game_id AND o.player_id = l.player_id AND o.market = l.market AND o.snapshot = 'open') AS open_line
           FROM prop_lines l WHERE l.game_id = $1 AND l.player_id = $2 AND l.book = 'draftkings'
          ORDER BY l.market, (l.snapshot = 'close') DESC`, [next.id, id]);
      rows.sort((a, b) => MARKETS.indexOf(a.market) - MARKETS.indexOf(b.market));
      upcoming = { game: next, lines: rows.map((x) => ({ ...x, label: MARKET_LABEL[x.market] })) };
    }
    // His record against the lines we have for finished games (closing line where pulled).
    const { rows: graded } = await db.query(
      `SELECT DISTINCT ON (l.game_id, l.market) l.market, l.line::float8 AS line, s.dnp, ${STAT_COLS.split(', ').map((c) => `s.${c}`).join(', ')}
         FROM prop_lines l JOIN games g ON g.id = l.game_id AND g.status = 'final'
         JOIN player_game_stats s ON s.game_id = l.game_id AND s.player_id = l.player_id
        WHERE l.player_id = $1 AND l.book = 'draftkings'
        ORDER BY l.game_id, l.market, (l.snapshot = 'close') DESC`, [id]);
    const record = {};
    for (const x of graded) {
      if (x.dnp) continue;
      const k = (record[x.market] ??= { label: MARKET_LABEL[x.market], over: 0, under: 0, push: 0, games: 0 });
      k[grade(marketValue(x, x.market), x.line)]++; k.games++;
    }
    res.json({ data: { upcoming, record }, meta: { player: p.full_name, book: 'DraftKings' } });
  }));

  return r;
}
