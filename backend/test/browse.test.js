import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

test('teams: 30, with altitude arenas flagged (DEN, UTA)', async () => {
  const r = await s.api('GET', '/teams');
  assert.equal(r.body.data.length, 30);
  assert.deepEqual(r.body.data.filter((t) => t.is_high_altitude).map((t) => t.abbreviation).sort(), ['DEN', 'UTA']);
});

test('player search tolerates accents, suffixes, punctuation (the James Cook III bug)', async () => {
  const names = async (q, active = true) => (await s.api('GET', `/players?q=${encodeURIComponent(q)}&active=${active}`)).body.data.map((p) => p.full_name);
  assert.ok((await names('jokic')).includes('Nikola Jokić'));
  assert.ok((await names('jaren jackson')).includes('Jaren Jackson Jr.'));
  assert.ok((await names('porzingis')).includes('Kristaps Porziņģis'));
  assert.ok((await names('shannon jr')).includes('Terrence Shannon Jr'));
  assert.equal((await s.api('GET', '/players?team=abc')).status, 400);
});

test('active toggle: retired players only with active=false', async () => {
  const { rows } = await s.db.query('SELECT full_name FROM players WHERE NOT is_active LIMIT 1');
  if (!rows.length) return;
  const on = (await s.api('GET', `/players?q=${encodeURIComponent(rows[0].full_name)}`)).body.data;
  const off = (await s.api('GET', `/players?q=${encodeURIComponent(rows[0].full_name)}&active=false`)).body.data;
  assert.ok(!on.some((p) => p.full_name === rows[0].full_name));
  assert.ok(off.some((p) => p.full_name === rows[0].full_name));
});

test('scoreboard by date + box score (Tokyo, 2003-10-30: neutral site)', async () => {
  const r = await s.api('GET', '/games?date=2003-10-30');
  assert.equal(r.status, 200);
  const tokyo = r.body.data.find((g) => g.arena_city === 'Tokyo');
  if (tokyo) assert.equal(tokyo.is_neutral_site, true);
  const debut = (await s.api('GET', '/games?date=2003-10-29')).body.data.find((g) => g.away === 'CLE');
  const box = await s.api('GET', `/games/${debut.id}`);
  assert.equal(box.status, 200);
  const cle = box.body.data.teams.find((t) => t.abbreviation === 'CLE');
  assert.equal(cle.players.find((p) => p.full_name === 'LeBron James').pts, 25);
  assert.equal(r.body.meta.prev_date < '2003-10-30' && r.body.meta.next_date > '2003-10-30', true);
  const empty = await s.api('GET', '/games?date=2003-08-01');   // offseason: no games, but a way forward
  assert.equal(empty.body.data.length, 0);
  assert.equal(empty.body.meta.next_date >= '2003-10-28', true);
  assert.equal((await s.api('GET', '/games?date=bad')).status, 400);
  assert.equal((await s.api('GET', '/games/not-a-uuid')).status, 404);
});

test('player detail lists seasons with data', async () => {
  const { rows: [p] } = await s.db.query("SELECT id FROM players WHERE full_name = 'LeBron James'");
  const r = await s.api('GET', `/players/${p.id}`);
  assert.ok(r.body.data.seasons.includes('2003-04'));
  assert.equal(r.body.data.current_injury, null);
  assert.deepEqual(r.body.data.season_types['2003-04'], ['regular'], 'rookie LeBron: no playoffs (CLE missed them)');
  const { rows: [mem] } = await s.db.query("SELECT id FROM teams WHERE abbreviation = 'MEM'");
  const t = await s.api('GET', `/teams/${mem.id}`);
  if (t.body.data.season_types['2019-20']) assert.ok(t.body.data.season_types['2019-20'].includes('play_in'));
});

test('seasons list + a team\'s season roster (trades counted for the team he played for)', async () => {
  const r = await s.api('GET', '/seasons');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 2);
  assert.ok(r.body.data[0].season > r.body.data.at(-1).season, 'newest first');
  assert.equal(r.body.meta.latest_with_games, r.body.data[0].season);
  assert.ok(r.body.data.every((x) => !x.types.includes('preseason')));
  const { rows: [cle] } = await s.db.query("SELECT id FROM teams WHERE abbreviation = 'CLE'");
  const roster = await s.api('GET', `/teams/${cle.id}/players?season=2003-04`);
  assert.equal(roster.status, 200);
  const lbj = roster.body.data.find((p) => p.full_name === 'LeBron James');
  assert.equal(lbj.gp, 79);
  assert.equal(lbj.pts, 20.9);
  assert.equal((await s.api('GET', `/teams/${cle.id}/players`)).status, 400);
  assert.equal((await s.api('GET', `/teams/${cle.id}/players?season=2003-04&season_type=x`)).status, 400);
});
