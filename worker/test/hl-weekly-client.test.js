// Guarded Highlightly client (M6 T1). No network: fixtures and stub fetches only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyHighlightly, BudgetStop, HighlightlyAuthError, HighlightlyUnavailable, HighlightlyMalformed, retryAfterMs } from '../src/hl-weekly-client.js';
import { synthDir, putMeta, putQuota, REC } from './helpers/fx.js';

const KEY = 'test-key-DO-NOT-LOG-0123456789';
const fakeClock = () => { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms; clock.slept.push(ms); }, slept: [] }; };
let clock;
const mk = (o = {}) => { clock = fakeClock(); return createWeeklyHighlightly({ fixtures: REC, now: clock.now, sleep: clock.sleep, ...o }); };
const resp = (status, body = '{}', headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => body });

test('counts requests per endpoint (matches, box-score, lineups)', async () => {
  const hl = mk();
  await hl.matches('2026-04-12'); await hl.boxScore(1439038); await hl.lineups(1439038);
  assert.deepEqual(hl.stats.byEndpoint, { matches: 1, 'box-score': 1, lineups: 1, other: 0 });
  assert.equal(hl.stats.total, 3);
});

test('quota headers: present -> remaining known; absent or garbage -> unknown, logged once', async () => {
  const logs = [];
  let n = 0;
  const hl = mk({ fetchImpl: async () => resp(200, '{"data":[]}', n++ === 0 ? { 'x-ratelimit-requests-remaining': '7410', 'x-ratelimit-requests-limit': '7500' } : { 'x-ratelimit-requests-remaining': '-3' }), log: (m) => logs.push(m) });
  await hl.matches('2026-04-12');
  assert.deepEqual([hl.stats.remaining, hl.stats.limit], [7410, 7500]);
  await hl.matches('2026-04-13'); await hl.matches('2026-04-14');
  assert.equal(hl.stats.remaining, 7410, 'garbage header is ignored, last good value kept');
  assert.equal(logs.filter((l) => /quota unknown/.test(l)).length, 1);
  const none = mk({ fetchImpl: async () => resp(200, '{"data":[]}'), log: (m) => logs.push(m) });
  await none.matches('2026-04-12');
  assert.equal(none.stats.remaining, null);
});

test('cap: stops BEFORE the request that would exceed it (cap 3, 5 dates)', async () => {
  const hl = mk({ budget: 3 });
  const dates = ['2026-04-12', '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16'];
  const done = [];
  await assert.rejects(async () => { for (const d of dates) { await hl.matches(d); done.push(d); } }, (e) => e instanceof BudgetStop && e.stop === 'cap');
  assert.equal(done.length, 3);
  assert.equal(hl.stats.total, 3);
  await assert.rejects(hl.boxScore(1), (e) => e.stop === 'cap', 'stop is latched');
  assert.equal(hl.stats.total, 3);
});

test('reserve: remaining read from headers; stops when the next call would go below the reserve', async () => {
  const dir = synthDir({}, { copyRecorded: true }); putQuota(dir, { limit: 7500, remaining: 1003 });
  clock = fakeClock();
  const hl = createWeeklyHighlightly({ fixtures: dir, now: clock.now, sleep: clock.sleep });
  let calls = 0;
  await assert.rejects(async () => { for (;;) { await hl.matches('2026-04-12'); calls++; } }, (e) => e.stop === 'reserve');
  assert.equal(calls, 3);                       // headers 1002, 1001, 1000; a 4th call would leave 999 < 1000
  assert.equal(hl.stats.remaining, 1000);
});

test('reserve also applies from the last remaining handed over by the previous step', async () => {
  const hl = mk({ lastRemaining: 1000 });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e.stop === 'reserve');
  assert.equal(hl.stats.total, 0);
});

test('pacing: requests start at least 250 ms apart (4 req/s)', async () => {
  const hl = mk();
  await hl.matches('2026-04-12'); await hl.matches('2026-04-12'); await hl.matches('2026-04-12');
  assert.equal(clock.slept.length, 2);
  assert.ok(clock.slept.every((ms) => ms === 250));
});

test('429 with Retry-After: 2 waits 2 s then succeeds; the retry counts', async () => {
  let n = 0;
  const hl = mk({ fetchImpl: async () => (n++ === 0 ? resp(429, '{}', { 'retry-after': '2' }) : resp(200, '{"data":[]}')) });
  assert.deepEqual(await hl.matches('2026-04-12'), []);
  assert.ok(clock.slept.includes(2000));
  assert.equal(hl.stats.total, 2);
});

