// CLI for the weekly Highlightly step (M6 T5): spawned as a child with fixtures, a fake key and the test DB.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { etDate } from '../src/map.js';
import { addGame, connect, count, fingerprint, one, resetSchema, skip, url } from './helpers/db.js';
import { match, putMeta, putQuota, recorded, synthDir } from './helpers/fx.js';

const SCRIPT = new URL('../scripts/weekly-hl.js', import.meta.url).pathname;
const KEY = 'test-key-DO-NOT-LOG-abcdef0123456789';
let db;
before(async () => { if (!skip) db = await connect(); });
after(async () => { if (db) await db.end(); });
beforeEach(async () => { if (!skip) await resetSchema(db); });

function exec(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err, last: out.trim().split('\n').at(-1) }));
  });
}
const envFile = (text) => { const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'cli_env_')), 'env'); writeFileSync(f, text); return f; };
const baseEnv = (dir, extra = {}) => ({ DATABASE_PUBLIC_URL: url, HIGHLIGHTLY_FIXTURES: dir, HIGHLIGHTLY_API_KEY: KEY, WEEKLY_HL_ENV_FILE: envFile('DATABASE_URL=postgres://nobody@127.0.0.1:1/nope\n'),
  WEEKLY_HL_RPS: '10', WEEKLY_HL_DAYS_BACK: '1', WEEKLY_HL_DAYS_AHEAD: '2', WEEKLY_RUN_ID: 'run-test-1', WEEKLY_HL_TIPOFF: '1', WEEKLY_NBA_STATE: 'down', ...extra });
const parse = (r) => { assert.match(r.last, /^@@WEEKLY \{/); return JSON.parse(r.last.slice(8)); };

// A game tomorrow (ET) that Highlightly reports as postponed an hour later. Dir has the day's matches file.
async function setup() {
  const tip = new Date(Date.now() + 30 * 3600e3);
  tip.setUTCMinutes(0, 0, 0);
  const d = etDate(tip);
  const season = tip.getUTCMonth() >= 9 ? `${tip.getUTCFullYear()}-${String((tip.getUTCFullYear() + 1) % 100).padStart(2, '0')}` : `${tip.getUTCFullYear() - 1}-${String(tip.getUTCFullYear() % 100).padStart(2, '0')}`;
  const id = await addGame(db, { home: 'GSW', away: 'LAL', local: d, tip: tip.toISOString(), type: 'regular', season });
  const m = match({ id: 1545655, season: Number(season.slice(0, 4)) + 1, date: new Date(tip.getTime() + 3600e3).toISOString(), state: { description: 'Postponed', score: { homeTeam: [], awayTeam: [] } },
    homeTeam: { id: 43, abbreviation: 'GS' }, awayTeam: { id: 4, abbreviation: 'LAL' } });
  const dir = synthDir({ [`matches_${d}`]: { data: [m], pagination: { totalCount: 1 } } });
  return { id, dir, season, d };
}

test('schedule: result line is valid JSON, the run is recorded as source=highlightly with counts and requests, and no key anywhere', { skip }, async () => {
  const { id, dir, season } = await setup();
  const r = await exec(['schedule', '--season', season], baseEnv(dir));
  assert.equal(r.code, 0, r.err);
  const res = parse(r);
  assert.deepEqual([res.v, res.step, res.degraded, res.nba, res.stop, res.reason], [1, 'schedule:hl', false, 'n/a', null, null]);
  assert.ok(res.hl.requests >= 3);
  assert.match(r.out, /\[hl schedule\] source=highlightly dates=\d+\/\d+ matches=1 updated=1 tip_changes=1 /);
  const run = await one(db, `SELECT job_type, source, triggered_by, status, details::text AS d FROM ingestion_runs`);
  assert.deepEqual([run.job_type, run.source, run.triggered_by, run.status], ['weekly_hl_schedule', 'highlightly', 'schedule', 'success']);
  const details = JSON.parse(run.d);
  assert.equal(details.counts.updated, 1);
  assert.equal(details.weekly_run_id, 'run-test-1');
  assert.equal(details.nba_state, 'down');
  assert.ok(details.requests.total >= 3);
  for (const text of [r.out, r.err, run.d]) assert.ok(!text.includes(KEY));
  assert.equal((await one(db, `SELECT status FROM games WHERE id = $1`, [id])).status, 'postponed');
});

test('.env DATABASE_URL is ignored and the process env DATABASE_PUBLIC_URL wins', { skip }, async () => {
  const { dir, season } = await setup();
  const r = await exec(['schedule', '--season', season], baseEnv(dir, { WEEKLY_HL_ENV_FILE: envFile('DATABASE_URL=postgres://nobody@127.0.0.1:1/nope\nDATABASE_PUBLIC_URL=postgres://nobody@127.0.0.1:1/nope\n') }));
  assert.equal(r.code, 0, r.err);
});

test('the key is masked in everything the process prints, even when vendor data contains it', { skip }, async () => {
  // a player in the box score is named exactly like the key; he is "created" and listed in the log
  const rec = recorded('box-score_1439038');
  rec[0].boxScores.at(-1).player.name = KEY;
  const gid = await addGame(db, { home: 'HOU', away: 'MEM', local: '2026-04-12', tip: new Date(Date.now() - 2 * 24 * 3600e3).toISOString(), status: 'final', home_score: 132, away_score: 101, season: '2025-26' });
  const tip = new Date(Date.now() - 2 * 24 * 3600e3);
  const dir = synthDir({ 'box-score_1439038': rec, [`matches_${etDate(tip)}`]: { data: [{ ...recorded('matches_2026-04-12').data[0], date: tip.toISOString() }], pagination: { totalCount: 1 } } }, { copyRecorded: false });
  copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/weekly/recorded/lineups_1439038.json'), path.join(dir, 'lineups_1439038.json'));
  const r = await exec(['backfill', '--season', '2025-26'], baseEnv(dir, { WEEKLY_HL_DAYS_BACK: '5' }));
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /created: .*\[redacted\]/);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  assert.ok(!(await one(db, `SELECT details::text AS d FROM ingestion_runs`)).d.includes(KEY));
  assert.ok(gid);
});

