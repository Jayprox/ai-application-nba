// HL weekly schedule pass (M6 T3) against a throwaway Postgres. Fixtures: copies of the recorded Highlightly
// files plus synthetic edits of them (see test/fixtures/weekly/README.md).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyHighlightly } from '../src/hl-weekly-client.js';
import { fixtureFetch } from '../src/hl-fixture-fetch.js';
import { runSchedulePass } from '../src/weekly-schedule.js';
import { localDate, TEAM_TZ } from '../src/team-tz.js';
import { addGame, connect, count, fingerprint, one, resetSchema, skip, T, TEAMS } from './helpers/db.js';
import { match, putQuota, synthDir } from './helpers/fx.js';

let db;
before(async () => { if (skip) return; db = await connect(); });
after(async () => { if (db) await db.end(); });
beforeEach(async () => { if (!skip) await resetSchema(db); });

const NOW = new Date('2026-10-06T14:00:00Z');                 // ET date 2026-10-06, before the preseason games below
const client = (dir, o = {}) => createWeeklyHighlightly({ fixtures: dir, now: () => 0, sleep: async () => {}, ...o });
const run = (dir, o = {}, c = {}) => runSchedulePass(db, client(dir, c), { season: '2026-27', now: NOW, daysBack: 0, daysAhead: 1, tipoffAuthority: true, ...o });
const day = (date, list) => ({ [`matches_${date}`]: { data: list, pagination: { totalCount: list.length, offset: 0, limit: 100 } } });
// LAL @ GS on the recorded 2026-10-06 slate (Highlightly 4 @ 43), tip 2026-10-07T02:00Z = 2026-10-06 19:00 in Los Angeles
const lalGs = (over = {}) => match({ id: 1545655, season: 2027, date: '2026-10-07T02:00:00.000Z', state: { description: 'Scheduled', score: { homeTeam: [], awayTeam: [] } },
  homeTeam: { id: 43, abbreviation: 'GS', name: 'Warriors' }, awayTeam: { id: 4, abbreviation: 'LAL', name: 'Lakers' }, ...over });
const seedLalGs = (o = {}) => addGame(db, { home: 'GSW', away: 'LAL', local: '2026-10-06', tip: '2026-10-07T02:00:00Z', type: 'preseason', ...o });
const game = (id) => one(db, `SELECT status, home_score, away_score, tipoff_utc, game_date_local::text AS local, updated_at::text AS upd FROM games WHERE id = $1`, [id]);

test('a finished game gets status, scores and a highlightly crosswalk row (recorded MEM @ HOU 2026-04-12: 132-101)', { skip }, async () => {
  const id = await addGame(db, { home: 'HOU', away: 'MEM', local: '2026-04-12', tip: '2026-04-13T00:30:00Z', season: '2025-26' });
  const dir = synthDir({}, { copyRecorded: true });
  const r = await runSchedulePass(db, client(dir), { season: '2025-26', now: new Date('2026-04-20T15:00:00Z'), daysBack: 8, daysAhead: 0, tipoffAuthority: true });
  assert.equal(r.counts.updated, 1);
  assert.equal(r.counts.skipped_exhibition, 13, 'teams outside this 8-team test league');
  assert.equal(r.counts.unmatched, 1, 'UTA @ LAL is in the league but not in this schedule');
  const g = await game(id);
  assert.deepEqual([g.status, g.home_score, g.away_score], ['final', 132, 101]);
  assert.equal(await count(db, 'entity_id_crosswalk', `entity_type = 'game' AND source = 'highlightly' AND source_id = '1439038'`), 1);
  assert.equal(await count(db, 'games'), 1, 'update-only: no game inserted for the 14 unmatched');
});

