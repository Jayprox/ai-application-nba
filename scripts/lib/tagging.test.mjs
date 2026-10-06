// Every case is a real NBA.com schedule/game-log situation found while
// designing the backfill (2026-09-26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonTypeFromGameId, scheduleStatus, isNeutralSite, nationalTvTier, cupStage, localGameDate, restTags, buildSeries } from './tagging.mjs';

test('schedule loader never writes live/final (no scores in the schedule; the 2026-10-05 weekly failure)', () => {
  assert.equal(scheduleStatus({ gameStatus: 3, gameStatusText: 'Final' }), 'scheduled');
  assert.equal(scheduleStatus({ gameStatus: 2 }), 'scheduled');
  assert.equal(scheduleStatus({ gameStatus: 1 }), 'scheduled');
  assert.equal(scheduleStatus({ gameStatus: 1, postponedStatus: 'Y' }), 'postponed');
});

test('season type from game-id prefix; preseason and All-Star are not loaded', () => {
  assert.equal(seasonTypeFromGameId('0022500002'), 'regular');
  assert.equal(seasonTypeFromGameId('0040300151'), 'playoffs');
  assert.equal(seasonTypeFromGameId('0052000101'), 'play_in');
  assert.equal(seasonTypeFromGameId('0062400001'), 'cup_final');
  assert.equal(seasonTypeFromGameId('0012600009'), null);
  assert.equal(seasonTypeFromGameId('0032300001'), null);
});

test('neutral: NBA.com flag, international, bubble, Las Vegas', () => {
  assert.ok(isNeutralSite({ isNeutral: true, arenaState: 'NV' }, '2024-25', '2024-12-17'));
  assert.ok(isNeutralSite({ arenaName: 'Saitama Super Arena', arenaCity: 'Tokyo', arenaState: '' }, '2003-04', '2003-11-01'));
  assert.ok(isNeutralSite({ arenaName: 'Arena CDMX', arenaCity: 'Mexico City, Mexico', arenaState: '' }, '2018-19', '2018-12-13'));
  assert.ok(isNeutralSite({ arenaName: 'Accor Arena', arenaCity: 'Paris', arenaState: 'FR' }, '2019-20', '2020-01-24'));
  assert.ok(isNeutralSite({ arenaName: 'AdventHealth Arena', arenaCity: 'Orlando', arenaState: 'FL' }, '2019-20', '2020-08-17'));
  assert.ok(isNeutralSite({ arenaName: 'T-Mobile Arena', arenaCity: 'Las Vegas', arenaState: 'NV' }, '2023-24', '2023-12-07'));
});

test('not neutral: normal home games and alternate home venues', () => {
  assert.ok(!isNeutralSite({ arenaName: 'Amway Center', arenaCity: 'Orlando', arenaState: 'FL' }, '2019-20', '2020-01-15')); // Magic, pre-bubble
  assert.ok(!isNeutralSite({ arenaName: 'Moody Center', arenaCity: 'Austin', arenaState: 'TX' }, '2024-25', '2025-01-10')); // Spurs alt home
  assert.ok(!isNeutralSite({ arenaName: 'Amalie Arena', arenaCity: 'Tampa', arenaState: 'FL' }, '2020-21', '2021-01-01')); // Raptors in Tampa
  assert.ok(!isNeutralSite({ arenaName: 'Ford Center', arenaCity: 'Oklahoma City', arenaState: 'OK' }, '2005-06', '2005-11-01')); // Hornets post-Katrina
  assert.ok(!isNeutralSite({ arenaName: 'Scotiabank Arena', arenaCity: 'Toronto', arenaState: 'ON' }, '2025-26', '2025-11-01'));
  assert.ok(!isNeutralSite({ arenaName: 'Rocket Arena', arenaCity: 'Cleveland', arenaState: 'OH' }, '2024-25', '2025-03-01')); // renamed mid-season
});

const tv = (...names) => ({ nationalBroadcasters: names.map((n) => ({ broadcasterMedia: 'tv', broadcasterAbbreviation: n })) });
test('national TV tiers across eras, incl. combined strings', () => {
  assert.equal(nationalTvTier(tv('ESPN')), 'major');
  assert.equal(nationalTvTier(tv('TNT/truTV/Max')), 'major');
  assert.equal(nationalTvTier(tv('ABC/ESPN/ESPN+/Disney+')), 'major');
  assert.equal(nationalTvTier(tv('NBC', 'Peacock')), 'major');
  assert.equal(nationalTvTier({ nationalOttBroadcasters: [{ broadcasterMedia: 'ott', broadcasterAbbreviation: 'Amazon' }] }), 'major');
  assert.equal(nationalTvTier(tv('NBA TV')), 'nba_tv');
  assert.equal(nationalTvTier(tv('Bounce/WSB')), 'local'); // regional station listed as "national" in 2019-20
  assert.equal(nationalTvTier({}), 'local');
});

test('NBA Cup stages', () => {
  assert.equal(cupStage({ gameSubtype: 'in-season', gameLabel: 'Emirates NBA Cup', gameSubLabel: 'West Group A' }, '0022600100'), 'group');
  assert.equal(cupStage({ gameSubtype: 'in-season-knockout', gameSubLabel: 'Quarterfinal' }, '0022601201'), 'quarterfinal');
  assert.equal(cupStage({ gameSubtype: 'in-season-knockout', gameSubLabel: 'Semifinal' }, '0022601205'), 'semifinal');
  assert.equal(cupStage({ gameSubtype: 'in-season-knockout', gameSubLabel: 'Championship' }, '0062400001'), 'final');
  assert.equal(cupStage({}, '0062300001'), 'final');
  assert.equal(cupStage({ gameSubtype: '' }, '0022500002'), null);
});

