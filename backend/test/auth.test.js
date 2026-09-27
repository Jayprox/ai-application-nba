import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { createApiKey } from '../src/auth.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());
const post = (path, body, headers = {}) => fetch(s.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health is public; everything else needs a credential', async () => {
  assert.equal((await fetch(s.base + '/health')).status, 200);
  assert.equal((await fetch(s.base + '/teams')).status, 401);
  assert.equal((await post('/query', { scope: 'season' })).status, 401);
  assert.equal((await fetch(s.base + '/teams', { headers: { authorization: 'Bearer garbage' } })).status, 401);
});

test('login: good password works, bad password and unknown user look the same', async () => {
  assert.ok(s.login.access_token && s.login.refresh_token);
  const bad = await post('/login', { username: s.username, password: 'wrong-password' });
  const unknown = await post('/login', { username: 'nobody_here', password: 'wrong-password' });
  assert.equal(bad.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(await bad.json(), await unknown.json());
  assert.equal((await post('/login', {})).status, 400);
});

test('refresh rotates; replaying an old refresh token revokes EVERY session', async () => {
  const other = await (await post('/login', { username: s.username, password: s.password })).json(); // second session
  const r1 = await post('/refresh', { refresh_token: s.login.refresh_token });
  assert.equal(r1.status, 200);
  const rotated = await r1.json();
  assert.notEqual(rotated.refresh_token, s.login.refresh_token);
  const replay = await post('/refresh', { refresh_token: s.login.refresh_token }); // stolen copy used again
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, 'refresh_token_reused');
  assert.equal((await post('/refresh', { refresh_token: rotated.refresh_token })).status, 401, 'the new token is revoked too');
  assert.equal((await post('/refresh', { refresh_token: other.refresh_token })).status, 401, 'and the other session');
});

test('logout revokes the refresh token', async () => {
  const t = await (await post('/login', { username: s.username, password: s.password })).json();
  assert.equal((await post('/logout', { refresh_token: t.refresh_token })).status, 204);
  assert.equal((await post('/refresh', { refresh_token: t.refresh_token })).status, 401);
});

test('API key (agents) reaches the same API; revoked key is rejected', async () => {
  const key = await createApiKey(s.db, 'test_agent');
  const ok = await fetch(s.base + '/teams', { headers: { 'x-api-key': key } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.length, 30);
  await s.db.query("UPDATE api_keys SET revoked_at = now() WHERE name = 'test_agent'");
  assert.equal((await fetch(s.base + '/teams', { headers: { 'x-api-key': key } })).status, 401);
});

test('CORS is an allow-list, not *', async () => {
  const r = await fetch(s.base + '/health', { headers: { origin: 'https://evil.example' } });
  assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('malformed JSON body -> 400, not 500', async () => {
  const r = await fetch(s.base + '/query', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.login.access_token}` }, body: '{nope' });
  assert.equal(r.status, 400);
});

test('security headers on every API response', async () => {
  const r = await fetch(s.base + '/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-powered-by'), null);
});

// Keep this LAST in the file: it locks this test user out for 15 minutes.
test('brute force: 10 wrong passwords for one account -> 429 (even for the right password), other accounts unaffected', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post('/login', { username: s.username, password: `guess-${i}` })).status, 401);
  const locked = await post('/login', { username: s.username, password: s.password });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await post('/login', { username: 'someone_else', password: 'x' })).status, 401, 'a different account is not locked');
  assert.equal((await post('/login', { username: 'a'.repeat(101), password: 'x' })).status, 400);
});