test('Highlightly never creates games or touches the nba_stats game crosswalk (Q1, D14)', { skip }, async () => {
  await seedLalGs();
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) SELECT 'game', id::text, 'nba_stats', '0012600001' FROM games`);
  const dir = synthDir({ ...day('2026-10-06', [lalGs(), lalGs({ id: 777, date: '2026-10-07T01:00:00.000Z', homeTeam: { id: 45, abbreviation: 'UTAH' }, awayTeam: { id: 3, abbreviation: 'DEN' } })]) });
  const before = [await count(db, 'games'), await count(db, 'entity_id_crosswalk', `source = 'nba_stats' AND entity_type = 'game'`)];
  const r = await run(dir, { daysBack: 0, daysAhead: 0 });
  assert.equal(r.counts.unmatched, 1);
  assert.match(r.lists.unmatched[0], /DEN@UTAH .*no game in our schedule/);
  assert.deepEqual([await count(db, 'games'), await count(db, 'entity_id_crosswalk', `source = 'nba_stats' AND entity_type = 'game'`)], before);
});

test('a shifted tip-off is applied when NBA.com did not load (Q9) and the log line has old and new', { skip }, async () => {
  const id = await seedLalGs();
  const r = await run(synthDir(day('2026-10-06', [lalGs({ date: '2026-10-07T03:00:00.000Z' })])), { daysAhead: 0 });
  assert.equal(r.counts.tip_changes, 1);
  assert.match(r.lists.tip_changes[0], /LAL@GS 2026-10-07 2026-10-07T02:00:00.000Z -> 2026-10-07T03:00:00.000Z/);
  assert.equal(new Date((await game(id)).tipoff_utc).toISOString(), '2026-10-07T03:00:00.000Z');
});

test('tip-off authority off (NBA.com loaded this run): tip-offs untouched, status still follows, same result twice', { skip }, async () => {
  const id = await seedLalGs();
  const dir = synthDir(day('2026-10-06', [lalGs({ date: '2026-10-07T03:00:00.000Z', state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })]));
  for (let i = 0; i < 2; i++) await run(dir, { tipoffAuthority: false, daysAhead: 0 });
  const g = await game(id);
  assert.equal(new Date(g.tipoff_utc).toISOString(), '2026-10-07T02:00:00.000Z');
  assert.equal(g.status, 'postponed');
});

test('final and live games are left alone (status and scores)', { skip }, async () => {
  const fin = await seedLalGs({ status: 'final', home_score: 110, away_score: 100 });
  const live = await addGame(db, { home: 'DEN', away: 'UTA', local: '2026-10-06', tip: '2026-10-07T01:00:00Z', type: 'preseason', status: 'live' });
  const dir = synthDir(day('2026-10-06', [lalGs({ state: { description: 'Scheduled', score: { homeTeam: [1], awayTeam: [2] } } }),
    lalGs({ id: 888, date: '2026-10-07T01:00:00.000Z', homeTeam: { id: 3, abbreviation: 'DEN' }, awayTeam: { id: 45, abbreviation: 'UTAH' }, state: { description: 'Scheduled', score: { homeTeam: [], awayTeam: [] } } })]));
  const r = await run(dir, { daysAhead: 0 });
  assert.equal(r.counts.updated, 0);
  assert.equal(r.counts.skipped_final, 1);
  assert.equal(r.counts.skipped_worker, 1);
  assert.deepEqual([(await game(fin)).status, (await game(fin)).home_score], ['final', 110]);
  assert.equal((await game(live)).status, 'live');
});

test('postponed: status follows Highlightly', { skip }, async () => {
  const id = await seedLalGs();
  await run(synthDir(day('2026-10-06', [lalGs({ state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })])), { daysAhead: 0, tipoffAuthority: false });
  assert.equal((await game(id)).status, 'postponed');
});

test('exhibition / non-NBA side is skipped, not an error', { skip }, async () => {
  await seedLalGs();
  const r = await run(synthDir(day('2026-10-06', [lalGs({ id: 5, awayTeam: { id: 99999, abbreviation: 'LDN', name: 'London Lions' } })])), { daysAhead: 0 });
  assert.equal(r.counts.skipped_exhibition, 1);
  assert.equal(r.counts.unmatched, 0);
});

test('columns the schedule pass must not touch stay byte-identical', { skip }, async () => {
  const id = await seedLalGs({ arena_id: 2, is_neutral_site: false, national_tv_tier: 'major', national_broadcasters: ['ESPN', 'ABC'], cup_stage: 'group', type: 'regular' });
  const keep = `to_jsonb(g) - 'status' - 'tipoff_utc' - 'game_date_local' - 'updated_at' - 'home_score' - 'away_score'`;
  const beforeRow = (await one(db, `SELECT ${keep} AS r FROM games g WHERE id = $1`, [id])).r;
  await run(synthDir(day('2026-10-06', [lalGs({ date: '2026-10-07T03:00:00.000Z', state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })])), { daysAhead: 0 });
  assert.deepEqual((await one(db, `SELECT ${keep} AS r FROM games g WHERE id = $1`, [id])).r, beforeRow);
  assert.equal(beforeRow.national_tv_tier, 'major');
});

test('late west-coast tip: LAL home 2026-10-21, tip 03:30Z -> 04:00Z stays local 2026-10-21 (not the UTC date)', { skip }, async () => {
  const id = await addGame(db, { home: 'LAL', away: 'GSW', local: '2026-10-21', tip: '2026-10-22T03:30:00Z' });
  const r = await runSchedulePass(db, client(synthDir(day('2026-10-21', [lalGs({ date: '2026-10-22T04:00:00.000Z', homeTeam: { id: 4, abbreviation: 'LAL' }, awayTeam: { id: 43, abbreviation: 'GS' } })]))),
    { season: '2026-27', now: new Date('2026-10-21T15:00:00Z'), daysBack: 0, daysAhead: 0, tipoffAuthority: true });
  assert.equal(r.counts.tip_changes, 1);
  const g = await game(id);
  assert.equal(g.local, '2026-10-21');
  assert.equal(new Date(g.tipoff_utc).toISOString(), '2026-10-22T04:00:00.000Z');
});

test('tip-off moved a day: game_date_local and both teams\' rest / back-to-back tags are recomputed, nothing else', { skip }, async () => {
  const prev = await addGame(db, { home: 'LAL', away: 'DEN', local: '2026-10-20', tip: '2026-10-21T02:00:00Z', b2b: [1, null], rest: [null, null] });
  const id = await addGame(db, { home: 'LAL', away: 'GSW', local: '2026-10-21', tip: '2026-10-22T02:00:00Z', rest: [0, null], b2b: [2, null] });
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('game', $1, 'highlightly', '1545655')`, [id]);  // a >8 h move is only recognised by a linked match id
  const r = await runSchedulePass(db, client(synthDir(day('2026-10-21', [lalGs({ date: '2026-10-23T02:00:00.000Z', homeTeam: { id: 4, abbreviation: 'LAL' }, awayTeam: { id: 43, abbreviation: 'GS' } })]))),
    { season: '2026-27', now: new Date('2026-10-21T12:00:00Z'), daysBack: 0, daysAhead: 0, tipoffAuthority: true });
  assert.equal(r.counts.tip_changes, 1);
  assert.equal((await game(id)).local, '2026-10-22');
  assert.deepEqual(await one(db, `SELECT rest_days, b2b_night FROM team_games WHERE game_id = $1 AND team_id = ${T.LAL}`, [id]), { rest_days: 1, b2b_night: null });
  assert.deepEqual(await one(db, `SELECT rest_days, b2b_night FROM team_games WHERE game_id = $1 AND team_id = ${T.LAL}`, [prev]), { rest_days: null, b2b_night: null });
  assert.equal(r.counts.rest_rows, 2);
});

