// POST /query checked against NBA.com's OWN split dashboards
// (playerdashboardbygeneralsplits / bylastngames, fetched 2026-09-27) — not
// against numbers our database produced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, playerId, seasonLoaded } from './helpers.js';

let s, lebron, morant;
before(async () => {
  s = await startServer();
  lebron = await playerId(s.db, 'LeBron James');
  morant = await playerId(s.db, 'Ja Morant');
});
after(() => s.close());

const q = (id, scope, season, splits = {}, extra = {}) => s.query({ entity: 'player', id, scope, season, season_type: 'regular', splits, ...extra });

test('LeBron 2003-04 season = NBA.com: 79 GP, 20.9 PPG, 5.5 RPG, 5.9 APG', async () => {
  const r = await q(lebron, 'season', '2003-04');
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.sample_size, 79);
  assert.equal(r.body.data.pts, 20.9); assert.equal(r.body.data.reb, 5.5); assert.equal(r.body.data.ast, 5.9);
  // His record = CLE's 35-47 minus the 3 games he missed (derived, not guessed).
  const { rows: [t] } = await s.db.query("SELECT id FROM teams WHERE abbreviation = 'CLE'");
  const team = (await s.query({ entity: 'team', id: t.id, scope: 'game_log', season: '2003-04' })).body.data;
  const his = new Set((await q(lebron, 'game_log', '2003-04')).body.data.map((g) => g.game_id));
  const missed = team.filter((g) => !his.has(g.game_id));
  const [w, l] = r.body.meta.record.split('-').map(Number);
  assert.equal(missed.length, 3);
  assert.equal(w + missed.filter((g) => g.won).length, 35);
  assert.equal(l + missed.filter((g) => !g.won).length, 47);
});

test('LeBron 2003-04 home/road = NBA.com: home 38 GP 21.3, road 41 GP 20.6', async () => {
  const h = await q(lebron, 'season', '2003-04', { venue: 'home' });
  const a = await q(lebron, 'season', '2003-04', { venue: 'away' });
  assert.deepEqual([h.body.meta.sample_size, h.body.data.pts], [38, 21.3]);
  assert.deepEqual([a.body.meta.sample_size, a.body.data.pts], [41, 20.6]);
});

test('LeBron 2003-04 PLAYER rest = NBA.com (0: 20 GP 22.8, 1: 40 GP 22.0, 2: 12 GP 16.7, 3+: 7 GP 17.0)', async () => {
  const exp = [[0, 20, 22.8], [1, 40, 22.0], [2, 12, 16.7], ['3+', 7, 17.0]];
  for (const [rest, gp, pts] of exp) {
    const r = await q(lebron, 'season', '2003-04', { player_rest: rest });
    assert.deepEqual([r.body.meta.sample_size, r.body.data.pts], [gp, pts], `player_rest ${rest}`);
  }
  assert.equal((await q(lebron, 'season', '2003-04', { player_b2b: 2 })).body.meta.sample_size, 20, 'player b2b night 2 == 0 days rest');
});

test('TEAM rest differs from player rest only around games he missed', async () => {
  // Team-schedule rest (the other filter): all 79 games bucketed, and the two
  // definitions disagree only where LeBron sat out an adjacent team game.
  let total = 0; const diff = [];
  for (const rest of [0, 1, 2, '3+']) {
    const team = (await q(lebron, 'season', '2003-04', { rest })).body.meta.sample_size;
    const player = (await q(lebron, 'season', '2003-04', { player_rest: rest })).body.meta.sample_size;
    total += team; diff.push(team - player);
  }
  assert.equal(total, 79);
  assert.equal(diff.reduce((a, b) => a + b, 0), 0, 'same 79 games, just bucketed differently');
  const log = (await q(lebron, 'game_log', '2003-04')).body.data;
  const differing = log.filter((g) => (g.rest_days ?? -1) !== (g.player_rest_days ?? -1));
  assert.ok(differing.length >= 1 && differing.length <= 6, `${differing.length} games differ`);
  for (const g of differing) assert.ok(g.player_rest_days > g.rest_days, 'his own rest can only be longer than the team\'s');
});

test('LeBron 2003-04 last 5 / last 10 = NBA.com (18.4 / 21.3)', async () => {
  assert.equal((await q(lebron, 'last5', '2003-04')).body.data.pts, 18.4);
  assert.equal((await q(lebron, 'last10', '2003-04')).body.data.pts, 21.3);
});

