// HL weekly box-score catch-up (M6 T4). Recorded fixture: MEM @ HOU 2026-04-12 (Highlightly match 1439038).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { createWeeklyHighlightly } from '../src/hl-weekly-client.js';
import { runBackfillPass } from '../src/weekly-backfill.js';
import { addGame, connect, count, fingerprint, one, resetSchema, skip, T } from './helpers/db.js';
import { putMeta, putQuota, recorded, synthDir } from './helpers/fx.js';

let db, gameId;
before(async () => { if (!skip) db = await connect(); });
after(async () => { if (db) await db.end(); });

const NOW = new Date('2026-04-14T12:00:00Z');
const client = (dir, o = {}) => createWeeklyHighlightly({ fixtures: dir, now: () => 0, sleep: async () => {}, ...o });
const run = (hl, o = {}) => runBackfillPass(db, hl, { season: '2025-26', now: NOW, daysBack: 7, ...o });
const pgs = (name) => one(db, `SELECT s.minutes, s.plus_minus, s.pts, s.started, s.dnp, s.source, s.player_rest_days FROM player_game_stats s JOIN players p ON p.id = s.player_id WHERE s.game_id = $1 AND p.full_name = $2`, [gameId, name]);

beforeEach(async () => {
  if (skip) return;
  await resetSchema(db);
  gameId = await addGame(db, { home: 'HOU', away: 'MEM', local: '2026-04-12', tip: '2026-04-13T00:30:00Z', season: '2025-26', status: 'final', home_score: 132, away_score: 101, rest: [1, 1] });
  await db.query(`INSERT INTO players (full_name, current_team_id, is_active, listed_position) VALUES
    ('Tari Eason', ${T.HOU}, true, 'F'), ('Jae''Sean Tate', ${T.HOU}, true, 'F'), ('Reed Sheppard', ${T.HOU}, true, 'G'), ('Josh Okogie', ${T.HOU}, true, 'G-F'),
    ('Jeff Green', NULL, true, 'F'), ('Jeff Green', NULL, true, 'F'), ('Cameron Spencer', NULL, false, 'G')`);
  const prev = await addGame(db, { home: 'MEM', away: 'HOU', local: '2026-04-10', tip: '2026-04-11T00:00:00Z', season: '2025-26', status: 'final', home_score: 100, away_score: 110 });
  await db.query(`INSERT INTO player_game_stats (game_id, player_id, team_id, minutes, pts, source) SELECT $1, id, ${T.HOU}, 30, 10, 'nba_stats' FROM players WHERE full_name = 'Tari Eason'`, [prev]);
});

test('final game without a box score is loaded: Tate 26 min +11, Gibson 19 min -7 (recorded, NBA.com-verified), source highlightly', { skip }, async () => {
  const gamesBefore = await count(db, 'games');
  const hl = client(synthDir({}, { copyRecorded: true }));
  const r = await run(hl);
  assert.equal(r.counts.candidates, 1, 'the earlier game already has NBA.com rows (Tari Eason), so it is not a candidate');
  assert.equal(r.counts.games_loaded, 1);
  assert.equal(r.counts.rows, 22);                                          // 24 listed - 2 held
  const tate = await pgs("Jae'Sean Tate");
  assert.deepEqual([Number(tate.minutes), tate.plus_minus, tate.pts, tate.started, tate.source], [26, 11, 13, true, 'highlightly']);
  const gibson = await pgs('Taj Gibson');
  assert.deepEqual([Number(gibson.minutes), gibson.plus_minus, gibson.source], [19, -7, 'highlightly']);
  assert.equal((await pgs('Tari Eason')).player_rest_days, 1, 'his own rest recomputed from the game two days earlier');
  assert.deepEqual(r.lists.held.map((h) => h.split(' (')[0]).sort(), ['Cam Spencer', 'Jeff Green']);
  assert.equal((await one(db, 'SELECT box_score_checks FROM games WHERE id = $1', [gameId])).box_score_checks, 1);
  const hou = await one(db, 'SELECT won, pts, minutes, plus_minus FROM team_games WHERE game_id = $1 AND team_id = $2', [gameId, T.HOU]);
  assert.deepEqual(hou, { won: true, pts: 132, minutes: 240, plus_minus: 31 });
  assert.equal(await count(db, 'games'), gamesBefore, 'no game created (D14)');
  assert.equal(hl.stats.byEndpoint['box-score'], 1);
});