test('429 four times -> rate_limited stop (no endless retry)', async () => {
  const hl = mk({ fetchImpl: async () => resp(429, '{}', { 'retry-after': '1' }) });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e.stop === 'rate_limited');
  assert.equal(hl.stats.total, 4);
  assert.equal(hl.stats.stop, 'rate_limited');
});

test('Retry-After as an HTTP date; each wait is capped at 30 s', async () => {
  const t0 = 1_000_000;
  assert.equal(retryAfterMs(new Date(t0 + 5000).toUTCString(), t0 - (t0 % 1000)) >= 4000, true);
  assert.equal(retryAfterMs('garbage', t0), null);
  let n = 0;
  const hl = mk({ fetchImpl: async () => (n++ === 0 ? resp(429, '{}', { 'retry-after': '3600' }) : resp(200, '{"data":[]}')) });
  await hl.matches('2026-04-12');
  assert.ok(clock.slept.includes(30000) && !clock.slept.includes(3600000));
});

test('401 and 403 -> auth error straight away, one request, no retry', async () => {
  for (const st of [401, 403]) {
    const hl = mk({ fetchImpl: async () => resp(st, `{"message":"${KEY}"}`) });
    await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyAuthError && e.message === `highlightly auth rejected (${st})`);
    assert.equal(hl.stats.total, 1);
  }
});

test('500 three times -> unavailable after 3 requests (back-off 1 s then 3 s)', async () => {
  const hl = mk({ fetchImpl: async () => resp(503) });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyUnavailable && /HTTP 503/.test(e.message));
  assert.equal(hl.stats.total, 3);
  assert.deepEqual(clock.slept.filter((ms) => ms >= 1000), [1000, 3000]);
});

test('timeout (the request never answers) -> unavailable (timeout)', async () => {
  const hl = mk({ fetchImpl: () => new Promise(() => {}), timeoutMs: 15, backoffMs: [1, 1] });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyUnavailable && /timeout/.test(e.message));
  assert.equal(hl.stats.total, 3);
});

test('network error -> unavailable (network); error text never carries the cause', async () => {
  const hl = mk({ key: KEY, fetchImpl: async () => { throw new Error(`connect failed with ${KEY}`); } });
  await assert.rejects(hl.matches('2026-04-12'), (e) => { assert.ok(!e.message.includes(KEY)); return /network/.test(e.message); });
});

test('non-JSON body, a body over 5 MB and a missing data array -> malformed', async () => {
  for (const body of ['<html>nope</html>', 'x'.repeat(5 * 1024 * 1024 + 1), '{"nodata":1}']) {
    const hl = mk({ fetchImpl: async () => resp(200, body) });
    await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyMalformed);
  }
});

test('404 -> null for box score (not ready) and [] for a date with nothing', async () => {
  const hl = mk();
  assert.equal(await hl.boxScore(999), null);
  assert.deepEqual(await hl.matches('2030-01-01'), []);
});

test('a paginated day (100 + 12 = 112 matches) is read in full', async () => {
  const hl = createWeeklyHighlightly({ fixtures: new URL('./fixtures/weekly/synthetic_paginated', import.meta.url).pathname, now: () => 0, sleep: async () => {} });
  const out = await hl.matches('2026-11-05');
  assert.equal(out.length, 112);
  assert.equal(hl.stats.byEndpoint.matches, 2);
});

test('a page that fails halfway throws (the date is not half-counted)', async () => {
  const dir = synthDir({}, { copyRecorded: true });
  const page1 = { data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), pagination: { totalCount: 150 } };
  const fs = await import('node:fs'); fs.writeFileSync(`${dir}/matches_2026-12-01.json`, JSON.stringify(page1));
  putMeta(dir, 'matches_2026-12-01@100', { status: 500 });
  const hl = createWeeklyHighlightly({ fixtures: dir, now: () => 0, sleep: async () => {}, backoffMs: [0, 0] });
  await assert.rejects(hl.matches('2026-12-01'), HighlightlyUnavailable);
});

