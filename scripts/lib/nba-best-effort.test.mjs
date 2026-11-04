import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, weeklyLine, nbaSeasonComplete, nbaStartState, SKIPPED, SKIP_ALLOWLIST, skipMessage } from './nba-best-effort.mjs';

const pgErr = (code) => Object.assign(new Error('relation "x" does not exist'), { severity: 'ERROR', code });

test('NBA-side problems are warnings (exit 0, degraded); database errors are failures', () => {
  const unreachable = Object.assign(new Error('stats.nba.com unreachable (timeout)'), { name: 'NbaUnavailable', nbaKind: 'timeout' });
  assert.deepEqual(classifyError(unreachable), { kind: 'warn', nba: 'down', reason: 'nba.com unreachable: timeout' });
  assert.equal(classifyError(Object.assign(new Error('x'), { name: 'NbaUnavailable', nbaKind: 'HTTP 403 blocked' })).reason, 'nba.com unreachable: HTTP 403 blocked');
  assert.equal(classifyError(new TypeError("Cannot read properties of undefined (reading 'gameDates')")).kind, 'warn');
  assert.equal(classifyError(new SyntaxError('bad')).kind, 'warn');
  assert.equal(classifyError(new Error('checks failed:\n    - standings 10-2, loaded 9-3')).kind, 'warn');
  assert.equal(classifyError(new Error('only 0 teams have regular-season games')).kind, 'warn', 'NBA.com answered with an empty schedule');
  assert.equal(classifyError(new Error('game 0022600001: unknown team id 1610612999')).kind, 'warn');
  assert.deepEqual(classifyError(pgErr('42P01')), { kind: 'fail', nba: 'ok', reason: 'database error (42P01)' });
  assert.equal(classifyError(pgErr('55P03')).reason, 'database error (55P03)');
  assert.equal(classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).kind, 'fail');
  assert.equal(classifyError(new Error('expected 30 seeded teams, found 0')).kind, 'fail');
});

test('result line: allowlisted skipped names only, reason on one line, valid JSON', () => {
  const line = weeklyLine({ step: 'schedule:nba', degraded: true, nba: 'down', skipped: [...SKIPPED['schedule:nba'], 'nba:evil', 'rm -rf'], reason: 'a\nb "c"' });
  assert.match(line, /^@@WEEKLY \{/);
  const j = JSON.parse(line.slice(8));
  assert.deepEqual(j.skipped, SKIPPED['schedule:nba']);
  assert.equal(j.reason, 'a b "c"');
  assert.deepEqual([j.v, j.step, j.degraded, j.nba, j.stop], [1, 'schedule:nba', true, 'down', null]);
  assert.ok(line.split('\n').length === 1);
});

test('every step has a fixed skipped list inside the allowlist', () => {
  for (const [step, list] of Object.entries(SKIPPED)) { assert.ok(list.length); for (const s of list) assert.ok(SKIP_ALLOWLIST.has(s), step); }
});

test('nbaSeasonComplete: zero team rows while the database holds final games -> not complete', () => {
  assert.equal(nbaSeasonComplete({ dbFinalGames: 120, teamLogRows: 0 }), false);
  assert.equal(nbaSeasonComplete({ dbFinalGames: 0, teamLogRows: 0 }), true);      // a new season with nothing played yet
  assert.equal(nbaSeasonComplete({ dbFinalGames: 120, teamLogRows: 240 }), true);
});

test('start state from the env the runner sets', () => {
  assert.equal(nbaStartState({}), 'ok');
  assert.equal(nbaStartState({ WEEKLY_NBA: '0' }), 'disabled');
  assert.equal(nbaStartState({ WEEKLY_NBA_STATE: 'down' }), 'down');
  assert.equal(nbaStartState({ WEEKLY_NBA: '0', WEEKLY_NBA_STATE: 'down' }), 'disabled');
  assert.match(skipMessage('disabled'), /disabled by config/);
  assert.match(skipMessage('down'), /unreachable earlier in this run/);
});