test('held near-matches are listed and nothing is written for them (never guessed)', { skip }, async () => {
  const r = await run(client(synthDir({}, { copyRecorded: true })));
  assert.equal(r.counts.held, 2);
  assert.equal(await count(db, 'entity_id_crosswalk', `entity_type = 'player' AND match_status = 'manual_review'`), 2);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${gameId}' AND source = 'highlightly'`), 22);
});

test('checks=1 is loaded again and ends at 2; then checks=2 costs zero box-score requests', { skip }, async () => {
  await db.query('UPDATE games SET box_score_checks = 1, box_score_synced_at = now() - interval \'5 hours\' WHERE id = $1', [gameId]);
  const dir = synthDir({}, { copyRecorded: true });
  const first = client(dir);
  const r = await run(first);
  assert.equal(r.counts.games_loaded, 1);
  assert.equal((await one(db, 'SELECT box_score_checks FROM games WHERE id = $1', [gameId])).box_score_checks, 2);
  const again = client(dir);
  const r2 = await run(again);
  assert.equal(r2.counts.candidates, 0);
  assert.equal(again.stats.total, 0, 'no request at all: nothing to fetch');
});

test('a game NBA.com already reconciled is not a candidate and its rows are untouched', { skip }, async () => {
  await db.query(`INSERT INTO player_game_stats (game_id, player_id, team_id, minutes, pts, plus_minus, source) SELECT $1, id, ${T.HOU}, 30, 10, 99, 'nba_stats' FROM players WHERE full_name = 'Reed Sheppard'`, [gameId]);
  const before = await fingerprint(db, 'player_game_stats', '1, 2');
  const hl = client(synthDir({}, { copyRecorded: true }));
  const r = await run(hl);
  assert.equal(r.counts.candidates, 0);
  assert.equal(hl.stats.total, 0);
  assert.equal(await fingerprint(db, 'player_game_stats', '1, 2'), before);
});

test('NBA.com rows appearing between fetch and write: that game is skipped, nothing overwritten', { skip }, async () => {
  const r = await run(client(synthDir({}, { copyRecorded: true })), { hooks: { afterFetch: () => db.query(`INSERT INTO player_game_stats (game_id, player_id, team_id, minutes, pts, plus_minus, source) SELECT $1, id, ${T.HOU}, 30, 10, 99, 'nba_stats' FROM players WHERE full_name = 'Reed Sheppard'`, [gameId]) } });
  assert.equal(r.counts.skipped_nba, 1);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${gameId}'`), 1);
});

test('a game changed by the worker between fetch and write is skipped (skipped_changed)', { skip }, async () => {
  const r = await run(client(synthDir({}, { copyRecorded: true })), { hooks: { afterFetch: () => db.query(`UPDATE games SET box_score_checks = 1, box_score_synced_at = now() WHERE id = $1`, [gameId]) } });
  assert.equal(r.counts.skipped_changed, 1);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${gameId}'`), 0);
});

test('box score not ready (404) -> not_ready, nothing written, checks unchanged', { skip }, async () => {
  const dir = synthDir({}, { copyRecorded: true });
  putMeta(dir, 'box-score_1439038', { status: 404 });
  const r = await run(client(dir));
  assert.equal(r.counts.not_ready, 1);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${gameId}'`), 0);
  assert.equal((await one(db, 'SELECT box_score_checks FROM games WHERE id = $1', [gameId])).box_score_checks, 0);
});

