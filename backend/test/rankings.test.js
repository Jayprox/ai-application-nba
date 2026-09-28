// Rankings + matchups. The math is checked by hand on small inputs (pure
// functions); the routes are checked for internal consistency against the
// rest of the API on whatever real data the test database holds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { composite, matchupTable, posGroup, ranks } from '../src/query/rankings.js';
import { matchupNote } from '../src/routes/props.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

test('positions: first-listed wins (G-F = G, F-C = F); unknown = null', () => {
  assert.deepEqual(['G', 'G-F', 'F-G', 'F', 'F-C', 'C-F', 'C', ' g ', '', null, 'X'].map(posGroup), ['G', 'G', 'F', 'F', 'F', 'C', 'C', 'G', null, null, null]);
});

test('ranks: 1 = best, ties share a rank ("1224"), nulls unranked', () => {
  const rows = [{ v: 5 }, { v: 9 }, { v: 5 }, { v: 1 }, { v: null }];
  const hi = ranks(rows, (r) => r.v, 'high');
  assert.deepEqual(rows.map((r) => hi.get(r) ?? null), [2, 1, 2, 4, null]);
  const lo = ranks(rows, (r) => r.v, 'low');
  assert.deepEqual(rows.map((r) => lo.get(r) ?? null), [2, 4, 2, 1, null]);
});

test('composite: equal-weight z-scores by hand; turnovers count against; no spread = 0', () => {
  // pts 10/20/30 -> mean 20, pop. SD 8.165 -> z -1.22 / 0 / 1.22; tov 1/2/3 -> flipped; reb all 5 -> 0.
  const out = composite([{ name: 'A', pts: 10, tov: 1, reb: 5 }, { name: 'B', pts: 20, tov: 2, reb: 5 }, { name: 'C', pts: 30, tov: 3, reb: 5 }], ['pts', 'tov', 'reb']);
  const by = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.deepEqual(by.A.z, { pts: -1.22, tov: 1.22, reb: 0 });
  assert.deepEqual(by.C.z, { pts: 1.22, tov: -1.22, reb: 0 });
  assert.equal(by.B.score, 0);
  assert.deepEqual(out.map((r) => r.rank), [1, 1, 1], 'here scoring more exactly cancels turning it over more');
  const two = composite([{ name: 'A', pts: 10, tov: 3 }, { name: 'B', pts: 20, tov: 1 }], ['pts', 'tov']);
  assert.deepEqual(two.map((r) => [r.name, r.rank, r.score]), [['B', 1, 1], ['A', 2, -1]]);
});

test('matchup table: per game, combos, rank (1 = fewest), vs league average, strong/weak only with 10+ teams', () => {
  const games = [{ def_id: 1, abbr: 'AAA', games: 2 }, { def_id: 2, abbr: 'BBB', games: 4 }, { def_id: 3, abbr: 'CCC', games: 1 }];
  const sums = [
    { def_id: 1, pos: 'G', pts: 100, reb: 20, ast: 30, fg3m: 10, stl: 4, blk: 2, tov: 8 },
    { def_id: 2, pos: 'G', pts: 160, reb: 40, ast: 40, fg3m: 12, stl: 8, blk: 4, tov: 12 },
    { def_id: 3, pos: 'G', pts: 70, reb: 10, ast: 10, fg3m: 9, stl: 1, blk: 0, tov: 5 },
  ];
  const t = matchupTable(games, sums);
  const g = Object.fromEntries(t.G.map((r) => [r.abbr, r]));
  assert.deepEqual([g.AAA.allowed.pts, g.BBB.allowed.pts, g.CCC.allowed.pts], [50, 40, 70]);
  assert.deepEqual([g.AAA.rank.pts, g.BBB.rank.pts, g.CCC.rank.pts], [2, 1, 3]);
  assert.equal(t.G_avg.pts, 53.3);
  assert.equal(g.CCC.vs_avg.pts, 16.7);
  assert.equal(g.AAA.allowed.pra, 50 + 10 + 15);
  assert.equal(g.BBB.allowed.stocks, 3);
  assert.equal(g.AAA.label.pts, null, 'fewer than 10 teams: no labels');
  assert.deepEqual(t.C.map((r) => r.allowed.pts), [0, 0, 0], 'a team that faced no centers allows 0, not nothing');

  const many = Array.from({ length: 12 }, (_, i) => ({ def_id: i + 1, abbr: `T${i + 1}`, games: 1 }));
  const t12 = matchupTable(many, many.map((m) => ({ def_id: m.def_id, pos: 'F', pts: m.def_id * 10 })));
  const labels = Object.fromEntries(t12.F.map((r) => [r.abbr, r.label.pts]));
  assert.deepEqual([labels.T1, labels.T5, labels.T6, labels.T7, labels.T8, labels.T12], ['strong', 'strong', null, null, 'weak', 'weak']);
});

