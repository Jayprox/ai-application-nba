// The Odds API -> prop_lines. Like the scores sync, it only attaches data to
// games the NBA.com schedule created, and it never creates players: a name it
// can't place safely is held for review (crosswalk manual_review) and its
// lines are skipped — a wrong player on a prop line is worse than no line.
import { matchPlayer, nameKey, suffixOf } from './names.js';
import { linesFromEvent, teamIdFor } from './odds-map.js';

const HOUR = 3600e3;

/** Our game -> The Odds API event id: crosswalk, else the (free) events list by teams + tip-off. */
async function eventFor(db, odds, game, teams, cache) {
  const { rows: [x] } = await db.query(
    `SELECT source_id FROM entity_id_crosswalk WHERE entity_type = 'game' AND source = 'odds_api' AND canonical_id = $1`, [game.id]);
  if (x) return { id: x.source_id };
  const tip = new Date(game.tipoff_utc).getTime();
  const k = new Date(tip).toISOString().slice(0, 10);
  if (!cache.has(k)) cache.set(k, (await odds.events(tip - 12 * HOUR, tip + 12 * HOUR)) ?? []);
  const hits = cache.get(k).filter((e) => {
    const h = teamIdFor(e.home_team, teams), a = teamIdFor(e.away_team, teams);
    const pair = (h === game.home_team_id && a === game.away_team_id) || (h === game.away_team_id && a === game.home_team_id);
    return pair && Math.abs(new Date(e.commence_time).getTime() - tip) <= 3 * HOUR;
  });
  if (hits.length !== 1) return { problem: hits.length ? 'several events match' : 'no Odds API event (lines not posted yet?)' };
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
                  VALUES ('game', $1, 'odds_api', $2, 'teams+tipoff') ON CONFLICT DO NOTHING`, [game.id, hits[0].id]);
  return { id: hits[0].id };
}

/** Names on the lines -> our players: manual resolutions, then the two teams' players, then a unique active name. */
async function resolveNames(db, game, names) {
  const out = new Map();
  const { rows: known } = await db.query(
    `SELECT source_id, canonical_id, match_status FROM entity_id_crosswalk
      WHERE entity_type = 'player' AND source = 'odds_api' AND source_id = ANY($1::text[])`, [names]);
  const byName = new Map(known.map((k) => [k.source_id, k]));
  const prev = `${Number(game.season.slice(0, 4)) - 1}-${game.season.slice(2, 4)}`;
  const { rows: pool } = await db.query(
    `SELECT DISTINCT p.id, p.full_name AS name FROM players p
      WHERE p.current_team_id = ANY($1::int[])
         OR p.id IN (SELECT s.player_id FROM player_game_stats s JOIN games g ON g.id = s.game_id
                      WHERE s.team_id = ANY($1::int[]) AND g.season IN ($2, $3))`, [[game.home_team_id, game.away_team_id], game.season, prev]);
  let everyone = null;
  for (const name of names) {
    const k = byName.get(name);
    if (k?.match_status === 'matched') { out.set(name, { playerId: k.canonical_id }); continue; }
    if (k) { out.set(name, { held: `waiting for review (${k.match_status})` }); continue; }
    let r = matchPlayer(name, pool);
    if (r.status === 'matched') { out.set(name, { playerId: r.id }); continue; }
    if (r.method === 'no_candidate') {
      everyone ??= (await db.query('SELECT id, full_name AS name FROM players WHERE is_active')).rows;
      let hits = everyone.filter((p) => nameKey(p.name) === nameKey(name));
      if (hits.length > 1) hits = hits.filter((p) => suffixOf(p.name) === suffixOf(name));
      if (hits.length === 1) { out.set(name, { playerId: hits[0].id }); continue; }
      r = { method: hits.length ? 'ambiguous_league' : 'no_candidate', candidates: hits.map((p) => p.name) };
    }
    await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_status, match_method)
                    VALUES ('player', 'unresolved', 'odds_api', $1, 'manual_review', $2) ON CONFLICT (entity_type, source, source_id) DO NOTHING`,
      [name, `${r.method}: ${name} ~ ${(r.candidates ?? []).slice(0, 5).join(' | ')} (${game.away_abbr}@${game.home_abbr})`]);
    out.set(name, { held: r.method });
  }
  return out;
}

/**
 * Pull one snapshot ('open' | 'close') for each game id.
 * @returns [{game, snapshot, lines, players, held: string[], problem?, credits}]
 */
export async function syncProps(db, odds, gameIds, snapshot, { now = new Date() } = {}) {
  if (!gameIds.length) return [];
  const { rows: teams } = await db.query('SELECT id, name, full_name FROM teams');
  const { rows: games } = await db.query(
    `SELECT g.id, g.season, g.tipoff_utc, g.home_team_id, g.away_team_id, h.abbreviation AS home_abbr, a.abbreviation AS away_abbr
       FROM games g JOIN teams h ON h.id = g.home_team_id JOIN teams a ON a.id = g.away_team_id WHERE g.id = ANY($1::uuid[])`, [gameIds]);
  const cache = new Map();
  const reports = [];
  for (const game of games) {
    const rep = { game: `${game.away_abbr}@${game.home_abbr}`, game_id: game.id, snapshot, lines: 0, players: 0, held: [], credits: 0 };
    reports.push(rep);
    const ev = await eventFor(db, odds, game, teams, cache);
    if (!ev.id) { rep.problem = ev.problem; continue; }
    const before = odds.quota.used;
    const lines = linesFromEvent(await odds.eventOdds(ev.id), odds.book);
    rep.credits = odds.quota.used !== null && before !== null ? odds.quota.used - before : (odds.quota.last ?? 0);
    const who = await resolveNames(db, game, [...new Set(lines.map((l) => l.name))]);
    const players = new Set();
    for (const l of lines) {
      const r = who.get(l.name);
      if (!r?.playerId) continue;
      await db.query(
        `INSERT INTO prop_lines (game_id, player_id, market, snapshot, book, line, over_price, under_price, book_updated_at, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (game_id, player_id, market, book, snapshot) DO UPDATE SET line = EXCLUDED.line, over_price = EXCLUDED.over_price,
           under_price = EXCLUDED.under_price, book_updated_at = EXCLUDED.book_updated_at, fetched_at = EXCLUDED.fetched_at`,
        [game.id, r.playerId, l.market, snapshot, odds.book, l.line, l.over_price, l.under_price, l.book_updated_at, now]);
      rep.lines++;
      players.add(r.playerId);
    }
    rep.players = players.size;
    rep.held = [...who].filter(([, r]) => r.held).map(([n, r]) => `${n} (${r.held})`);
    // Opening lines: done once the book has posted something (else the planner retries hourly).
    // Closing lines: one shot — tip-off is minutes away either way.
    if (rep.lines || snapshot === 'close') {
      await db.query(`UPDATE games SET ${snapshot === 'open' ? 'props_open_at' : 'props_close_at'} = $2 WHERE id = $1`, [game.id, now]);
    }
  }
  return reports;
}
