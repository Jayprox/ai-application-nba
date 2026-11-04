// NBA.com best-effort mode in sources.mjs (M6): one probe, one attempt, then a process-wide "down" latch.
// Separate file from sources.test.mjs because the mode is module state. fetch is stubbed: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEED_FIXTURES;
const fetches = [];
let behaviour = () => new Promise(() => {});
globalThis.fetch = (url, opts) => {
  fetches.push({ url: String(url) });
  return new Promise((resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    Promise.resolve(behaviour(url, opts)).then(resolve, reject);
  });
};
const src = await import('./sources.mjs');

test('manual mode (no flag) is untouched: 3 attempts', async () => {
  behaviour = () => ({ ok: false, status: 500, json: async () => ({}) });
  fetches.length = 0;
  await assert.rejects(src.nbaAllPlayers('2025-26'), /failed after 3 attempts/);
  assert.equal(fetches.length, 3);
});

test('best effort: the first call is a single probe that times out at the injected limit (1 fetch), then 0 fetches', async () => {
  assert.equal(src.enableBestEffort({}, { headerMs: 30, bodyMs: 30 }), 'ok');
  behaviour = () => new Promise(() => {});           // never answers; only the abort ends it
  fetches.length = 0;
  await assert.rejects(src.nbaStandings('2025-26'), (e) => e.name === 'NbaUnavailable' && e.nbaKind === 'timeout' && e.message === 'stats.nba.com unreachable (timeout)');
  assert.equal(fetches.length, 1);
  for (const f of [() => src.nbaAllPlayers('x'), () => src.nbaPlayerIndex('x'), () => src.nbaGameLog('x', 'Regular Season', 'T')]) {
    await assert.rejects(f(), { name: 'NbaUnavailable' });
  }
  assert.equal(fetches.length, 1, 'later calls never reach the network once down');
  assert.ok(src.nbaDownKind());
});

test('best effort: 403 is "HTTP 403 blocked"; the message has the host but no body, headers or query', async () => {
  src.enableBestEffort({}, { headerMs: 1000, bodyMs: 1000 });
  behaviour = () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'Access Denied <html>secret-body</html>' });
  fetches.length = 0;
  await assert.rejects(src.nbaStandings('2025-26'), (e) => {
    assert.equal(e.nbaKind, 'HTTP 403 blocked');
    assert.ok(e.message.includes('stats.nba.com'));
    assert.ok(!/Access Denied|secret-body|Season=|LeagueID|\?/.test(e.message));
    return true;
  });
  assert.equal(fetches.length, 1);
});

test('best effort: a non-JSON body is "malformed response" and latches down', async () => {
  src.enableBestEffort({}, { headerMs: 1000, bodyMs: 1000 });
  behaviour = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  await assert.rejects(src.nbaStandings('2025-26'), (e) => e.nbaKind === 'malformed response');
  await assert.rejects(src.nbaStandings('2025-26'), { name: 'NbaUnavailable' });
});

test('best effort: after a success a later failure gets 2 attempts, then latches', async () => {
  src.enableBestEffort({}, { headerMs: 1000, bodyMs: 1000 });
  behaviour = () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
  assert.deepEqual(await src.nbaStandings('2025-26'), { ok: 1 });
  behaviour = () => ({ ok: false, status: 502, json: async () => ({}) });
  fetches.length = 0;
  await assert.rejects(src.nbaAllPlayers('2025-26'), (e) => e.nbaKind === 'HTTP 502');
  assert.equal(fetches.length, 2);
});

test('WEEKLY_NBA=0 and WEEKLY_NBA_STATE=down: no request at all', async () => {
  fetches.length = 0;
  assert.equal(src.enableBestEffort({ WEEKLY_NBA: '0' }), 'disabled');
  await assert.rejects(src.nbaStandings('2025-26'), (e) => e.nbaKind === 'disabled');
  assert.equal(src.enableBestEffort({ WEEKLY_NBA_STATE: 'down' }), 'down');
  await assert.rejects(src.nbaPlayerIndex('2025-26'), { name: 'NbaUnavailable' });
  assert.equal(fetches.length, 0);
});

test('NBA.com request pacing and browser headers are unchanged in best-effort mode', async () => {
  src.enableBestEffort({}, { headerMs: 1000, bodyMs: 1000 });
  let seen;
  globalThis.fetch = async (url, opts) => { seen = opts.headers; return { ok: true, status: 200, json: async () => ({}) }; };
  await src.nbaStandings('2025-26');
  assert.match(seen['User-Agent'], /Mozilla/);
  assert.equal(seen.Referer, 'https://www.nba.com/');
});