test('props matchup note: needs a position, an opponent and 5 games', () => {
  const mu = { G: [{ team_id: 7, abbr: 'BOS', games: 6, allowed: { pts: 48.2 }, vs_avg: { pts: 3.1 }, rank: { pts: 27 }, label: { pts: 'weak' } }, { team_id: 8, abbr: 'NYK', games: 4, allowed: {}, vs_avg: {}, rank: {}, label: {} }] };
  assert.deepEqual(matchupNote(mu, 'G', 7, 'pts'), { position: 'G', position_label: 'Guards', rank: 27, of: 2, allowed: 48.2, vs_avg: 3.1, label: 'weak', games: 6, opponent: 'BOS' });
  assert.equal(matchupNote(mu, 'G', 8, 'pts'), null, 'only 4 games');
  assert.equal(matchupNote(mu, null, 7, 'pts'), null);
  assert.equal(matchupNote(null, 'G', 7, 'pts'), null);
});

// ---- routes, checked against the rest of the API --------------------------------------------
const seasonWithGames = async () => (await s.db.query(`SELECT season FROM games WHERE status = 'final' AND season_type = 'regular' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).rows[0]?.season;

test('GET /rankings/teams: ratings and records agree with POST /query for the same team', async (t) => {
  const season = await seasonWithGames();
  if (!season) return t.skip('no games loaded');
  const r = await s.api('GET', `/rankings/teams?season=${season}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length > 0);
  for (const row of r.body.data.slice(0, 3)) {
    const q = (await s.query({ entity: 'team', id: row.team_id, scope: 'season', season })).body;
    assert.equal(row.gp, q.meta.sample_size);
    assert.equal(`${row.w}-${row.l}`, q.meta.record);
    assert.equal(row.pts, q.data.pts);
    assert.equal(row.off_rtg, q.data.off_rtg);
    assert.equal(row.def_rtg, q.data.def_rtg);
  }
  const net = r.body.data.map((x) => x.ranks.net_rtg);
  assert.deepEqual(net, [...net].sort((a, b) => a - b), 'sorted by net rating rank');
});

test('GET /rankings/matchups: every point allowed is accounted for (by position + unlisted = opponents\' points)', async (t) => {
  const season = await seasonWithGames();
  if (!season) return t.skip('no games loaded');
  const r = await s.api('GET', `/rankings/matchups?season=${season}`);
  assert.equal(r.status, 200);
  const byPos = ['G', 'F', 'C'].reduce((a, p) => a + r.body.data[p].reduce((b, x) => b + x.allowed.pts * x.games, 0), 0);
  const { rows: [tot] } = await s.db.query(
    `SELECT sum(s.pts)::float8 AS pts FROM player_game_stats s JOIN games g ON g.id = s.game_id
      WHERE g.season = $1 AND g.season_type = 'regular' AND g.status = 'final' AND NOT s.dnp`, [season]);
  // every player row is some defense's "allowed"; rounding to 0.1/game per team limits precision
  const share = byPos / tot.pts;
  assert.ok(Math.abs(share - (1 - r.body.meta.unlisted_share)) < 0.01, `${share} vs ${1 - r.body.meta.unlisted_share}`);
  const one = await s.api('GET', `/rankings/matchups?season=${season}&team_id=${r.body.data.G[0].team_id}`);
  assert.equal(one.body.data.G.length, 1);
});

test('GET /rankings/players: stats equal POST /query for the same player; qualifier = leaderboard rule', async (t) => {
  const season = await seasonWithGames();
  if (!season) return t.skip('no games loaded');
  let checked = 0;
  for (const pos of ['G', 'F', 'C']) {
    const r = await s.api('GET', `/rankings/players?season=${season}&position=${pos}`);
    assert.equal(r.status, 200);
    const lb = (await s.query({ scope: 'leaderboard', season, stat: 'pts' })).body.meta.qualifier;
    assert.equal(r.body.meta.qualifier.min_games, lb.min_games);
    for (const row of r.body.data.slice(0, 2)) {
      const q = (await s.query({ entity: 'player', id: row.player_id, scope: 'season', season })).body;
      assert.equal(row.gp, q.meta.sample_size);
      assert.deepEqual([row.pts, row.reb, row.ast, row.ts_pct], [q.data.pts, q.data.reb, q.data.ast, q.data.ts_pct]);
      checked++;
    }
    if (r.body.data.length > 1) {
      const mean = r.body.data.reduce((a, x) => a + x.score, 0) / r.body.data.length;
      assert.ok(Math.abs(mean) < 0.02, 'z-scores average ~0 within the group');
    }
  }
  if (!checked) t.diagnostic('no qualified players with a listed position in this database');
});

test('rankings: clean 400s', async () => {
  for (const q of ['/rankings/players?position=PG', '/rankings/players?season=2025', '/rankings/teams?scope=last5', '/rankings/matchups?season_type=cup', '/rankings/matchups?team_id=abc', '/rankings/players?limit=0']) {
    assert.equal((await s.api('GET', q)).status, 400, q);
  }
});