test('Morant 2019-20 season, rest and last-N = NBA.com', async () => {
  const r = await q(morant, 'season', '2019-20');
  assert.deepEqual([r.body.meta.sample_size, r.body.data.pts], [67, 17.8]);
  assert.equal((await q(morant, 'last10', '2019-20')).body.data.pts, 19.7);
  assert.equal((await q(morant, 'last5', '2019-20')).body.data.pts, 18.8);
  const r0 = await q(morant, 'season', '2019-20', { player_rest: 0 });
  assert.deepEqual([r0.body.meta.sample_size, r0.body.data.pts], [8, 16.1]);
  assert.equal((await q(morant, 'season', '2019-20', { player_rest: 1 })).body.meta.sample_size, 42);
  assert.equal((await q(morant, 'season', '2019-20', { player_rest: 2 })).body.meta.sample_size, 11);
  assert.equal((await q(morant, 'season', '2019-20', { player_rest: '3+' })).body.meta.sample_size, 6); // 3,4,5,6+ days = 3+1+1+1
  assert.equal((await q(morant, 'season', '2019-20', { rest: 0 })).body.meta.sample_size, 9, 'team rest: one extra "0 days" — a night-2 he played after sitting night 1');
});

test('Morant 2019-20 home/away: the ONLY difference from NBA.com is the bubble (our neutral games)', async () => {
  // NBA.com: Home 34, Road 33 — it labels Orlando-bubble games home/road; we call them neutral (§6.1).
  const h = (await q(morant, 'season', '2019-20', { venue: 'home' })).body.meta.sample_size;
  const a = (await q(morant, 'season', '2019-20', { venue: 'away' })).body.meta.sample_size;
  const log = (await q(morant, 'game_log', '2019-20')).body.data;
  const neutral = log.filter((g) => g.venue === 'neutral');
  assert.ok(neutral.length > 0 && neutral.every((g) => g.date >= '2020-07-30'), 'neutral games are exactly the bubble');
  assert.equal(h + a + neutral.length, 67);
  assert.equal((34 - h) + (33 - a), neutral.length);
});

test('splits apply BEFORE the window: last 10 + home = his last 10 home games', async () => {
  const log = (await q(lebron, 'game_log', '2003-04')).body.data.filter((g) => g.venue === 'home').slice(0, 10);
  const expected = Math.round((log.reduce((t, g) => t + g.pts, 0) / 10) * 10) / 10;
  const r = await q(lebron, 'last10', '2003-04', { venue: 'home' });
  assert.equal(r.body.meta.sample_size, 10);
  assert.equal(r.body.data.pts, expected);
});

test('game log: newest first, carries tags; career totals agree with the season', async () => {
  const log = (await q(lebron, 'game_log', '2003-04')).body.data;
  assert.equal(log.length, 79);
  assert.ok(log[0].date > log.at(-1).date);
  assert.equal(log.at(-1).pts, 25); // debut, 2003-10-29 @ SAC
  assert.equal(log.at(-1).opponent, 'SAC');
  const c = await s.query({ entity: 'player', id: lebron, scope: 'career', season_type: 'regular' });
  assert.equal(c.status, 200);
  assert.ok(c.body.data.by_season.some((x) => x.season === '2003-04' && x.gp === 79 && x.pts === 20.9));
  assert.deepEqual(c.body.meta.notes, [], 'LeBron started in 2003-04: no partial-career note');
  assert.equal(c.body.data.by_season[0].team, 'CLE');
});

test('career note only for players whose careers started before 2003-04', async () => {
  const { rows } = await s.db.query('SELECT id FROM players WHERE first_season_start < 2003 LIMIT 1');
  if (!rows.length) return; // nothing to check in this dataset
  const c = await s.query({ entity: 'player', id: rows[0].id, scope: 'career', season_type: 'regular' });
  assert.match(c.body.meta.notes[0], /Stats begin 2003-04/);
});

test('team query: CLE 2003-04 record = standings (35-47)', async () => {
  const { rows: [t] } = await s.db.query("SELECT id FROM teams WHERE abbreviation = 'CLE'");
  const r = await s.query({ entity: 'team', id: t.id, scope: 'season', season: '2003-04' });
  assert.equal(r.status, 200);
  if (r.body.meta.sample_size === 82) assert.equal(r.body.meta.record, '35-47');
});

test('leaderboard: qualifier applied and explained', async () => {
  const r = await s.query({ scope: 'leaderboard', season: '2003-04', stat: 'pts', limit: 5 });
  assert.equal(r.status, 200);
  assert.ok(r.body.meta.qualifier.min_games >= 1);
  assert.match(r.body.meta.notes[0], /70%/);
  for (const row of r.body.data) assert.ok(row.gp >= r.body.meta.qualifier.min_games);
  assert.deepEqual(r.body.data.map((x) => x.rank), r.body.data.map((_, i) => i + 1));
});

