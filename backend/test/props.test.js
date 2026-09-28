// Player props: grading and hit rates are counts over real games. Lines are
// inserted by the test (DraftKings-style) on real 2003-04 games and removed
// afterwards; expected numbers come from the game log, a separate code path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, playerId } from './helpers.js';
import { hitRate } from '../src/routes/props.js';
import { checkLines, grade, marketValue } from '../src/query/markets.js';

let s, lebron, morant, log, lastGame, futureGame;
before(async () => {
  s = await startServer();
  lebron = await playerId(s.db, 'LeBron James');
  morant = await playerId(s.db, 'Ja Morant');
  const { rows: [lg] } = await s.db.query(`SELECT g.id AS game_id, g.game_date_local AS date FROM player_game_stats x JOIN games g ON g.id = x.game_id
    WHERE x.player_id = $1 AND g.season = '2003-04' AND g.season_type = 'regular' ORDER BY g.game_date_local DESC LIMIT 1`, [lebron]);
  lastGame = lg;                                                                                            // 2004-04-14: 17 / 1 / 5
  await s.db.query(`INSERT INTO prop_lines (game_id, player_id, market, snapshot, line, over_price, under_price) VALUES
    ($1, $2, 'pts', 'open', 24.5, -115, -105), ($1, $2, 'pts', 'close', 23.5, -110, -110), ($1, $2, 'pra', 'close', 33.5, -120, 100),
    ($1, $3, 'pts', 'close', 12.5, -110, -110)`, [lastGame.game_id, lebron, morant]);
  log = (await s.query({ entity: 'player', id: lebron, scope: 'game_log', season: '2003-04' })).body.data;   // newest first
  const { rows: [g] } = await s.db.query(`SELECT id FROM games WHERE season = '2026-27' AND season_type = 'regular' AND status = 'scheduled' AND tipoff_utc > now() ORDER BY tipoff_utc LIMIT 1`);
  futureGame = g?.id;
  if (futureGame) {
    await s.db.query(`INSERT INTO prop_lines (game_id, player_id, market, snapshot, line, over_price, under_price) VALUES
      ($1, $2, 'pts', 'open', 22.5, -110, -110), ($1, $2, 'reb', 'open', 7.5, 105, -125)`, [futureGame, lebron]);
  }
});
after(async () => {
  await s.db.query('DELETE FROM prop_lines WHERE player_id = ANY($1::uuid[])', [[lebron, morant]]);
  await s.close();
});

test('markets: combos add up; grading over / under / push; line validation', () => {
  const row = { pts: 20, reb: 7, ast: 5, stl: 2, blk: 1, tov: 3, fg3m: 1 };
  assert.deepEqual(['pts', 'pra', 'pr', 'pa', 'ra', 'stocks'].map((m) => marketValue(row, m)), [20, 32, 27, 25, 12, 3]);
  assert.deepEqual([grade(21, 20.5), grade(20, 20.5), grade(20, 20), grade(null, 1)], ['over', 'under', 'push', null]);
  assert.deepEqual(hitRate([row, { ...row, pts: 30 }], 'pts', 25.5), { over: 1, under: 1, push: 0, games: 2, avg: 25 });
  assert.equal(checkLines({ pts: 25.5 }), null);
  for (const bad of [{ pts: 25.3 }, { points: 25.5 }, { pts: '25.5' }, { pts: -1 }, {}, [], null]) assert.ok(checkLines(bad), JSON.stringify(bad));
});

test('POST /query lines: over/under counts over exactly the filtered games (= the game log)', async () => {
  const r = await s.query({ entity: 'player', id: lebron, scope: 'season', season: '2003-04', lines: { pts: 20.5, pra: 32.5, fg3m: 1 } });
  assert.equal(r.status, 200);
  const count = (m, line, side) => log.filter((g) => grade(marketValue(g, m), line) === side).length;
  assert.deepEqual(r.body.props.pts, { line: 20.5, over: count('pts', 20.5, 'over'), under: count('pts', 20.5, 'under'), push: 0, games: 79 });
  assert.deepEqual(r.body.props.pra, { line: 32.5, over: count('pra', 32.5, 'over'), under: count('pra', 32.5, 'under'), push: 0, games: 79 });
  assert.equal(r.body.props.fg3m.push, count('fg3m', 1, 'push'), 'a whole-number line can push');
  assert.ok(r.body.props.fg3m.push > 0);
  assert.equal(r.body.data.pts, 20.9, 'averages are untouched');
  // Splits + window apply to the hit rate too: last 10 road games.
  const road = log.filter((g) => g.venue === 'away').slice(0, 10);
  const r10 = await s.query({ entity: 'player', id: lebron, scope: 'last10', season: '2003-04', splits: { venue: 'away' }, lines: { pts: 20.5 } });
  assert.deepEqual(r10.body.props.pts, { line: 20.5, over: road.filter((g) => g.pts > 20.5).length, under: road.filter((g) => g.pts < 20.5).length, push: 0, games: 10 });
  // Different lines are different cache entries.
  const lo = await s.query({ entity: 'player', id: lebron, scope: 'season', season: '2003-04', lines: { pts: 10.5 } });
  assert.equal(lo.body.props.pts.over, count('pts', 10.5, 'over'));
  assert.equal(lo.body.meta.cached, false);
});