test('RapidAPI key goes to the RapidAPI host; a direct key to nba.highlightly.net (stub, no network)', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return resp(200, '{"data":[]}'); };
  try {
    for (const key of ['abcmshxyz', '00000000-0000-0000-0000-000000000000']) {
      const hl = createWeeklyHighlightly({ key, fixtures: '', now: () => 0, sleep: async () => {} });
      await hl.matches('2026-04-12');
    }
  } finally { globalThis.fetch = orig; }
  assert.equal(new URL(seen[0].url).host, 'nba-ncaab-api.p.rapidapi.com');
  assert.equal(seen[0].init.headers['x-rapidapi-host'], 'nba-ncaab-api.p.rapidapi.com');
  assert.equal(new URL(seen[1].url).host, 'nba.highlightly.net');
});

test('fixture mode never calls globalThis.fetch', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try { const hl = mk(); await hl.matches('2026-04-12'); await hl.boxScore(1439038); } finally { globalThis.fetch = orig; }
});

test('the key never appears in errors or log lines, even when the stub echoes it', async () => {
  const logs = [];
  const orig = globalThis.fetch;
  const modes = [() => resp(401, KEY), () => resp(500, KEY), () => resp(200, KEY), () => resp(429, KEY, { 'retry-after': '1' })];
  try {
    for (const m of modes) {
      globalThis.fetch = async () => m();
      const hl = createWeeklyHighlightly({ key: KEY, fixtures: '', now: () => 0, sleep: async () => {}, log: (x) => logs.push(x), backoffMs: [0, 0] });
      try { await hl.matches('2026-04-12'); } catch (e) { logs.push(e.message, e.reason, String(e.stack ?? '').split('\n')[0]); }
    }
  } finally { globalThis.fetch = orig; }
  assert.ok(logs.length > 0);
  for (const l of logs) assert.ok(!String(l).includes(KEY), l);
});

test('a match id that is not a positive integer is refused before any request', async () => {
  const hl = mk();
  for (const bad of ['1; DROP', -1, 1.5, '12', null]) assert.throws(() => hl.boxScore(bad));
  assert.equal(hl.stats.total, 0);
});

test('without a key and without fixtures the client refuses to start', () => {
  assert.throws(() => createWeeklyHighlightly({ fixtures: '' }), /HIGHLIGHTLY_API_KEY is not set/);
});

// ---- C2: the timeout covers the body, and the size limit is enforced while streaming
const streamRes = (chunks, { onCancel } = {}) => {
  let i = 0;
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => { throw new Error('text() must not be used for a stream'); },
    body: { getReader: () => ({ read: async () => (i < chunks.length || chunks === Infinity ? { done: false, value: chunks[i++] ?? new Uint8Array(1024 * 1024) } : { done: true }), cancel: async () => { onCancel?.(); } }) } };
};

test('a body that stalls after the headers hits the timeout (text path) and is retried then unavailable', async () => {
  const hl = mk({ fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) }), timeoutMs: 15, backoffMs: [1, 1] });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyUnavailable && /timeout/.test(e.message));
  assert.equal(hl.stats.total, 3);
});

test('a streamed body that stalls midway hits the timeout too', async () => {
  const enc = new TextEncoder();
  const stalled = () => ({ status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => { let n = 0; return { read: () => (n++ === 0 ? Promise.resolve({ done: false, value: enc.encode('{"data":[') }) : new Promise(() => {})), cancel: async () => {} }; } } });
  const hl = mk({ fetchImpl: async () => stalled(), timeoutMs: 15, backoffMs: [1, 1] });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyUnavailable && /timeout/.test(e.message));
});

test('an endless streamed body is cut at the size limit (stops reading, cancels, malformed)', async () => {
  let cancelled = false, reads = 0;
  const res = { status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(1024 * 1024) }; }, cancel: async () => { cancelled = true; } }) } };
  const hl = mk({ fetchImpl: async () => res, maxBody: 5 * 1024 * 1024 });
  await assert.rejects(hl.matches('2026-04-12'), (e) => e instanceof HighlightlyMalformed && /too large/.test(e.message));
  assert.ok(cancelled);
  assert.ok(reads <= 6, `read ${reads} MB before stopping`);
  assert.equal(hl.stats.total, 1, 'not retried, counted once');
});

test('a streamed JSON body within the limit is parsed', async () => {
  const enc = new TextEncoder();
  const hl = mk({ fetchImpl: async () => streamRes([enc.encode('{"data":'), enc.encode('[]}')]) });
  assert.deepEqual(await hl.matches('2026-04-12'), []);
});