test('Jokić 2025-26 = NBA.com (65 GP, 27.7 PPG) and Dončić leads scoring (33.5 in 64) — full data only', async (t) => {
  if (!(await seasonLoaded(s.db, '2025-26'))) return t.skip('2025-26 not loaded in this database');
  const jokic = await playerId(s.db, 'Nikola Jokić');
  const r = await q(jokic, 'season', '2025-26');
  assert.deepEqual([r.body.meta.sample_size, r.body.data.pts], [65, 27.7]);
  const lb = await s.query({ scope: 'leaderboard', season: '2025-26', stat: 'pts', limit: 3 });
  assert.equal(lb.body.meta.qualifier.min_games, 58);
  assert.deepEqual([lb.body.data[0].full_name, lb.body.data[0].value, lb.body.data[0].gp], ['Luka Dončić', 33.5, 64]);
});

test('advanced stats = NBA.com: TS% / eFG% (LeBron 2003-04 .488 / .438, Morant 2019-20 .556 / .509)', async () => {
  const l = (await q(lebron, 'season', '2003-04')).body.data;
  assert.equal(l.ts_pct, 0.488); assert.equal(l.efg_pct, 0.438);
  const m = (await q(morant, 'season', '2019-20')).body.data;
  assert.equal(m.ts_pct, 0.556); assert.equal(m.efg_pct, 0.509);
  assert.ok(Math.abs(m.pts_per36 - 20.7) <= 0.1, `Morant pts/36 ${m.pts_per36} vs NBA.com 20.7`);
  const c = (await s.query({ entity: 'player', id: lebron, scope: 'career' })).body.data;
  assert.equal(c.by_season.find((x) => x.season === '2003-04').ts_pct, 0.488, 'career rows carry it too');
});

test('team ratings: points per 100 estimated possessions; NBA Cup is a season type (not for leaderboards)', async () => {
  const { rows: [t] } = await s.db.query("SELECT id FROM teams WHERE abbreviation = 'CLE'");
  const r = (await s.query({ entity: 'team', id: t.id, scope: 'season', season: '2003-04' })).body.data;
  assert.ok(r.off_rtg > 85 && r.off_rtg < 125 && r.def_rtg > 85 && r.def_rtg < 125, JSON.stringify(r));
  const cup = await q(lebron, 'season', '2003-04', {}, { season_type: 'cup' });
  assert.equal(cup.status, 200);
  assert.equal(cup.body.meta.sample_size, 0, 'no NBA Cup before 2023-24');
});

test('validation: clean 400/404s, never a 500', async () => {
  const cases = [
    [{ scope: 'nope', id: lebron, season: '2003-04' }, 400],
    [{ id: lebron, season: '03-04' }, 400],
    [{ id: lebron, season: '2003-04', splits: { weather: 'rain' } }, 400],
    [{ id: lebron, season: '2003-04', splits: { rest: 4 } }, 400],
    [{ id: lebron, season: '2003-04', season_type: 'preseason' }, 400],
    [{ id: 'not-a-uuid', season: '2003-04' }, 404],
    [{ id: '00000000-0000-0000-0000-000000000000', season: '2003-04' }, 404],
    [{ entity: 'team', id: 99999, season: '2003-04' }, 404],
    [{ scope: 'leaderboard', season: '2003-04', stat: 'fg_pct' }, 400],
    [{ scope: 'leaderboard', season: '2003-04', splits: { venue: 'home' } }, 400],
    [{ entity: 'team', id: 1, season: '2003-04', splits: { player_rest: 0 } }, 400],
    [{ scope: 'leaderboard', season: '2003-04', season_type: 'cup' }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await s.query(body)).status, status, JSON.stringify(body));
});

test('empty result is a clean empty state, not an error', async () => {
  const r = await q(lebron, 'season', '2003-04', { altitude: true, venue: 'home' }); // no altitude home games in Cleveland
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.sample_size, 0);
  assert.equal(r.body.data, null);
});

test('cache: identical query served from cache, flagged in meta', async () => {
  const a = await q(lebron, 'season', '2003-04', { venue: 'away' });
  const b = await q(lebron, 'season', '2003-04', { venue: 'away' });
  assert.equal(a.body.meta.cached || b.body.meta.cached, true);
  assert.deepEqual(a.body.data, b.body.data);
});
