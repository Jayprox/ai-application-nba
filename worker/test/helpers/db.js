// Throwaway-database helpers for the weekly tests. Same safety rule as sync.test.js: the URL must be a
// localhost database whose name contains "test" (the suite drops and recreates schema public).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import '../../src/db.js';                                   // registers the DATE parser

export const url = process.env.WORKER_TEST_DATABASE_URL;
export const safe = Boolean(url && /^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname) && /test/.test(new URL(url).pathname));
export const skip = safe ? false : 'set WORKER_TEST_DATABASE_URL to a local *test* database';

// canonical id, abbreviation, city, name, Highlightly id
export const TEAMS = [
  [1, 'HOU', 'Houston', 'Rockets', 28], [2, 'MEM', 'Memphis', 'Grizzlies', 42], [3, 'LAL', 'Los Angeles', 'Lakers', 4], [4, 'GSW', 'Golden State', 'Warriors', 43],
  [5, 'DEN', 'Denver', 'Nuggets', 3], [6, 'UTA', 'Utah', 'Jazz', 45], [7, 'OKC', 'Oklahoma City', 'Thunder', 38], [8, 'NOP', 'New Orleans', 'Pelicans', 64],
];
export const T = Object.fromEntries(TEAMS.map(([id, ab]) => [ab, id]));

export async function connect() {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  return db;
}

export async function resetSchema(db) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8'));
  await db.query(`INSERT INTO arenas (id, name, city, state) VALUES (1, 'Toyota Center', 'Houston', 'TX'), (2, 'Crypto.com Arena', 'Los Angeles', 'CA')`);
  for (const [id, ab, city, name, hl] of TEAMS) {
    await db.query(`INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division) VALUES ($1, $2, $3, $4, $5, 'West', 'Southwest')`, [id, ab, city, name, `${city} ${name}`]);
    await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('team', $1, 'highlightly', $2), ('team', $1, 'nba_stats', $3)`, [String(id), String(hl), String(1610612700 + id)]);
  }
}

/** Insert a game with its two team_games rows. `over` overrides games columns. Returns the game id. */
export async function addGame(db, { home, away, local, tip, status = 'scheduled', season = '2026-27', type = 'regular', rest = [null, null], b2b = [null, null], ...over }) {
  const cols = { season, season_type: type, game_date_local: local, tipoff_utc: tip, home_team_id: T[home], away_team_id: T[away], status, ...over };
  const keys = Object.keys(cols);
  const { rows: [g] } = await db.query(`INSERT INTO games (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => cols[k]));
  await db.query(`INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split, rest_days, b2b_night)
                  VALUES ($1, $2, $3, 'home', $4, $5), ($1, $3, $2, 'away', $6, $7)`, [g.id, T[home], T[away], rest[0], b2b[0], rest[1], b2b[1]]);
  return g.id;
}

export const one = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
export const count = async (db, table, where = 'true') => (await one(db, `SELECT count(*)::int n FROM ${table} WHERE ${where}`)).n;
/** Whole-table fingerprint, to prove "nothing changed". */
export const fingerprint = async (db, table, order = '1') => JSON.stringify((await db.query(`SELECT t.*, t.xmin::text AS _x FROM ${table} t ORDER BY ${order}`)).rows);
