// End-to-end against a THROWAWAY Postgres: WORKER_TEST_DATABASE_URL must be a
// localhost database whose name contains "test" (the suite drops its schema).
// Skipped otherwise. Uses the real Highlightly dry-run files (MEM @ HOU,
// 2026-04-12, verified against NBA.com).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPool } from '../src/db.js';
import { createHighlightly } from '../src/highlightly.js';
import { loadBoxScore, syncDate } from '../src/sync.js';
import { createOdds } from '../src/odds.js';
import { syncProps } from '../src/props.js';

const url = process.env.WORKER_TEST_DATABASE_URL;
const safe = url && /^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) && /test/.test(new URL(url).pathname);
const skip = safe ? false : 'set WORKER_TEST_DATABASE_URL to a local *test* database';
let db, hl, gameId;
const HOU = 1, MEM = 2;

before(async () => {
  if (skip) return;
  db = createPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  await db.query(`INSERT INTO arenas (id, name, city, state) VALUES (1, 'Toyota Center', 'Houston', 'TX')`);
  await db.query(`INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division, home_arena_id) VALUES
    (${HOU}, 'HOU', 'Houston', 'Rockets', 'Houston Rockets', 'West', 'Southwest', 1),
    (${MEM}, 'MEM', 'Memphis', 'Grizzlies', 'Memphis Grizzlies', 'West', 'Southwest', NULL)`);
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('team', '${HOU}', 'highlightly', '28'), ('team', '${MEM}', 'highlightly', '42')`);
  const { rows: [g] } = await db.query(`INSERT INTO games (season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id, arena_id)
    VALUES ('2025-26', 'regular', '2026-04-12', '2026-04-13T00:30:00Z', ${HOU}, ${MEM}, 1) RETURNING id`);
  gameId = g.id;
  await db.query(`INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split, rest_days) VALUES ($1, ${HOU}, ${MEM}, 'home', 1), ($1, ${MEM}, ${HOU}, 'away', 1)`, [gameId]);
  // Players we "already know": matching must find them, including an accent/apostrophe variant.
  await db.query(`INSERT INTO players (full_name, current_team_id, is_active) VALUES
    ('Tari Eason', ${HOU}, true), ('Jae''Sean Tate', ${HOU}, true), ('Reed Sheppard', ${HOU}, true),
    ('Jeff Green', NULL, true), ('Jeff Green', NULL, true),          -- two active Jeff Greens: must NOT guess
    ('Cameron Spencer', NULL, false)                                 -- retired "Cameron" vs box-score "Cam": near-match
  `);
  // Tari Eason also played a game two days earlier (for his own rest days).
  const { rows: [prev] } = await db.query(`INSERT INTO games (season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id, status, home_score, away_score)
    VALUES ('2025-26', 'regular', '2026-04-10', '2026-04-11T00:00:00Z', ${MEM}, ${HOU}, 'final', 100, 110) RETURNING id`);
  await db.query(`INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split) VALUES ($1, ${HOU}, ${MEM}, 'away'), ($1, ${MEM}, ${HOU}, 'home')`, [prev.id]);
  await db.query(`INSERT INTO player_game_stats (game_id, player_id, team_id, minutes, pts, source)
    SELECT $1, id, ${HOU}, 30, 10, 'nba_stats' FROM players WHERE full_name = 'Tari Eason'`, [prev.id]);
  hl = createHighlightly({ fixtures: new URL('./fixtures', import.meta.url).pathname });
});
after(async () => { if (db) await db.end(); });

const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

test('scores + final + box score load; unknown players created, near-matches held', { skip }, async () => {
  const r = await syncDate(db, hl, '2026-04-12');
  assert.equal(r.matches, 15);
  assert.equal(r.unmatched.length, 14, 'only MEM/HOU is in this test schedule');
  assert.equal(r.boxes, 1);
  const g = await one('SELECT status, home_score, away_score, box_score_checks FROM games WHERE id = $1', [gameId]);
  assert.deepEqual(g, { status: 'final', home_score: 132, away_score: 101, box_score_checks: 1 });

  assert.deepEqual(r.held_players.map((h) => h.split(' (')[0]).sort(), ['Cam Spencer', 'Jeff Green']);
  assert.ok(r.created_players.includes('Amen Thompson'));        // DNP, nobody similar -> created
  assert.ok(!r.created_players.includes('Tari Eason'));
  assert.ok(!r.created_players.includes("Jae'Sean Tate"));
  assert.equal(r.player_rows, 22);                                 // 24 listed - 2 held

  const eason = await one(`SELECT s.pts, s.reb, s.started, s.dnp, s.source, s.player_rest_days FROM player_game_stats s JOIN players p ON p.id = s.player_id
    WHERE s.game_id = $1 AND p.full_name = 'Tari Eason'`, [gameId]);
  assert.deepEqual(eason, { pts: 20, reb: 8, started: true, dnp: false, source: 'highlightly', player_rest_days: 1 });
  const hou = await one('SELECT won, pts, minutes, plus_minus, reb FROM team_games WHERE game_id = $1 AND team_id = $2', [gameId, HOU]);
  assert.deepEqual({ ...hou, reb: hou.reb > 0 }, { won: true, pts: 132, minutes: 240, plus_minus: 31, reb: true });
  const review = await one(`SELECT count(*)::int n FROM entity_id_crosswalk WHERE entity_type = 'player' AND match_status = 'manual_review'`);
  assert.equal(review.n, 2);
});

test('re-running is a no-op until the 3-hour re-check; then the game is done', { skip }, async () => {
  const again = await syncDate(db, hl, '2026-04-12');
  assert.equal(again.boxes, 0);
  assert.equal(again.updated, 0);
  const later = await syncDate(db, hl, '2026-04-12', { now: new Date(Date.now() + 4 * 3600e3) });
  assert.equal(later.boxes, 1);
  const created = await one(`SELECT count(*)::int n FROM players WHERE full_name = 'Amen Thompson'`);
  assert.equal(created.n, 1, 'the second load reuses the crosswalk, no duplicate player');
  assert.equal((await one('SELECT box_score_checks FROM games WHERE id = $1', [gameId])).box_score_checks, 2);
  const last = await syncDate(db, hl, '2026-04-12', { now: new Date(Date.now() + 9 * 3600e3) });
  assert.equal(last.boxes, 0);
});

test('never overwrites NBA.com (reconciled) rows', { skip }, async () => {
  await db.query(`UPDATE player_game_stats SET source = 'nba_stats', plus_minus = 99 WHERE game_id = $1 AND player_id = (SELECT id FROM players WHERE full_name = 'Reed Sheppard')`, [gameId]);
  await db.query('UPDATE games SET box_score_checks = 0 WHERE id = $1', [gameId]);
  const m = JSON.parse(readFileSync(new URL('./fixtures/matches_2026-04-12.json', import.meta.url))).data.find((x) => x.id === 1439038);
  const game = await one('SELECT * FROM games WHERE id = $1', [gameId]);
  const teams = new Map([['28', HOU], ['42', MEM]]);
  const r = await loadBoxScore(db, hl, { game, match: m, teams });
  assert.equal(r.loaded, false);
  const pts = await one(`SELECT plus_minus AS pts FROM player_game_stats WHERE game_id = $1 AND player_id = (SELECT id FROM players WHERE full_name = 'Reed Sheppard')`, [gameId]);
  assert.equal(pts.pts, 99);
  assert.equal((await one('SELECT box_score_checks FROM games WHERE id = $1', [gameId])).box_score_checks, 2);
});

test('props: DraftKings lines attach to our game and players; unsafe names held, never guessed', { skip }, async () => {
  const odds = createOdds({ fixtures: new URL('./fixtures/odds', import.meta.url).pathname });
  const now = new Date('2026-04-13T00:00:00Z');
  const [r] = await syncProps(db, odds, [gameId], 'close', { now });
  assert.equal(r.game, 'MEM@HOU');
  assert.equal(r.lines, 4);                                   // Eason pts + PRA, Tate pts, Sheppard 3PM
  assert.equal(r.players, 3);
  assert.deepEqual(r.held.map((h) => h.split(' (')[0]).sort(), ['Cam Spencer', 'Jeff Green']);
  const { rows } = await db.query(`SELECT p.full_name, l.market, l.line::float8 AS line, l.over_price, l.under_price, l.snapshot, l.book
    FROM prop_lines l JOIN players p ON p.id = l.player_id WHERE l.game_id = $1 ORDER BY 1, 2`, [gameId]);
  assert.deepEqual(rows.map((x) => `${x.full_name} ${x.market} ${x.line} ${x.over_price}/${x.under_price}`), [
    "Jae'Sean Tate pts 6.5 -115/-105", 'Reed Sheppard fg3m 1.5 -140/110', 'Tari Eason pra 21.5 -115/-115', 'Tari Eason pts 12.5 -110/-120',
  ]);
  assert.ok(rows.every((x) => x.snapshot === 'close' && x.book === 'draftkings'));
  assert.ok((await one('SELECT props_close_at FROM games WHERE id = $1', [gameId])).props_close_at);
  assert.equal((await one(`SELECT source_id FROM entity_id_crosswalk WHERE entity_type = 'game' AND source = 'odds_api'`)).source_id, 'evt_memhou');
  const held = await one(`SELECT count(*)::int n FROM entity_id_crosswalk WHERE source = 'odds_api' AND match_status = 'manual_review'`);
  assert.equal(held.n, 2);

  // A human resolves "Jeff Green" -> the next pull uses it; re-pulling updates rows in place.
  const { rows: [jg] } = await db.query(`SELECT id FROM players WHERE full_name = 'Jeff Green' LIMIT 1`);
  await db.query(`UPDATE entity_id_crosswalk SET canonical_id = $1, match_status = 'matched' WHERE source = 'odds_api' AND source_id = 'Jeff Green'`, [jg.id]);
  const [again] = await syncProps(db, odds, [gameId], 'close', { now });
  assert.equal(again.lines, 5);
  assert.equal((await one('SELECT count(*)::int n FROM prop_lines WHERE game_id = $1', [gameId])).n, 5);
});

test('props: an opening pull with nothing posted is retried (no done marker)', { skip }, async () => {
  const odds = createOdds({ fixtures: new URL('./fixtures/odds', import.meta.url).pathname });
  odds.eventOdds = async () => ({ id: 'evt_memhou', bookmakers: [] });
  const [r] = await syncProps(db, odds, [gameId], 'open');
  assert.equal(r.lines, 0);
  assert.equal((await one('SELECT props_open_at FROM games WHERE id = $1', [gameId])).props_open_at, null);
});