test('tip-off unchanged: no write to games or team_games', { skip }, async () => {
  await seedLalGs();
  const dir = synthDir(day('2026-10-06', [lalGs()]));
  await run(dir, { daysAhead: 0 });                                // first run adds the crosswalk row only
  const snap = [await fingerprint(db, 'games'), await fingerprint(db, 'team_games', '1, 2')];
  const r = await run(dir, { daysAhead: 0 });
  assert.equal(r.counts.updated, 0);
  assert.deepEqual([await fingerprint(db, 'games'), await fingerprint(db, 'team_games', '1, 2')], snap);
});

test('neutral-site tip-off change is reported (needs_nba), not applied', { skip }, async () => {
  const id = await seedLalGs({ is_neutral_site: true });
  const r = await run(synthDir(day('2026-10-06', [lalGs({ date: '2026-10-07T03:00:00.000Z' })])), { daysAhead: 0 });
  assert.equal(r.counts.needs_nba, 1);
  assert.equal(new Date((await game(id)).tipoff_utc).toISOString(), '2026-10-07T02:00:00.000Z');
});

test('a tip-off shift over 7 days is reported (needs_review), not applied', { skip }, async () => {
  const id = await seedLalGs();
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('game', $1, 'highlightly', '1545655')`, [id]);
  const r = await run(synthDir(day('2026-10-06', [lalGs({ date: '2026-10-20T03:00:00.000Z' })])), { daysAhead: 0 });
  assert.equal(r.counts.needs_review, 1);
  assert.equal(new Date((await game(id)).tipoff_utc).toISOString(), '2026-10-07T02:00:00.000Z');
});

test('crosswalk hit whose teams do not match (reused match id) -> unmatched, nothing linked or changed', { skip }, async () => {
  const other = await addGame(db, { home: 'DEN', away: 'UTA', local: '2026-10-06', tip: '2026-10-07T01:00:00Z', type: 'preseason' });
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('game', $1, 'highlightly', '1545655')`, [other]);
  const before = await game(other);
  const r = await run(synthDir(day('2026-10-06', [lalGs({ state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })])), { daysAhead: 0 });
  assert.match(r.lists.unmatched[0], /crosswalk team mismatch/);
  assert.deepEqual(await game(other), before);
});