test('C1: a key that exists ONLY in the env file (not the process env) is masked too, even as a vendor name', { skip }, async () => {
  const rec = recorded('box-score_1439038');
  rec[0].boxScores.at(-1).player.name = KEY;
  await addGame(db, { home: 'HOU', away: 'MEM', local: '2026-04-12', tip: new Date(Date.now() - 2 * 24 * 3600e3).toISOString(), status: 'final', home_score: 132, away_score: 101, season: '2025-26' });
  const tip = new Date(Date.now() - 2 * 24 * 3600e3);
  const dir = synthDir({ 'box-score_1439038': rec, [`matches_${etDate(tip)}`]: { data: [{ ...recorded('matches_2026-04-12').data[0], date: tip.toISOString() }], pagination: { totalCount: 1 } } });
  copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/weekly/recorded/lineups_1439038.json'), path.join(dir, 'lineups_1439038.json'));
  const env = baseEnv(dir, { WEEKLY_HL_DAYS_BACK: '5', WEEKLY_HL_ENV_FILE: envFile(`HIGHLIGHTLY_API_KEY=${KEY}\n`) });
  delete env.HIGHLIGHTLY_API_KEY;
  const r = await exec(['backfill', '--season', '2025-26'], env);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /\[redacted\]/);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

test('R3-3: unterminated output before the result line does not swallow it (result line starts on a fresh line)', { skip }, async () => {
  const { dir, season } = await setup();
  const hook = path.join(mkdtempSync(path.join(os.tmpdir(), 'cli_hook_')), 'hook.mjs');
  writeFileSync(hook, "process.stdout.write('no newline here');\n");
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', hook, SCRIPT, 'schedule', '--season', season], { env: { PATH: process.env.PATH, ...baseEnv(dir) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 0);
  assert.ok(r.out.split('\n').some((l) => l.startsWith('@@WEEKLY {')), r.out);
});

test('dry run writes no ingestion_runs row and changes nothing', { skip }, async () => {
  const { dir, season } = await setup();
  const snap = [await fingerprint(db, 'games'), await count(db, 'entity_id_crosswalk')];
  const r = await exec(['schedule', '--season', season, '--dry-run'], baseEnv(dir));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /updated=1/);
  assert.equal(await count(db, 'ingestion_runs'), 0);
  assert.deepEqual([await fingerprint(db, 'games'), await count(db, 'entity_id_crosswalk')], snap);
});

