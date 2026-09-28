// Test harness: real Postgres (TEST_DATABASE_URL, else DATABASE_URL), real HTTP.
// Auth tests create a throwaway "test_*" user + API key and delete them after.
import { randomBytes } from 'node:crypto';
import { createPool } from '../src/db.js';
import { createApp } from '../src/server.js';
import { hashPassword } from '../src/auth.js';

process.env.JWT_SECRET ??= randomBytes(32).toString('hex');

export async function startServer({ cache, llm } = {}) {
  const db = createPool(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
  const memCache = cache ?? memoryCache();
  const app = createApp({ db, cache: memCache, llm, corsOrigins: ['http://localhost:5173'] });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const username = `test_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, await hashPassword(password)]);
  const login = await (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).json();
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access_token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const query = (q) => api('POST', '/query', q);
  const close = async () => {
    await db.query("DELETE FROM api_keys WHERE name LIKE 'test\\_%'");
    await db.query('DELETE FROM users WHERE username = $1', [username]); // refresh tokens cascade
    await new Promise((r) => server.close(r));
    await db.end();
  };
  return { db, base, api, query, username, password, login, close, cache: memCache };
}

export function memoryCache() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; }, async set(k, v) { m.set(k, structuredClone(v)); }, async close() {}, size: () => m.size };
}

export async function playerId(db, name) {
  const { rows } = await db.query('SELECT id FROM players WHERE full_name = $1', [name]);
  if (rows.length !== 1) throw new Error(`expected exactly one player "${name}", found ${rows.length}`);
  return rows[0].id;
}
export async function seasonLoaded(db, season) {
  const { rows: [r] } = await db.query('SELECT count(*)::int n FROM games WHERE season = $1 AND status = $2', [season, 'final']);
  return r.n > 0;
}
