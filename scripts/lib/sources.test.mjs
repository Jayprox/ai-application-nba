// Live-mode tests for sources.mjs with fetch stubbed (no network, no fixtures).
// Guards the bug from the first real seed run: fixture lookups ran even when
// SEED_FIXTURES was unset and crashed on path.join(undefined, …).
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEED_FIXTURES;
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), headers: opts?.headers ?? {} });
  return { ok: true, json: async () => ({ resultSets: [{ name: 'X', headers: ['A'], rowSet: [[1]] }], results: [], data: [] }) };
};
const src = await import('./sources.mjs');

test('live mode: every NBA.com / Highlightly / Open-Meteo fetcher hits the network', async () => {
  await src.nbaStandings('2025-26');
  await src.nbaAllPlayers('2025-26');
  await src.nbaRoster(1610612743, '2026-27');
  await src.nbaSchedule();
  await src.highlightlyMatches('2026-04-12', '00000000-0000-0000-0000-000000000000');
  await src.geocode('Denver', 'US');
  const hosts = calls.map((c) => new URL(c.url).host);
  assert.deepEqual(hosts, ['stats.nba.com', 'stats.nba.com', 'stats.nba.com', 'cdn.nba.com', 'nba.highlightly.net', 'geocoding-api.open-meteo.com']);
});

test('NBA.com requests carry browser-style headers (stats.nba.com hangs without them)', () => {
  const nba = calls.find((c) => c.url.includes('stats.nba.com'));
  assert.match(nba.headers['User-Agent'], /Mozilla/);
  assert.equal(nba.headers.Referer, 'https://www.nba.com/');
});

test('Highlightly key routing: UUID key -> direct host; RapidAPI key -> RapidAPI host + host header', async () => {
  await src.highlightlyMatches('2026-04-12', 'abcmshxyz');
  const last = calls.at(-1);
  assert.equal(new URL(last.url).host, 'nba-ncaab-api.p.rapidapi.com');
  assert.equal(last.headers['x-rapidapi-host'], 'nba-ncaab-api.p.rapidapi.com');
});
