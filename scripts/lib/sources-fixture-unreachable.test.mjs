// Fixture-mode simulation of a blocked NBA.com (synthetic, scripts/fixtures/nba/synthetic_unreachable).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEED_FIXTURES = new URL('../fixtures/nba/synthetic_unreachable', import.meta.url).pathname;
globalThis.fetch = () => { throw new Error('network used'); };
const src = await import('./sources.mjs');

test('without best-effort mode the unreachable marker is ignored (manual runs behave as before)', async () => {
  const log = await src.nbaGameLog('2026-27', 'Regular Season', 'T');          // missing fixture -> the usual empty result set
  assert.deepEqual(log.resultSets[0].rowSet, []);
});

test('best-effort + _nba_unreachable.json: every NBA.com call fails like a blocked host, no network', async () => {
  assert.equal(src.enableBestEffort({}), 'ok');
  await assert.rejects(src.nbaScheduleSeason('2026-27'), (e) => e.name === 'NbaUnavailable' && e.nbaKind === 'timeout');
  await assert.rejects(src.nbaGameLog('2026-27', 'Regular Season', 'T'), { name: 'NbaUnavailable' });
});
