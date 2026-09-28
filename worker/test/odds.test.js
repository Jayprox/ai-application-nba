import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { implied, linesFromEvent, teamIdFor } from '../src/odds-map.js';
import { planProps } from '../src/planner.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/odds/event-odds_evt_memhou.json', import.meta.url)));

test('props: DraftKings only, both sides required, main line = the one priced closest to even', () => {
  const lines = linesFromEvent(fixture);
  const key = (l) => `${l.name}|${l.market}`;
  assert.deepEqual(lines.map(key).sort(), [
    "Cam Spencer|pts", "Jae'sean Tate|pts", 'Jeff Green|pts', 'Reed Sheppard|fg3m', 'Tari Eason|pra', 'Tari Eason|pts',
  ]);
  const eason = lines.find((l) => key(l) === 'Tari Eason|pts');
  // DK lists 12.5 (-110/-120) and 13.5 (+105/-135): 12.5 is the main line. FanDuel's 11.5 is ignored.
  assert.deepEqual(eason, { name: 'Tari Eason', market: 'pts', line: 12.5, over_price: -110, under_price: -120, book_updated_at: '2026-04-12T23:55:00Z' });
  assert.ok(!lines.some((l) => key(l) === 'Reed Sheppard|pts'), 'an Over with no Under is not a line');
  assert.deepEqual(linesFromEvent(fixture, 'betmgm'), []);
  assert.deepEqual(linesFromEvent(null), []);
});

test('props: implied probability from American odds', () => {
  assert.equal(implied(-110).toFixed(4), '0.5238');
  assert.equal(implied(150), 0.4);
});

test('props: team names -> ids by nickname (NBA.com says "LA Clippers", the book says "Los Angeles Clippers")', () => {
  const teams = [
    { id: 12, name: 'Clippers', full_name: 'LA Clippers' }, { id: 13, name: 'Lakers', full_name: 'Los Angeles Lakers' },
    { id: 24, name: 'Trail Blazers', full_name: 'Portland Trail Blazers' }, { id: 20, name: '76ers', full_name: 'Philadelphia 76ers' },
  ];
  assert.equal(teamIdFor('Los Angeles Clippers', teams), 12);
  assert.equal(teamIdFor('Los Angeles Lakers', teams), 13);
  assert.equal(teamIdFor('Portland Trail Blazers', teams), 24);
  assert.equal(teamIdFor('Philadelphia 76ers', teams), 20);
  assert.equal(teamIdFor('Las Vegas Aces', teams), null);
});

// ---- planner -----------------------------------------------------------------
const at = (iso) => new Date(iso);
const tip = '2026-11-11T00:30:00Z';                       // 7:30 pm ET, Nov 10
const g = (extra = {}) => ({ id: 'g1', tipoff_utc: tip, status: 'scheduled', season_type: 'regular', props_open_at: null, props_close_at: null, ...extra });
const st = (extra = {}) => ({ openTries: new Map(), quotaRemaining: 90000, ...extra });

test('props planner: opening line from 9 am ET on game day, not before', () => {
  assert.deepEqual(planProps(at('2026-11-10T13:30:00Z'), [g()], st()).open, []);        // 8:30 am ET
  assert.deepEqual(planProps(at('2026-11-10T14:05:00Z'), [g()], st()).open, ['g1']);    // 9:05 am ET
  assert.deepEqual(planProps(at('2026-11-09T20:00:00Z'), [g()], st()).open, [], 'the day before: no');
});

test('props planner: no lines posted yet -> retry hourly, and stop 90 min before tip', () => {
  const now = at('2026-11-10T16:00:00Z');
  assert.deepEqual(planProps(now, [g()], st({ openTries: new Map([['g1', now.getTime() - 30 * 60e3]]) })).open, []);
  assert.deepEqual(planProps(now, [g()], st({ openTries: new Map([['g1', now.getTime() - 61 * 60e3]]) })).open, ['g1']);
  assert.deepEqual(planProps(at('2026-11-10T23:10:00Z'), [g()], st()).open, [], 'inside 90 minutes');
  assert.deepEqual(planProps(now, [g({ props_open_at: '2026-11-10T14:05:00Z' })], st()).open, [], 'already have it');
});

test('props planner: closing line in the 35 minutes before tip, once', () => {
  assert.deepEqual(planProps(at('2026-11-10T23:50:00Z'), [g()], st()).close, []);
  const p = planProps(at('2026-11-11T00:00:00Z'), [g()], st());
  assert.deepEqual([p.open, p.close], [[], ['g1']]);
  assert.deepEqual(planProps(at('2026-11-11T00:31:00Z'), [g()], st()).close, [], 'after tip: too late');
  assert.deepEqual(planProps(at('2026-11-11T00:10:00Z'), [g({ props_close_at: '2026-11-11T00:00:00Z' })], st()).close, []);
  assert.deepEqual(planProps(at('2026-11-11T00:10:00Z'), [g({ status: 'postponed' })], st()).close, []);
});

test('props planner: preseason skipped; low quota -> closing lines only; nearly out -> nothing', () => {
  assert.deepEqual(planProps(at('2026-11-10T15:00:00Z'), [g({ season_type: 'preseason' })], st()).open, []);
  assert.deepEqual(planProps(at('2026-11-10T15:00:00Z'), [g()], st({ quotaRemaining: 800 })).open, []);
  assert.deepEqual(planProps(at('2026-11-11T00:00:00Z'), [g()], st({ quotaRemaining: 800 })).close, ['g1']);
  assert.deepEqual(planProps(at('2026-11-11T00:00:00Z'), [g()], st({ quotaRemaining: 100 })).close, []);
  assert.deepEqual(planProps(at('2026-11-10T15:00:00Z'), [g()], st({ quotaRemaining: null })).open, ['g1'], 'unknown quota (first run) is fine');
});