test('a game in the live worker\'s window (tip-off -8 h .. +10 min) is skipped', { skip }, async () => {
  const id = await seedLalGs({ tip: '2026-10-07T02:00:00Z' });
  const r = await runSchedulePass(db, client(synthDir(day('2026-10-06', [lalGs({ state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })]))),
    { season: '2026-27', now: new Date('2026-10-07T01:55:00Z'), daysBack: 1, daysAhead: 0, tipoffAuthority: true });
  assert.equal(r.counts.skipped_worker, 1);
  assert.equal((await game(id)).status, 'scheduled');
});

test('a game changed by the worker between fetch and write is skipped, never overwritten', { skip }, async () => {
  const id = await seedLalGs();
  const dir = synthDir(day('2026-10-06', [lalGs({ state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })]));
  const r = await run(dir, { daysAhead: 0, hooks: { afterFetch: () => db.query(`UPDATE games SET status = 'live', updated_at = now() WHERE id = $1`, [id]) } });
  assert.equal(r.counts.skipped_changed, 1);
  assert.equal((await game(id)).status, 'live');
});

test('second run changes nothing (same updated_at)', { skip }, async () => {
  const id = await seedLalGs();
  const dir = synthDir(day('2026-10-06', [lalGs({ date: '2026-10-07T03:00:00.000Z' })]));
  await run(dir, { daysAhead: 0 });
  const first = await game(id);
  const r = await run(dir, { daysAhead: 0 });
  assert.equal(r.counts.updated, 0);
  assert.deepEqual(await game(id), first);
});

test('one malformed match does not stop the others', { skip }, async () => {
  const id = await seedLalGs();
  const bad = { id: 'x', homeTeam: {}, date: 'nope' };
  const r = await run(synthDir(day('2026-10-06', [bad, null, lalGs({ date: '2026-10-07T03:00:00.000Z' }), lalGs({ id: 31, season: 2031 })])), { daysAhead: 0 });
  assert.equal(r.counts.bad_matches, 3);
  assert.equal(r.counts.tip_changes, 1);
  assert.equal(new Date((await game(id)).tipoff_utc).toISOString(), '2026-10-07T03:00:00.000Z');
});

test('out-of-range scores are skipped and reported as bad matches; the next match is still processed (C3)', { skip }, async () => {
  const id = await seedLalGs();
  const bad = (score) => lalGs({ state: { description: 'Finished', score } });
  for (const score of [{ homeTeam: [99999], awayTeam: [100] }, { homeTeam: [-5, 20], awayTeam: [100] }, { homeTeam: [20.5], awayTeam: [10] }, { homeTeam: ['x'], awayTeam: [1] }, { homeTeam: [120, 120, 120, 120], awayTeam: [1] }]) {
    const r = await run(synthDir(day('2026-10-06', [bad(score)])), { daysAhead: 0, tipoffAuthority: false });
    assert.equal(r.counts.bad_matches, 1, JSON.stringify(score));
    assert.match(r.lists.bad_matches[0], /bad score/);
    const g = await game(id);
    assert.deepEqual([g.status, g.home_score], ['scheduled', null]);
  }
  const ok = await run(synthDir(day('2026-10-06', [lalGs({ id: 42, season: 2027, homeTeam: { id: 3, abbreviation: 'DEN' }, awayTeam: { id: 45, abbreviation: 'UTAH' }, state: { description: 'Finished', score: { homeTeam: [1e9], awayTeam: [1] } } }),
    lalGs({ state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } } })])), { daysAhead: 0, tipoffAuthority: false });
  assert.equal(ok.counts.bad_matches, 1);
  assert.equal((await game(id)).status, 'postponed');
});

