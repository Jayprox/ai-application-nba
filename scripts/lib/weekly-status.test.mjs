import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyStatusLine } from './weekly-status.mjs';

const hl = (status, d) => ({ source: 'highlightly', status, details: { weekly_run_id: 'r1', ...d } });
const nba = (status) => ({ source: 'nba_stats', status, details: { weekly_run_id: 'r1' } });

test('no weekly rows', () => assert.equal(weeklyStatusLine([]), '  weekly: no weekly run recorded yet'));

test('clean run: both sources, not degraded, requests summed, last quota shown', () => {
  const line = weeklyStatusLine([nba('success'), hl('success', { nba_state: 'ok', requests: { total: 71 }, quota: { remaining: 7429, limit: 7500 } }),
    hl('success', { nba_state: 'ok', requests: { total: 10 }, quota: { remaining: 7419, limit: 7500 } })]);
  assert.equal(line, '  weekly: r1 source=highlightly+nba_stats degraded=no (nba=ok) hl_requests=81 quota=7419/7500');
});

test('NBA.com down: highlightly only, degraded, nba=down', () => {
  const line = weeklyStatusLine([hl('success', { nba_state: 'down', requests: { total: 5 }, quota: { remaining: 7000, limit: 7500 } })]);
  assert.equal(line, '  weekly: r1 source=highlightly degraded=yes (nba=down) hl_requests=5 quota=7000/7500');
});

test('reserve stop is shown and counts as degraded; a failed NBA.com row means nba=down', () => {
  const line = weeklyStatusLine([nba('failed'), hl('success', { requests: { total: 2 }, quota: { remaining: 1000, limit: 7500 }, stop: 'reserve' })]);
  assert.equal(line, '  weekly: r1 source=highlightly degraded=yes (nba=down; stop=reserve) hl_requests=2 quota=1000/7500');
});

test('missing quota -> unknown', () => {
  assert.match(weeklyStatusLine([hl('success', { nba_state: 'disabled', requests: { total: 0 }, quota: { remaining: null, limit: null } })]), /nba=disabled\) hl_requests=0 quota=unknown$/);
});
