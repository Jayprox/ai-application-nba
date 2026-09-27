import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/planner.js';

const at = (iso) => new Date(iso);
const fresh = { lastPollAt: null, lastDailyEt: '2026-11-10', quotaRemaining: 7000 };
const game = (tip, status = 'scheduled', extra = {}) => ({ tipoff_utc: tip, status, box_score_checks: 0, box_score_synced_at: null, ...extra });

test('quiet: nothing in window and daily sweep done -> no work', () => {
  const p = plan(at('2026-11-10T18:00:00Z'), [game('2026-11-11T00:30:00Z')], fresh);
  assert.deepEqual(p.dates, []);
});

test('game window opens 10 minutes before tip-off; polls that ET date', () => {
  const g = [game('2026-11-11T00:30:00Z')];   // 7:30 pm ET on Nov 10
  assert.deepEqual(plan(at('2026-11-11T00:15:00Z'), g, fresh).dates, []);
  assert.deepEqual(plan(at('2026-11-11T00:25:00Z'), g, fresh).dates, ['2026-11-10']);
});

test('every 5 minutes while live; every 30 when the quota is low', () => {
  const g = [game('2026-11-11T00:30:00Z', 'live')];
  const now = at('2026-11-11T01:30:00Z');
  const polled = (minsAgo, quota) => plan(now, g, { ...fresh, lastPollAt: now.getTime() - minsAgo * 60e3, quotaRemaining: quota }).dates.length > 0;
  assert.equal(polled(3, 7000), false);
  assert.equal(polled(5, 7000), true);
  assert.equal(polled(10, 400), false);
  assert.equal(polled(30, 400), true);
});

test('box score re-check ~3h after the first load, then never again', () => {
  const now = at('2026-11-11T07:00:00Z');
  const loaded = (hAgo, checks) => [game('2026-11-11T00:30:00Z', 'final', { box_score_checks: checks, box_score_synced_at: new Date(now - hAgo * 3600e3).toISOString() })];
  assert.deepEqual(plan(now, loaded(2, 1), fresh).dates, []);
  assert.deepEqual(plan(now, loaded(3, 1), fresh).dates, ['2026-11-10']);
  assert.deepEqual(plan(now, loaded(9, 2), fresh).dates, []);
});

test('daily sweep after 6 am ET: yesterday + today + past games still not final', () => {
  const stale = game('2026-11-08T00:30:00Z');   // Nov 7 ET, never went final
  const p = plan(at('2026-11-11T12:00:00Z'), [stale], { ...fresh, lastDailyEt: '2026-11-10' });
  assert.equal(p.daily, true);
  assert.deepEqual(p.dates, ['2026-11-07', '2026-11-10', '2026-11-11']);
  assert.equal(plan(at('2026-11-11T09:00:00Z'), [], { ...fresh, lastDailyEt: '2026-11-10' }).daily, false);  // 4 am ET
});
