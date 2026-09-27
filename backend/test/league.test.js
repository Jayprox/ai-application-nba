import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildStandings, formatOf } from '../src/routes/league.js';
import { startServer } from './helpers.js';

const teams = [
  { id: 1, abbreviation: 'NYK', full_name: 'New York Knicks', conference: 'East', division: 'Atlantic' },
  { id: 2, abbreviation: 'BOS', full_name: 'Boston Celtics', conference: 'East', division: 'Atlantic' },
];
const g = (team_id, date, won, venue, opp_conference = 'East') => ({ team_id, date, won, venue, opp_conference });

test('standings (pure): records, neutral games in neither home nor road, last 10, streak, games back', () => {
  const games = [
    g(1, '2025-10-22', true, 'home'), g(1, '2025-10-24', true, 'away', 'West'), g(1, '2025-11-01', false, 'neutral'), g(1, '2025-11-03', true, 'home'),
    g(2, '2025-10-22', false, 'away'), g(2, '2025-10-25', false, 'home'), g(2, '2025-10-27', true, 'home'),
  ];
  const [nyk, bos] = buildStandings(teams, games, new Map());
  assert.deepEqual({ ...nyk }, { ...nyk, abbreviation: 'NYK', wins: 3, losses: 1, pct: 0.75, home: '2-0', road: '1-0', conf: '2-1', last10: '3-1', streak: 'W 1', rank: 1, gb: 0, rank_source: 'computed' });
  assert.equal(bos.gb, 1.5);
  assert.equal(bos.streak, 'W 1');
});

test("standings (pure): NBA.com's rank wins ties when its W-L matches ours; stale official rows are ignored", () => {
  const games = [g(1, '2025-10-22', true, 'home'), g(2, '2025-10-22', true, 'home')];
  const official = new Map([[1, { conference_rank: 2, wins: 1, losses: 0, clinch: 'x' }], [2, { conference_rank: 1, wins: 1, losses: 0, clinch: null }]]);
  const rows = buildStandings(teams, games, official);
  assert.deepEqual(rows.map((r) => [r.abbreviation, r.rank, r.rank_source, r.clinch]), [['BOS', 1, 'nba_stats', null], ['NYK', 2, 'nba_stats', 'x']]);
  const stale = buildStandings(teams, [...games, g(1, '2025-10-23', true, 'away')], official);
  assert.equal(stale.find((r) => r.abbreviation === 'NYK').rank_source, 'computed');
});

test('postseason format by era', () => {
  assert.deepEqual(formatOf('2025-26').play_in_seeds, [7, 8, 9, 10]);
  assert.deepEqual(formatOf('2019-20').play_in_seeds, [8, 9]);
  assert.deepEqual(formatOf('2010-11').play_in_seeds, []);
});

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

test('GET /standings and /bracket: shape, validation, auth', async () => {
  const st = await s.api('GET', '/standings?season=2019-20');
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.body.data.East) && Array.isArray(st.body.data.West));
  const mem = st.body.data.West.find((t) => t.abbreviation === 'MEM');
  if (mem) assert.ok(mem.wins > 0);
  assert.equal((await s.api('GET', '/standings?season=19-20')).status, 400);
  const br = await s.api('GET', '/bracket?season=2019-20');
  assert.equal(br.status, 200);
  const pi = br.body.data.find((x) => x.round === 'play_in');
  if (pi) { assert.equal(pi.best_of, 2); assert.equal(pi.higher_abbr, 'POR'); assert.equal(pi.higher_wins, 1); }
  assert.equal((await fetch(s.base + '/standings')).status, 401);
});