// A second synthetic final game (same box-score shape, other match id) on the next ET date.
async function twoGames() {
  const dir = synthDir({}, { copyRecorded: true });
  const day2 = { data: [{ ...recorded('matches_2026-04-12').data[0], id: 1439100, date: '2026-04-14T00:30:00.000Z' }], pagination: { totalCount: 1 } };
  writeFileSync(`${dir}/matches_2026-04-13.json`, JSON.stringify(day2));
  copyFileSync(`${dir}/box-score_1439038.json`, `${dir}/box-score_1439100.json`);
  copyFileSync(`${dir}/lineups_1439038.json`, `${dir}/lineups_1439100.json`);
  const g2 = await addGame(db, { home: 'HOU', away: 'MEM', local: '2026-04-13', tip: '2026-04-14T00:30:00Z', season: '2025-26', status: 'final', home_score: 120, away_score: 110 });
  return { dir, g2 };
}

test('request cap reached after the box score and before the lineups: the older game is complete, the cut-off game writes nothing', { skip }, async () => {
  const { dir, g2 } = await twoGames();
  const r = await run(client(dir, { budget: 5 }), { now: new Date('2026-04-14T12:00:00Z'), hooks: {} });
  assert.equal(r.stop, 'cap');
  assert.equal(r.counts.games_loaded, 1);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${gameId}' AND source = 'highlightly'`), 22);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${g2}'`), 0);
  assert.equal((await one(db, 'SELECT box_score_checks FROM games WHERE id = $1', [g2])).box_score_checks, 0);
});

test('quota reserve hit mid-run: same clean stop (stop=reserve)', { skip }, async () => {
  const { dir, g2 } = await twoGames();
  putQuota(dir, { limit: 7500, remaining: 1005 });                          // 5 calls leave 1000; the 6th would go below
  const r = await run(client(dir));
  assert.equal(r.stop, 'reserve');
  assert.equal(r.counts.games_loaded, 1);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${g2}'`), 0);
});

test('other games\' team_games and every players.listed_position (Okogie "PG" lineup label, Green "F") stay as they were', { skip }, async () => {
  const before = await fingerprint(db, 'team_games', '1, 2');
  const pos = async () => JSON.stringify((await db.query(`SELECT full_name, listed_position FROM players WHERE listed_position IS NOT NULL ORDER BY id`)).rows);
  const p0 = await pos();
  await run(client(synthDir({}, { copyRecorded: true })));
  assert.equal(await pos(), p0);
  const rows = (await db.query(`SELECT game_id, team_id, rest_days FROM team_games WHERE game_id <> $1 ORDER BY 1, 2`, [gameId])).rows;
  assert.equal(JSON.stringify(rows), JSON.stringify(JSON.parse(before).filter((x) => x.game_id !== gameId).map((x) => ({ game_id: x.game_id, team_id: x.team_id, rest_days: x.rest_days }))));
});

test('re-running loads the same rows again without duplicates (idempotent)', { skip }, async () => {
  const dir = synthDir({}, { copyRecorded: true });
  await run(client(dir));
  const rows1 = await fingerprint(db, 'player_game_stats', '1, 2');
  const players1 = await count(db, 'players');
  await run(client(dir));
  assert.equal(await count(db, 'players'), players1);
  assert.equal(await count(db, 'player_game_stats', `game_id = '${gameId}'`), 22);
  assert.equal(JSON.parse(rows1).length, 22 + 1);
});

test('dry run: counts are reported and the database is unchanged', { skip }, async () => {
  const tables = ['games', 'player_game_stats', 'team_games', 'players', 'entity_id_crosswalk'];
  const snap = []; for (const t of tables) snap.push(await fingerprint(db, t, '1, 2'));
  const r = await run(client(synthDir({}, { copyRecorded: true })), { dryRun: true });
  assert.equal(r.counts.games_loaded, 1);
  const after = []; for (const t of tables) after.push(await fingerprint(db, t, '1, 2'));
  assert.deepEqual(after, snap);
});