test('POST /query lines: clean 400s', async () => {
  const bad = async (extra) => (await s.query({ entity: 'player', id: lebron, scope: 'season', season: '2003-04', ...extra })).status;
  assert.equal(await bad({ lines: { pts: 25.3 } }), 400);
  assert.equal(await bad({ lines: { dunks: 1.5 } }), 400);
  assert.equal(await bad({ scope: 'game_log', lines: { pts: 25.5 } }), 400);
  const { rows: [t] } = await s.db.query("SELECT id FROM teams WHERE abbreviation = 'CLE'");
  assert.equal((await s.query({ entity: 'team', id: t.id, scope: 'season', season: '2003-04', lines: { pts: 99.5 } })).status, 400);
});

test('game log carries the DraftKings line (closing over opening) and its result', async () => {
  assert.equal(log[0].game_id, lastGame.game_id);
  assert.deepEqual(log[0].props, { pts: { line: 23.5, result: 'under' }, pra: { line: 33.5, result: 'under' } });    // 17 pts, 23 PRA
  assert.equal(log[1].props, null);
});

test('GET /props board: line, movement, result, and hit rates at this line from his PRIOR games', async () => {
  const r = await s.api('GET', `/props?date=${lastGame.date}&market=pts`);
  assert.equal(r.status, 200);
  assert.equal(r.body.meta.date, lastGame.date);
  const row = r.body.data.find((x) => x.player_id === lebron);
  assert.deepEqual({ line: row.line, open: row.open_line, snap: row.snapshot, actual: row.actual, result: row.result, team: row.team },
    { line: 23.5, open: 24.5, snap: 'close', actual: 17, result: 'under', team: 'CLE' });
  const prior = log.slice(1);                                      // the board never peeks at the game itself
  assert.deepEqual(row.last10, hitRate(prior.slice(0, 10), 'pts', 23.5));
  assert.deepEqual(row.season, hitRate(prior, 'pts', 23.5));
  assert.equal(row.season.games, 78);
  assert.equal(row.last_season, undefined, 'plenty of games this season');
  const dnp = r.body.data.find((x) => x.player_id === morant);
  assert.equal(dnp.result, 'dnp', 'not in the box score = no action');
  const pra = await s.api('GET', `/props?date=${lastGame.date}&market=pra`);
  assert.deepEqual(pra.body.data.map((x) => [x.line, x.actual, x.result]), [[33.5, 23, 'under']]);
  assert.equal((await s.api('GET', '/props?market=dunks')).status, 400);
  assert.equal((await s.api('GET', '/props?date=2004-4-1')).status, 400);
});

test('GET /props with no date: the next date that has lines; prev/next jump between dates with lines', async (t) => {
  if (!futureGame) return t.skip('no scheduled 2026-27 game in this database');
  const r = await s.api('GET', '/props');
  assert.equal(r.body.data[0].player_id, lebron);
  assert.equal(r.body.meta.prev_date, lastGame.date);
  assert.equal(r.body.data[0].result, null);
  assert.equal(r.body.data[0].snapshot, 'open');
});

test('GET /players/:id/props: next game lines + record vs past lines', async (t) => {
  if (!futureGame) return t.skip('no scheduled 2026-27 game in this database');
  const r = await s.api('GET', `/players/${lebron}/props`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.upcoming.game.id, futureGame);
  assert.deepEqual(r.body.data.upcoming.lines.map((l) => [l.market, l.line, l.label]), [['pts', 22.5, 'Points'], ['reb', 7.5, 'Rebounds']]);
  assert.deepEqual(r.body.data.record, {
    pts: { label: 'Points', over: 0, under: 1, push: 0, games: 1 }, pra: { label: 'Pts + Reb + Ast', over: 0, under: 1, push: 0, games: 1 },
  });
  assert.equal((await s.api('GET', '/players/not-a-uuid/props')).status, 404);
});
