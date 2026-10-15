// resolvePlayers: the auto-link rule for players who were inactive over the offseason.
// Needs a local *test* Postgres (same guard as sync.test.js).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPool } from '../src/db.js';
import { resolvePlayers } from '../src/players.js';

const url = process.env.WORKER_TEST_DATABASE_URL;
const safe = url && /^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) && /test/.test(new URL(url).pathname);
const skip = safe ? false : 'set WORKER_TEST_DATABASE_URL to a local *test* database';
let db;
const HOU = 1, MEM = 2;

before(async () => {
  if (skip) return;
  db = createPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  await db.query(`INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division) VALUES
    (${HOU}, 'HOU', 'Houston', 'Rockets', 'Houston Rockets', 'West', 'Southwest'),
    (${MEM}, 'MEM', 'Memphis', 'Grizzlies', 'Memphis Grizzlies', 'West', 'Southwest')`);
  await db.query(`INSERT INTO players (full_name, current_team_id, is_active) VALUES
    ('Zed Recent', NULL, false),     -- played last season: auto-link
    ('Old Timer', NULL, false),      -- last played 2023-24: hold
    ('Dup Name', NULL, false),       -- two with one name: hold
    ('Dup Name', NULL, false),
    ('Ghost Guy', NULL, false)       -- no stat rows at all: hold
  `);
  const mk = async (season, date) => {
    const { rows: [g] } = await db.query(`INSERT INTO games (season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id, status)
      VALUES ($1, 'regular', $2, $2::date + time '20:00', ${HOU}, ${MEM}, 'final') RETURNING id`, [season, date]);
    await db.query(`INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split) VALUES ($1, ${HOU}, ${MEM}, 'home'), ($1, ${MEM}, ${HOU}, 'away')`, [g.id]);
    return g.id;
  };
  const recent = await mk('2025-26', '2026-04-12');
  const old = await mk('2023-24', '2024-04-14');
  const stat = (gid, name) => db.query(`INSERT INTO player_game_stats (game_id, player_id, team_id, minutes, pts, source)
    SELECT $1, id, ${HOU}, 20, 8, 'nba_stats' FROM players WHERE full_name = $2`, [gid, name]);
  await stat(recent, 'Zed Recent');
  await stat(old, 'Old Timer');
  await stat(recent, 'Dup Name');
});
after(async () => { if (db) await db.end(); });

test('inactive player with a stat row in the last 2 seasons is auto-linked; everything else stays held', { skip }, async () => {
  const entries = [
    { hlId: '9001', name: 'Zed Recent' }, { hlId: '9002', name: 'Old Timer' },
    { hlId: '9003', name: 'Dup Name' }, { hlId: '9004', name: 'Ghost Guy' }];
  const who = await resolvePlayers(db, { teamId: HOU, season: '2026-27', entries });

  const zed = who.get('9001');
  assert.equal(zed.status, 'matched');
  assert.equal(zed.method, 'name+recent_inactive');
  assert.equal(zed.autolinked, true);
  const row = (await db.query(`SELECT current_team_id, is_active FROM players WHERE id = $1`, [zed.playerId])).rows[0];
  assert.deepEqual(row, { current_team_id: HOU, is_active: true });
  const xw = (await db.query(`SELECT match_status, match_method FROM entity_id_crosswalk WHERE source = 'highlightly' AND source_id = '9001'`)).rows[0];
  assert.deepEqual(xw, { match_status: 'matched', match_method: 'name+recent_inactive' });

  for (const id of ['9002', '9003', '9004']) assert.equal(who.get(id).status, 'held', `hl ${id} must stay held`);

  // A second call uses the crosswalk and does not re-link.
  const again = await resolvePlayers(db, { teamId: HOU, season: '2026-27', entries: [entries[0]] });
  assert.equal(again.get('9001').method, 'crosswalk');
});