test('request cap from the runner (WEEKLY_HL_BUDGET=2): clean stop, exit 0, degraded with stop=cap', { skip }, async () => {
  const { dir, season } = await setup();
  const r = await exec(['schedule', '--season', season], baseEnv(dir, { WEEKLY_HL_BUDGET: '2' }));
  assert.equal(r.code, 0, r.err);
  const res = parse(r);
  assert.deepEqual([res.degraded, res.stop, res.hl.requests], [true, 'cap', 2]);
  assert.equal((await one(db, `SELECT details->>'stop' AS s FROM ingestion_runs`)).s, 'cap');
});

test('reserve from the last header value handed over by the runner: no request at all', { skip }, async () => {
  const { dir, season } = await setup();
  const r = await exec(['schedule', '--season', season], baseEnv(dir, { WEEKLY_HL_LAST_REMAINING: '1000' }));
  assert.equal(r.code, 0);
  const res = parse(r);
  assert.deepEqual([res.stop, res.hl.requests, res.degraded], ['reserve', 0, true]);
});

test('Q11 full-season sweep: refused at remaining 2500, runs at 3500 (extra dates fetched)', { skip }, async () => {
  const { dir, season, d } = await setup();
  await addGame(db, { home: 'HOU', away: 'MEM', local: new Date(Date.parse(`${d}T12:00:00Z`) + 9 * 86400e3).toISOString().slice(0, 10), tip: new Date(Date.now() + 10 * 86400e3).toISOString(), season });
  const results = {};
  for (const remaining of [2500, 3500]) {
    putQuota(dir, { limit: 7500, remaining });
    const r = await exec(['schedule', '--season', season], baseEnv(dir, { WEEKLY_HL_FULL_SEASON: '1' }));
    assert.equal(r.code, 0, r.err);
    results[remaining] = { res: parse(r), out: r.out };
  }
  assert.match(results[2500].out, /full-season sweep refused \(remaining 24\d\d <= 3000\)/);
  assert.match(results[3500].out, /full-season sweep: running/);
  assert.ok(results[3500].res.hl.requests > results[2500].res.hl.requests);
  const off = await exec(['schedule', '--season', season], baseEnv(dir, { WEEKLY_HL_FULL_SEASON: '' }));
  assert.ok(!off.out.includes('sweep'), 'off by default');
});

test('Highlightly auth error: exit 1, the result line names it, the run row is failed', { skip }, async () => {
  const { dir, season, d } = await setup();
  putMeta(dir, `matches_${d}`, { status: 401, rawBody: KEY });
  const r = await exec(['schedule', '--season', season], baseEnv(dir));
  assert.equal(r.code, 1);
  const res = parse(r);
  assert.equal(res.reason, 'highlightly auth rejected (401)');
  const run = await one(db, `SELECT status, error FROM ingestion_runs`);
  assert.deepEqual([run.status, run.error], ['failed', 'highlightly auth rejected (401)']);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

test('bad usage and bad configuration: exit 1 with a result line, nothing connected', { skip }, async () => {
  const dir = synthDir({});
  for (const [args, env] of [[['nonsense'], {}], [['schedule', '--season', 'x'], {}], [['schedule', '--season', '2026-27'], { WEEKLY_HL_CAP: '601' }],
    [['schedule', '--season', '2026-27'], { WEEKLY_HL_RESERVE: '999' }], [['schedule', '--season', '2026-27', '--key', KEY], {}]]) {
    const r = await exec(args, baseEnv(dir, env));
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(parse(r).degraded, false);
    assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  }
  assert.equal(await count(db, 'ingestion_runs'), 0);
});

test('no key and no fixtures: refuses before any request', { skip }, async () => {
  const r = await exec(['schedule', '--season', '2026-27'], { DATABASE_PUBLIC_URL: url, WEEKLY_HL_ENV_FILE: envFile('') });
  assert.equal(r.code, 1);
  assert.equal(parse(r).reason, 'HIGHLIGHTLY_API_KEY is not set');
});

test('the private Railway host is refused', { skip }, async () => {
  const r = await exec(['schedule', '--season', '2026-27'], baseEnv(synthDir({}), { DATABASE_PUBLIC_URL: 'postgres://u:p@postgres.railway.internal:5432/railway' }));
  assert.equal(r.code, 1);
  assert.match(parse(r).reason, /private Railway host/);
});