test('local date: home-team local time, not UTC', () => {
  assert.equal(localGameDate({ homeTeamTime: '2025-10-21T19:30:00Z', gameDateEst: '2025-10-21T00:00:00Z' }), '2025-10-21');
  assert.equal(localGameDate({ homeTeamTime: '0001-01-01T00:00:00Z', gameDateEst: '1997-04-24T00:00:00Z' }), '1997-04-24');
});

test('rest days and back-to-back nights (Jokić, Nov 2025: 11/7, 11/8, 11/11, 11/12)', () => {
  const t = restTags([{ gameId: 'a', date: '2025-11-07' }, { gameId: 'b', date: '2025-11-08' }, { gameId: 'c', date: '2025-11-11' }, { gameId: 'd', date: '2025-11-12' }, { gameId: 'z', date: '2025-11-05' }]);
  assert.deepEqual(t.get('z'), { rest_days: null, b2b_night: null });
  assert.deepEqual(t.get('a'), { rest_days: 1, b2b_night: 1 });
  assert.deepEqual(t.get('b'), { rest_days: 0, b2b_night: 2 });
  assert.deepEqual(t.get('c'), { rest_days: 2, b2b_night: 1 });
  assert.deepEqual(t.get('d'), { rest_days: 0, b2b_night: 2 });
});

test('rest counts preseason / scrimmage anchors but tags only real games (Morant 2019-20)', () => {
  const t = restTags(
    [{ gameId: 'open', date: '2019-10-23' }, { gameId: 'mar', date: '2020-03-10' }, { gameId: 'bub', date: '2020-07-31' }],
    ['2019-10-14', '2019-10-18', '2020-07-24', '2020-07-28'],
  );
  assert.equal(t.size, 3);
  assert.deepEqual(t.get('open'), { rest_days: 4, b2b_night: null });
  assert.deepEqual(t.get('bub'), { rest_days: 2, b2b_night: null });
  assert.deepEqual(restTags([{ gameId: 'x', date: '2025-10-21' }], ['2025-10-20']).get('x'), { rest_days: 0, b2b_night: 2 });
  assert.deepEqual(restTags([{ gameId: 'x', date: '2025-10-21' }]).get('x'), { rest_days: null, b2b_night: null });
});

test('two games on one date: no rest, never negative (Marion 2007-12-19)', () => {
  const t = restTags([{ gameId: 'dal', date: '2007-12-19' }, { gameId: 'atl', date: '2007-12-19' }, { gameId: 'next', date: '2007-12-21' }, { gameId: 'prev', date: '2007-12-17' }]);
  assert.deepEqual(t.get('dal'), { rest_days: 1, b2b_night: null });
  assert.deepEqual(t.get('atl'), { rest_days: null, b2b_night: null });
  assert.deepEqual(t.get('next'), { rest_days: 1, b2b_night: null });
});

test('series: 2003-04 Finals DET over LAL (4-1), higher seed by record', () => {
  const rows = ['0040300401', '0040300402', '0040300403', '0040300404', '0040300405'].flatMap((id, i) => [
    { gameId: id, teamNbaId: 'DET', won: i !== 1 }, { gameId: id, teamNbaId: 'LAL', won: i === 1 }]);
  const [s] = buildSeries('2003-04', rows, [{ teamNbaId: 'DET', conference: 'East', rank: 3, wins: 54 }, { teamNbaId: 'LAL', conference: 'West', rank: 2, wins: 56 }]);
  assert.equal(s.round, 'finals'); assert.equal(s.bracket_slot, 'FINALS'); assert.equal(s.conference, null);
  assert.equal(s.higherNbaId, 'LAL'); assert.equal(s.winnerNbaId, 'DET'); assert.equal(s.best_of, 7);
});

test('series: 2020-21 play-in slots (7v8, 9v10, 8th-seed game)', () => {
  const g = (id, w, l) => [{ gameId: id, teamNbaId: w, won: true }, { gameId: id, teamNbaId: l, won: false }];
  const rows = [...g('0052000101', 'BOS', 'WAS'), ...g('0052000111', 'IND', 'CHA'), ...g('0052000201', 'WAS', 'IND')];
  const st = [['BOS', 7], ['WAS', 8], ['IND', 9], ['CHA', 10]].map(([t, r]) => ({ teamNbaId: t, conference: 'East', rank: r, wins: 40 - r }));
  const s = Object.fromEntries(buildSeries('2020-21', rows, st).map((x) => [x.bracket_slot, x]));
  assert.equal(s['E-7v8'].winnerNbaId, 'BOS'); assert.equal(s['E-9v10'].winnerNbaId, 'IND'); assert.equal(s['E-8seed'].winnerNbaId, 'WAS');
  assert.equal(s['E-8seed'].best_of, 1);
});

test('series: 2019-20 bubble play-in is best-of-2 (POR 8th beat MEM 9th in one game)', () => {
  const rows = [{ gameId: '0051900111', teamNbaId: 'POR', won: true }, { gameId: '0051900111', teamNbaId: 'MEM', won: false }];
  const [s] = buildSeries('2019-20', rows, [{ teamNbaId: 'POR', conference: 'West', rank: 8, wins: 35 }, { teamNbaId: 'MEM', conference: 'West', rank: 9, wins: 34 }]);
  assert.equal(s.best_of, 2); assert.equal(s.bracket_slot, 'W-8v9'); assert.equal(s.winnerNbaId, 'POR');
});