test('a whole malformed response fails the pass and writes nothing', { skip }, async () => {
  await seedLalGs();
  const dir = synthDir({ ...day('2026-10-05', []) });
  const fs = await import('node:fs'); fs.writeFileSync(`${dir}/matches_2026-10-06.json`, 'this is not json');
  const snap = [await fingerprint(db, 'games'), await count(db, 'entity_id_crosswalk')];
  await assert.rejects(run(dir, { daysBack: 0, daysAhead: 1 }), /malformed/);
  assert.deepEqual([await fingerprint(db, 'games'), await count(db, 'entity_id_crosswalk')], snap);
});

test('dates are fetched nearest first: under a cap of 3 only today, -1 and +1 are requested', { skip }, async () => {
  const dir = synthDir({}, { copyRecorded: true });
  const urls = [];
  const inner = fixtureFetch(dir);
  const hl = createWeeklyHighlightly({ fetchImpl: (u, i) => { urls.push(u); return inner(u, i); }, budget: 3, now: () => 0, sleep: async () => {} });
  const r = await runSchedulePass(db, hl, { season: '2026-27', now: NOW, daysBack: 7, daysAhead: 60, tipoffAuthority: true });
  assert.equal(r.stop, 'cap');
  assert.deepEqual(urls.map((u) => /date=([\d-]+)/.exec(u)[1]), ['2026-10-06', '2026-10-05', '2026-10-07']);
  assert.equal(r.counts.dates_done, 3);
});

test('dry run: the database is unchanged and the counts show what would happen', { skip }, async () => {
  await seedLalGs();
  const snap = [await fingerprint(db, 'games'), await fingerprint(db, 'team_games', '1, 2'), await count(db, 'entity_id_crosswalk', `source = 'highlightly' AND entity_type = 'game'`)];
  const r = await run(synthDir(day('2026-10-06', [lalGs({ date: '2026-10-07T03:00:00.000Z' })])), { daysAhead: 0, dryRun: true });
  assert.equal(r.counts.tip_changes, 1);
  assert.deepEqual([await fingerprint(db, 'games'), await fingerprint(db, 'team_games', '1, 2'), await count(db, 'entity_id_crosswalk', `source = 'highlightly' AND entity_type = 'game'`)], snap);
});

test('Q11 sweep: refused unless the live header says more than 3,000 remain', { skip }, async () => {
  for (const [remaining, refused] of [[2500, true], [3500, false]]) {
    await resetSchema(db);
    await seedLalGs();                                                     // season games span 2026-10-06 ..
    await addGame(db, { home: 'HOU', away: 'MEM', local: '2026-10-12', tip: '2026-10-13T00:00:00Z', type: 'preseason' });
    const dir = synthDir({}, { copyRecorded: true });
    putQuota(dir, { limit: 7500, remaining });
    const r = await run(dir, { daysBack: 0, daysAhead: 0, sweep: { enabled: true, threshold: 3000 } });
    assert.equal(r.sweep.startsWith('refused'), refused, r.sweep);
    assert.equal(r.counts.sweep_dates, refused ? 0 : 6, 'the dates 2026-10-07 .. 10-12 that the normal window did not cover');
  }
});

test('team time-zone map covers every team seeded here and is a valid zone for each of the 30 clubs', () => {
  assert.equal(Object.keys(TEAM_TZ).length, 30);
  for (const [, ab] of TEAMS) assert.ok(TEAM_TZ[ab], ab);
  for (const ab of Object.keys(TEAM_TZ)) assert.match(localDate('2026-10-22T03:30:00Z', ab), /^2026-10-2[12]$/);
  assert.equal(localDate('2026-10-22T03:30:00Z', 'LAL'), '2026-10-21');
  assert.equal(localDate('2026-10-22T03:30:00Z', 'BOS'), '2026-10-21');
  assert.equal(localDate('2026-10-22T03:30:00Z', 'ZZZ'), null);
});
