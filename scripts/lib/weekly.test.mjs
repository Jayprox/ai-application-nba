import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, dumpName, prodGuard } from './backup.mjs';
import {
  loadWeeklyConfig, weeklyGuard, WEEKLY_GUARD_MSG, BACKUP_BIN_SET_MSG, FAKE_ISOLATION_MSG, LONG_LINE_MARKER, fakeIsolationError, findFreshBackup, backupLockState,
  buildTunnelUrl, stepEnv, stepArgv, lineRedactor, STEPS, BACKUP_BUSY_LINE,
  SUBSTEPS, planSteps, INTERNAL_ENV, parseResultLine, newRunState, applyResult, budgetLeft, stepExtra, finalLine, NOTIFY_TEXT,
  fixtureGuardError, FIXTURES_ON_PROD_MSG, FAKE_NEEDS_FIXTURES_MSG,
} from './weekly.mjs';
import { parseTunnelOutput } from './backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_BIN = path.join(ROOT, 'scripts/fixtures/fake-railway.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- config / ports ----
test('weekly config: default tunnel port is 55434 and the lock is not the backup lock', () => {
  const c = loadWeeklyConfig({}, { home: '/h' });
  assert.equal(c.port, 55434);
  assert.equal(c.season, '2026-27');
  assert.equal(c.backupWaitS, 600);
  assert.equal(c.stepTimeoutS, 3600);
  assert.equal(c.lockDir, '/h/Library/Logs/chalk-that-nba/weekly.lock');
  assert.notEqual(c.lockDir, c.backup.lockDir);
});

test('weekly config: ports 55432, 55433 and the effective backup port are rejected', () => {
  for (const p of ['55432', '55433']) assert.throws(() => loadWeeklyConfig({ WEEKLY_TUNNEL_PORT: p }), /must not be 55432, 55433 or the backup tunnel port/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_TUNNEL_PORT: '58000', BACKUP_TUNNEL_PORT: '58000' }), /backup tunnel port/);
  assert.equal(loadWeeklyConfig({ WEEKLY_TUNNEL_PORT: '58001', BACKUP_TUNNEL_PORT: '58000' }).port, 58001);
});

test('weekly config: bad port, wait, timeout, season and bin are rejected', () => {
  for (const p of ['abc', '1.5', '1023', '65536', '-1']) assert.throws(() => loadWeeklyConfig({ WEEKLY_TUNNEL_PORT: p }), /WEEKLY_TUNNEL_PORT/, p);
  for (const w of ['0', '601', 'x']) assert.throws(() => loadWeeklyConfig({ WEEKLY_BACKUP_WAIT_S: w }), /WEEKLY_BACKUP_WAIT_S/, w);
  assert.equal(loadWeeklyConfig({ WEEKLY_BACKUP_WAIT_S: '600' }).backupWaitS, 600);
  assert.equal(loadWeeklyConfig({ WEEKLY_BACKUP_WAIT_S: '1' }).backupWaitS, 1);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_STEP_TIMEOUT_S: '14401' }), /WEEKLY_STEP_TIMEOUT_S/);
  assert.throws(() => loadWeeklyConfig({}, { season: '2026-2027' }), /season/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_RAILWAY_BIN: 'railway' }), /absolute/);
});

test('weekly config: WEEKLY_STATE_DIR equal to the backup log dir is refused only if the locks collide', () => {
  // weekly.lock and backup.lock are different names, so the same directory is fine
  const c = loadWeeklyConfig({ WEEKLY_STATE_DIR: '/x', BACKUP_LOG: '/x/backup.log' });
  assert.equal(c.lockDir, '/x/weekly.lock');
  assert.equal(c.backup.lockDir, '/x/backup.lock');
});

// ---- guard ----
test('weeklyGuard: the weekly flag must be exactly 1 and the backup flag is needed too', () => {
  const real = { WEEKLY_RAILWAY_BIN: '/opt/homebrew/bin/railway' };
  assert.equal(weeklyGuard({}), WEEKLY_GUARD_MSG);
  for (const v of [undefined, '', 'true', 'yes', '01', ' 1', '0', '11']) {
    assert.equal(weeklyGuard({ ...real, WEEKLY_CONFIRM_PROD: v, BACKUP_CONFIRM_PROD: '1' }), WEEKLY_GUARD_MSG, String(v));
  }
  assert.equal(weeklyGuard({ WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: '1' }), null);
  assert.equal(weeklyGuard({ WEEKLY_CONFIRM_PROD: '1' }), WEEKLY_GUARD_MSG, 'weekly flag without the backup flag');
  assert.equal(weeklyGuard({ BACKUP_CONFIRM_PROD: '1' }), WEEKLY_GUARD_MSG, 'backup flag without the weekly flag');
  assert.equal(weeklyGuard({ WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: 'true' }), WEEKLY_GUARD_MSG);
});

test('weeklyGuard: a production run refuses any BACKUP_RAILWAY_BIN', () => {
  const both = { WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: '1' };
  assert.equal(weeklyGuard({ ...both, BACKUP_RAILWAY_BIN: FAKE_BIN }), BACKUP_BIN_SET_MSG, 'fake backup bin');
  assert.equal(weeklyGuard({ ...both, BACKUP_RAILWAY_BIN: '/usr/local/bin/railway' }), BACKUP_BIN_SET_MSG, 'other absolute path');
  assert.equal(weeklyGuard({ ...both, WEEKLY_RAILWAY_BIN: '/opt/homebrew/bin/railway', BACKUP_RAILWAY_BIN: FAKE_BIN }), BACKUP_BIN_SET_MSG);
  assert.equal(weeklyGuard({ ...both }), null, 'unset still passes');
  assert.equal(weeklyGuard({ ...both, BACKUP_RAILWAY_BIN: '' }), null, 'empty counts as unset');
});

test('fakeIsolationError: a fake run may not point the backup at the real volume, folder or log', () => {
  const home = path.join(tmp, 'home');
  const W = path.join(tmp, 'iso');
  const fake = { WEEKLY_RAILWAY_BIN: FAKE_BIN, BACKUP_RAILWAY_BIN: FAKE_BIN };
  const iso = { BACKUP_VOLUME: W, BACKUP_DIR: path.join(W, 'b'), BACKUP_LOG: path.join(W, 'backup.log') };
  const err = (extra) => {
    const env = { ...fake, ...iso, ...extra };
    return fakeIsolationError(loadWeeklyConfig(env, { home }), env, { home });
  };
  assert.equal(err({}), null, 'drill-style paths are accepted');
  // defaults (no BACKUP_* overrides at all)
  const envD = { ...fake };
  assert.equal(fakeIsolationError(loadWeeklyConfig(envD, { home }), envD, { home }), FAKE_ISOLATION_MSG, 'defaults');
  assert.equal(err({ BACKUP_VOLUME: '/Volumes/DB-Backups' }), FAKE_ISOLATION_MSG, 'volume');
  assert.equal(err({ BACKUP_VOLUME: '/Volumes/DB-Backups/' }), FAKE_ISOLATION_MSG, 'volume, trailing slash');
  assert.equal(err({ BACKUP_DIR: '/Volumes/DB-Backups' }), FAKE_ISOLATION_MSG, 'dir equal');
  assert.equal(err({ BACKUP_DIR: '/Volumes/DB-Backups/sub/../x' }), FAKE_ISOLATION_MSG, 'dir under');
  assert.equal(err({ BACKUP_LOG: path.join(home, 'Library/Logs/chalk-that-nba/backup.log') }), FAKE_ISOLATION_MSG, 'log');
  assert.equal(err({ BACKUP_DIR: '/Volumes/DB-Backups-other/x' }), null, 'a sibling name is not the real folder');
  // a real (non-fake) weekly is not this check's business
  const real = { WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: '1' };
  assert.equal(fakeIsolationError(loadWeeklyConfig(real, { home }), real, { home }), null);
});

test('weeklyGuard: only the repo fake (by realpath) is exempt, and only with a fake backup bin', () => {
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: FAKE_BIN, BACKUP_RAILWAY_BIN: FAKE_BIN }), null);
  // fake weekly with a real (unset) backup bin is refused
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: FAKE_BIN }), WEEKLY_GUARD_MSG);
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: FAKE_BIN, BACKUP_RAILWAY_BIN: '/opt/homebrew/bin/railway' }), WEEKLY_GUARD_MSG);
  // a backup flag does not rescue a mixed run where the backup would be real... it is the bin that counts
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: FAKE_BIN, BACKUP_CONFIRM_PROD: '1' }), WEEKLY_GUARD_MSG);
  // a copy and a symlink to another file are not the fake
  const copy = path.join(tmp, 'railway-copy.sh');
  fs.copyFileSync(FAKE_BIN, copy);
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: copy, BACKUP_RAILWAY_BIN: FAKE_BIN }), WEEKLY_GUARD_MSG);
  const other = path.join(tmp, 'other.sh'); fs.writeFileSync(other, '#!/bin/sh\n');
  const ln = path.join(tmp, 'ln-other'); fs.symlinkSync(other, ln);
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: ln, BACKUP_RAILWAY_BIN: FAKE_BIN }), WEEKLY_GUARD_MSG);
  const ln2 = path.join(tmp, 'ln-fake'); fs.symlinkSync(FAKE_BIN, ln2);
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: ln2, BACKUP_RAILWAY_BIN: FAKE_BIN }), null, 'symlink that resolves to the fake');
  assert.equal(weeklyGuard({ WEEKLY_RAILWAY_BIN: path.join(tmp, 'missing'), BACKUP_RAILWAY_BIN: FAKE_BIN }), WEEKLY_GUARD_MSG);
});

test('prodGuard still behaves as before (wrapper over confirmGuard)', () => {
  assert.equal(prodGuard({}), 'production run not confirmed (set BACKUP_CONFIRM_PROD=1)');
  assert.equal(prodGuard({ BACKUP_CONFIRM_PROD: '1' }), null);
  assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: FAKE_BIN }), null);
});

// ---- findFreshBackup ----
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const ago = (ms) => dumpName(new Date(NOW - ms));
const H = 3600 * 1000;
function setup(files, { okFor = null, extraLog = '' } = {}) {
  const vol = fs.mkdtempSync(path.join(tmp, 'v-'));
  const dir = path.join(vol, 'db-backups'); fs.mkdirSync(dir);
  const logPath = path.join(vol, 'backup.log');
  let log = extraLog;
  for (const [name, spec] of Object.entries(files)) {
    const f = path.join(dir, name);
    if (spec === 'link') { fs.writeFileSync(path.join(vol, 'target'), 'data'); fs.symlinkSync(path.join(vol, 'target'), f); }
    else fs.writeFileSync(f, spec === 'empty' ? '' : 'data');
    if (okFor === null ? DUMP_OK(name, spec) : okFor.includes(name)) log += `2026-11-03T11:00:00Z OK   file=${name} size=1.0MB kept=1 deleted=0 duration=5s\n`;
  }
  fs.writeFileSync(logPath, log);
  return { volume: vol, dir, logPath };
}
const DUMP_OK = () => true;
const mount = () => true;
const find = (b) => findFreshBackup(b, { now: NOW, mountCheck: mount })?.name ?? null;

test('findFreshBackup: reuses a backup 1 h old and one 23 h 59 m old, not one 24 h old', () => {
  const a = ago(H), b = ago(23 * H + 59 * 60000), c = ago(24 * H);
  assert.equal(find(setup({ [a]: 'ok' })), a);
  assert.equal(find(setup({ [b]: 'ok' })), b);
  assert.equal(find(setup({ [c]: 'ok' })), null);
});

test('findFreshBackup: needs the OK line for exactly that name', () => {
  const a = ago(H), b = ago(2 * H);
  assert.equal(find(setup({ [a]: 'ok' }, { okFor: [] })), null, 'no OK line');
  assert.equal(find(setup({ [a]: 'ok' }, { okFor: [b] })), null, 'OK line for another name');
  assert.equal(find(setup({ [a]: 'ok', [b]: 'ok' }, { okFor: [b] })), b, 'falls back to the older name that has its OK line');
  assert.equal(find(setup({ [a]: 'ok' }, { okFor: [], extraLog: `2026-11-03T11:00:00Z FAIL stage=rotate reason="dump ${a} saved but rotation failed"\n` })), null);
});

test('findFreshBackup: rejects future stamps, partials, symlinks, empty files and foreign names', () => {
  const fut = dumpName(new Date(NOW + 10 * 60000));
  assert.equal(find(setup({ [fut]: 'ok' })), null, 'future');
  const p = ago(H) + '.partial';
  assert.equal(find(setup({ [p]: 'ok' })), null, '.partial');
  const l = ago(H);
  assert.equal(find(setup({ [l]: 'link' })), null, 'symlink');
  assert.equal(find(setup({ [l]: 'empty' })), null, 'size 0');
  assert.equal(find(setup({ 'chalk-that-nba_manual.dump': 'ok' }, { okFor: ['chalk-that-nba_manual.dump'] })), null, 'manual name');
});

test('findFreshBackup: picks the newest; unmounted volume or missing dir gives none', () => {
  const a = ago(5 * H), b = ago(H), c = ago(10 * H);
  assert.equal(find(setup({ [a]: 'ok', [b]: 'ok', [c]: 'ok' })), b);
  const s = setup({ [b]: 'ok' });
  assert.equal(findFreshBackup(s, { now: NOW, mountCheck: () => false }), null);
  assert.equal(findFreshBackup({ ...s, dir: path.join(s.volume, 'nope') }, { now: NOW, mountCheck: mount }), null);
  assert.equal(findFreshBackup({ ...s, logPath: path.join(s.volume, 'no.log') }, { now: NOW, mountCheck: mount }), null);
});

test('findFreshBackup: reports the age', () => {
  const r = findFreshBackup(setup({ [ago(3 * H)]: 'ok' }), { now: NOW, mountCheck: mount });
  assert.equal(r.ageMs, 3 * H);
});

// ---- backup lock ----
test('backupLockState: none, live pid, dead pid, EPERM counts as live', () => {
  const d = path.join(tmp, 'locks'); fs.mkdirSync(d);
  const lock = path.join(d, 'backup.lock');
  assert.equal(backupLockState(lock), 'none');
  fs.mkdirSync(lock);
  assert.equal(backupLockState(lock), 'stale', 'no pid file');
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  assert.equal(backupLockState(lock), 'live');
  fs.writeFileSync(path.join(lock, 'pid'), '999999');
  assert.equal(backupLockState(lock, { kill: () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; } }), 'stale');
  assert.equal(backupLockState(lock, { kill: () => { const e = new Error('x'); e.code = 'EPERM'; throw e; } }), 'live');
  assert.ok(fs.existsSync(lock), 'read only: the lock is never removed');
});

test('the backup-busy stderr line is matched exactly', () => {
  assert.ok(BACKUP_BUSY_LINE.test('2026-11-03T10:00:00Z FAIL stage=preflight reason="another backup is running" duration=0s'));
  assert.ok(!BACKUP_BUSY_LINE.test('2026-11-03T10:00:00Z FAIL stage=dump reason="another backup is running" duration=0s'));
});

// ---- credentials ----
test('buildTunnelUrl round-trips a password with @:/%#? in it', () => {
  const creds = { user: 'post:gres', password: 'p@ss:w/rd%1#x?y', database: 'rail way' };
  const url = buildTunnelUrl(creds, 55434);
  assert.match(url, /^postgres:\/\/[^@/]+@127\.0\.0\.1:55434\/[^/]+$/);
  assert.deepEqual(parseTunnelOutput(url + '\n', 55434), creds);
  assert.equal(new URL(url).password, encodeURIComponent(creds.password));
});

test('stepEnv adds the URL, strips both prod flags and leaves the input unchanged', () => {
  const base = { PATH: '/bin', WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: '1', DATABASE_PUBLIC_URL: 'postgres://stale@x/y', KEEP: 'a' };
  const copy = { ...base };
  const e = stepEnv(base, 'postgres://u:p@127.0.0.1:55434/d');
  assert.deepEqual(base, copy);
  assert.equal(e.DATABASE_PUBLIC_URL, 'postgres://u:p@127.0.0.1:55434/d');
  assert.equal('WEEKLY_CONFIRM_PROD' in e, false);
  assert.equal('BACKUP_CONFIRM_PROD' in e, false);
  assert.equal(e.KEEP, 'a');
  assert.equal(e.PATH, '/bin');
});

test('lineRedactor masks a password split across two chunks and any postgres:// token', () => {
  const out = [];
  const r = lineRedactor(['s3cr3t-pw'], (l) => out.push(l));
  r.push('connecting with s3cr3');
  r.push('t-pw now\nsecond line postgres://u:other@127.0.0.1:1/d tail\n');
  r.push('no newline s3cr3t-pw');
  r.flush();
  assert.deepEqual(out, ['connecting with [redacted] now', 'second line [redacted-url] tail', 'no newline [redacted]']);
  assert.ok(!out.join('\n').includes('s3cr3t-pw'));
});

test('lineRedactor masks the percent-encoded form too', () => {
  const out = [];
  const r = lineRedactor(['p@ss'], (l) => out.push(l));
  r.push('x p%40ss y\n');
  assert.deepEqual(out, ['x [redacted] y']);
});

test('lineRedactor never writes part of a secret when a line passes 64 KB', () => {
  const secret = 'Zq8-very-secret-pw-91';
  const out = [];
  const r = lineRedactor([secret], (l) => out.push(l));
  r.push('a'.repeat(65000) + secret + 'b'.repeat(1012) + '\nnext\n');
  r.flush();
  const all = out.join('\n');
  for (let i = 0; i + 4 <= secret.length; i++) assert.ok(!all.includes(secret.slice(i, i + 4)), secret.slice(i, i + 4));
  assert.ok(out.includes(LONG_LINE_MARKER));
  assert.ok(out.includes('next'));
});

test('lineRedactor drops an over-long line across pushes and resumes at the next newline', () => {
  const secret = 'Zq8-very-secret-pw-91';
  const out = [];
  const r = lineRedactor([secret], (l) => out.push(l));
  r.push('a'.repeat(65000) + secret.slice(0, 9));
  r.push(secret.slice(9) + 'b'.repeat(2000)); // pushes it over the cap; the secret straddles the cut
  r.push('c'.repeat(500) + secret);           // still the same line: dropped
  r.push('\nnext ' + secret + '\nlast');
  r.flush();
  assert.deepEqual(out, [LONG_LINE_MARKER, 'next [redacted]', 'last']);
  // a line that ends while still being dropped writes nothing on flush
  const out2 = [];
  const r2 = lineRedactor([secret], (l) => out2.push(l));
  r2.push('x'.repeat(70000));
  r2.flush();
  assert.deepEqual(out2, [LONG_LINE_MARKER]);
});

// ---- steps ----
test('STEPS matches the db:schedule / db:positions / db:backfill / db:status scripts in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(STEPS.map((s) => s.name), ['schedule', 'positions', 'backfill', 'status'], 'owner order');
  for (const s of STEPS) assert.equal(pkg.scripts[s.npm], `node ${s.script}`, s.npm);
});

test('stepArgv: season steps get --season; fixture mode swaps all but status', () => {
  const by = Object.fromEntries(STEPS.map((s) => [s.name, s]));
  assert.deepEqual(stepArgv(by.schedule, '2026-27'), ['scripts/load-schedule.mjs', '--season', '2026-27']);
  assert.deepEqual(stepArgv(by.positions, '2026-27'), ['scripts/load-positions.mjs']);
  assert.deepEqual(stepArgv(by.backfill, '2026-27', { fixture: true }), ['scripts/fixtures/fake-weekly-step.mjs', 'backfill', '--season', '2026-27']);
  assert.deepEqual(stepArgv(by.status, '2026-27', { fixture: true }), ['scripts/db-status.mjs']);
});

test('loadConfig port is what weekly compares against (BACKUP_TUNNEL_PORT)', () => {
  assert.equal(loadConfig({ BACKUP_TUNNEL_PORT: '58000' }).port, 58000);
});

// ---- M6: sub-steps, result lines, run state, final line ----
const sub = Object.fromEntries(SUBSTEPS.map((x) => [x.name, x]));
const hlRes = (step, o = {}) => `@@WEEKLY ${JSON.stringify({ v: 1, step, degraded: false, nba: 'n/a', skipped: [], stop: null, hl: { requests: 71, limit: 7500, remaining: 7410 }, reason: null, ...o })}`;
const nbaRes = (step, o = {}) => `@@WEEKLY ${JSON.stringify({ v: 1, step, degraded: false, nba: 'ok', skipped: [], stop: null, hl: { requests: 0, limit: null, remaining: null }, reason: null, ...o })}`;

test('SUBSTEPS: NBA.com probe first, then Highlightly; stage names stay schedule / positions / backfill / status', () => {
  assert.deepEqual(SUBSTEPS.map((x) => x.name), ['schedule:nba', 'schedule:hl', 'positions:nba', 'backfill:hl', 'backfill:nba', 'status']);
  assert.deepEqual(SUBSTEPS.map((x) => x.stage), ['schedule', 'schedule', 'positions', 'backfill', 'backfill', 'status']);
  assert.deepEqual(stepArgv(sub['schedule:nba'], '2026-27'), ['scripts/load-schedule.mjs', '--season', '2026-27', '--nba-best-effort']);
  assert.deepEqual(stepArgv(sub['positions:nba'], '2026-27'), ['scripts/load-positions.mjs', '--nba-best-effort']);
  assert.deepEqual(stepArgv(sub['backfill:nba'], '2026-27'), ['scripts/backfill.mjs', '--season', '2026-27', '--nba-best-effort']);
  assert.deepEqual(stepArgv(sub['schedule:hl'], '2026-27'), ['worker/scripts/weekly-hl.js', 'schedule', '--season', '2026-27']);
  assert.deepEqual(stepArgv(sub['backfill:hl'], '2026-27'), ['worker/scripts/weekly-hl.js', 'backfill', '--season', '2026-27']);
  assert.deepEqual(stepArgv(sub.status, '2026-27'), ['scripts/db-status.mjs']);
  assert.equal(planSteps({ stepFixture: false }), SUBSTEPS);
  assert.deepEqual(planSteps({ stepFixture: true }).map((x) => x.stage), ['schedule', 'positions', 'backfill', 'status'], 'the M5 drill keeps its three fake stages');
});

test('SUBSTEPS scripts exist', () => { for (const x of SUBSTEPS) assert.ok(fs.existsSync(path.join(ROOT, x.script)), x.script); });

test('stepEnv drops internal variables the user set, keeps removing the prod flags, then adds the runner\'s own', () => {
  const base = { PATH: '/bin', WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: '1', WEEKLY_RUN_ID: 'evil', WEEKLY_NBA_STATE: 'ok', WEEKLY_HL_BUDGET: '99999', WEEKLY_HL_LAST_REMAINING: '99999', WEEKLY_HL_TIPOFF: '1', WEEKLY_NBA: '0' };
  const e = stepEnv(base, 'postgres://u:p@127.0.0.1:1/d', { WEEKLY_RUN_ID: 'r1' });
  for (const k of INTERNAL_ENV) assert.ok(!(k in e) || k === 'WEEKLY_RUN_ID', k);
  assert.equal(e.WEEKLY_RUN_ID, 'r1');
  assert.equal(e.WEEKLY_NBA, '0', 'documented user flags pass through');
  assert.ok(!('WEEKLY_CONFIRM_PROD' in e) && !('BACKUP_CONFIRM_PROD' in e));
});

test('parseResultLine: valid line parses; wrong step, bad enum, oversized, non-JSON and unknown skipped items are handled', () => {
  const ok = parseResultLine(hlRes('schedule:hl'), 'schedule:hl');
  assert.deepEqual(ok.hl, { requests: 71, limit: 7500, remaining: 7410 });
  assert.equal(parseResultLine(hlRes('schedule:hl'), 'backfill:hl'), null);
  assert.equal(parseResultLine(hlRes('schedule:hl', { stop: 'banana' }), 'schedule:hl'), null);
  assert.equal(parseResultLine(hlRes('schedule:hl', { nba: 'maybe' }), 'schedule:hl'), null);
  assert.equal(parseResultLine(hlRes('schedule:hl', { hl: { requests: -1, limit: null, remaining: null } }), 'schedule:hl'), null);
  assert.equal(parseResultLine(hlRes('schedule:hl', { hl: { requests: 1, limit: 1e12, remaining: null } }), 'schedule:hl'), null);
  assert.equal(parseResultLine(hlRes('schedule:hl', { reason: 'x'.repeat(5000) }), 'schedule:hl'), null, 'oversized');
  assert.equal(parseResultLine('@@WEEKLY {not json', 'schedule:hl'), null);
  assert.equal(parseResultLine('hello', 'schedule:hl'), null);
  assert.equal(parseResultLine(undefined, 'schedule:hl'), null);
  const mixed = parseResultLine(nbaRes('schedule:nba', { degraded: true, nba: 'down', skipped: ['nba:arena', 'nba:evil', 42, '../x'] }), 'schedule:nba');
  assert.deepEqual(mixed.skipped, ['nba:arena']);
  const r = parseResultLine(nbaRes('positions:nba', { reason: 'line\nbreak "quoted"' }), 'positions:nba');
  assert.equal(r.reason, "line break 'quoted'");
});

test('aggregator: clean run -> OK with Highlightly requests and quota', () => {
  const st = newRunState({ hlCap: 600, nba: true });
  applyResult(st, sub['schedule:nba'], parseResultLine(nbaRes('schedule:nba'), 'schedule:nba'));
  applyResult(st, sub['schedule:hl'], parseResultLine(hlRes('schedule:hl'), 'schedule:hl'));
  applyResult(st, sub['backfill:hl'], parseResultLine(hlRes('backfill:hl', { hl: { requests: 10, limit: 7500, remaining: 7400 } }), 'backfill:hl'));
  assert.equal(st.degraded, false);
  assert.equal(finalLine({ iso: '2026-11-09T13:00:00Z', season: '2026-27', backup: 'reused:x.dump', st, duration: '75s' }),
    '2026-11-09T13:00:00Z OK season=2026-27 backup=reused:x.dump hl_requests=81 quota=7400/7500 duration=75s');
});

test('aggregator: NBA.com down -> OK-DEGRADED with nba=down and the full skipped list', () => {
  const st = newRunState({ hlCap: 600, nba: true });
  const all = ['nba:arena', 'nba:tv', 'nba:cup', 'nba:season_type', 'nba:new_games'];
  applyResult(st, sub['schedule:nba'], parseResultLine(nbaRes('schedule:nba', { degraded: true, nba: 'down', skipped: all, reason: 'nba.com unreachable: timeout' }), 'schedule:nba'));
  applyResult(st, sub['schedule:hl'], parseResultLine(hlRes('schedule:hl'), 'schedule:hl'));
  applyResult(st, sub['positions:nba'], parseResultLine(nbaRes('positions:nba', { degraded: true, nba: 'down', skipped: ['nba:positions'] }), 'positions:nba'));
  applyResult(st, sub['backfill:nba'], parseResultLine(nbaRes('backfill:nba', { degraded: true, nba: 'down', skipped: ['nba:reconcile', 'nba:standings'] }), 'backfill:nba'));
  const line = finalLine({ iso: 'T', season: '2026-27', backup: 'new:b', st, duration: '3s' });
  assert.match(line, /^T OK-DEGRADED season=2026-27 backup=new:b hl_requests=71 quota=7410\/7500 nba=down skipped=nba:arena,nba:tv,nba:cup,nba:season_type,nba:new_games,nba:positions,nba:reconcile,nba:standings reason="nba.com unreachable: timeout" duration=3s$/);
  assert.equal(st.nbaLoaded, false, 'Highlightly then owns tip-off times (Q9)');
});

test('aggregator: Highlightly cap stop -> OK-DEGRADED with stop=cap', () => {
  const st = newRunState({ hlCap: 600, nba: true });
  applyResult(st, sub['schedule:hl'], parseResultLine(hlRes('schedule:hl', { degraded: true, stop: 'cap', reason: 'request cap reached', hl: { requests: 600, limit: 7500, remaining: 6000 } }), 'schedule:hl'));
  assert.match(finalLine({ iso: 'T', season: 's', backup: 'b', st, duration: '1s' }), / OK-DEGRADED .* hl_requests=600 quota=6000\/7500 stop=cap reason="request cap reached" duration=1s$/);
});

test('aggregator: a clean NBA.com schedule gives the tip-off authority to NBA.com for the Highlightly step', () => {
  const st = newRunState({ hlCap: 600, nba: true });
  applyResult(st, sub['schedule:nba'], parseResultLine(nbaRes('schedule:nba'), 'schedule:nba'));
  assert.equal(stepExtra(sub['schedule:hl'], st, 'rid').WEEKLY_HL_TIPOFF, '0');
  const down = newRunState({ hlCap: 600, nba: true });
  applyResult(down, sub['schedule:nba'], parseResultLine(nbaRes('schedule:nba', { degraded: true, nba: 'down' }), 'schedule:nba'));
  assert.equal(stepExtra(sub['schedule:hl'], down, 'rid').WEEKLY_HL_TIPOFF, '1');
  assert.equal(stepExtra(sub['positions:nba'], down, 'rid').WEEKLY_NBA_STATE, 'down', 'later NBA.com steps make no request');
  assert.equal('WEEKLY_NBA_STATE' in stepExtra(sub['positions:nba'], st, 'rid'), false);
});

test('budget hand-off: the cap is per run (600 - 71 used = 529 for the next Highlightly step; never negative)', () => {
  const st = newRunState({ hlCap: 600, nba: true });
  assert.equal(stepExtra(sub['schedule:hl'], st, 'r').WEEKLY_HL_BUDGET, '600');
  assert.ok(!('WEEKLY_HL_LAST_REMAINING' in stepExtra(sub['schedule:hl'], st, 'r')));
  applyResult(st, sub['schedule:hl'], parseResultLine(hlRes('schedule:hl'), 'schedule:hl'));
  const x = stepExtra(sub['backfill:hl'], st, 'r');
  assert.deepEqual([x.WEEKLY_HL_BUDGET, x.WEEKLY_HL_LAST_REMAINING], ['529', '7410']);
  st.used = 900;
  assert.equal(budgetLeft(st), 0);
});

test('a failed Highlightly step is a FAIL: the reason can come from the result line', () => {
  const res = parseResultLine(hlRes('schedule:hl', { reason: 'highlightly auth rejected (401)', hl: { requests: 1, limit: null, remaining: null } }), 'schedule:hl');
  assert.equal(res.reason, 'highlightly auth rejected (401)');
});

test('notification texts: OK / OK with warnings / FAILED, none says NBA.com', () => {
  assert.deepEqual(NOTIFY_TEXT, { ok: 'Weekly run OK', degraded: 'Weekly run OK with warnings — see logs/weekly.log', fail: 'Weekly run FAILED — see logs/weekly.log' });
  assert.ok(fs.readFileSync(path.join(ROOT, 'scripts/weekly.sh'), 'utf8').includes('Weekly run FAILED'));
});

test('config: Highlightly limits only move in the safe direction (cap 601 and reserve 999 are rejected)', () => {
  assert.throws(() => loadWeeklyConfig({ WEEKLY_HL_CAP: '601' }, { home: '/h' }), /WEEKLY_HL_CAP/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_HL_CAP: '0' }, { home: '/h' }), /WEEKLY_HL_CAP/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_HL_RESERVE: '999' }, { home: '/h' }), /WEEKLY_HL_RESERVE/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_HL_RPS: '11' }, { home: '/h' }), /WEEKLY_HL_RPS/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_HL_DAYS_BACK: '31' }, { home: '/h' }), /WEEKLY_HL_DAYS_BACK/);
  assert.throws(() => loadWeeklyConfig({ WEEKLY_NBA: 'maybe' }, { home: '/h' }), /WEEKLY_NBA/);
  const c = loadWeeklyConfig({}, { home: '/h' });
  assert.deepEqual([c.hlCap, c.hlReserve, c.hlRps, c.hlDaysBack, c.hlDaysAhead, c.nba, c.fullSeason, c.dryRun], [600, 1000, 4, 7, 60, true, false, false]);
  const d = loadWeeklyConfig({ WEEKLY_HL_CAP: '3', WEEKLY_HL_RESERVE: '1500', WEEKLY_NBA: '0', WEEKLY_HL_FULL_SEASON: '1', WEEKLY_DRY_RUN: '1' }, { home: '/h' });
  assert.deepEqual([d.hlCap, d.hlReserve, d.nba, d.fullSeason, d.dryRun], [3, 1500, false, true, true]);
  assert.equal(loadWeeklyConfig({ WEEKLY_HL_FULL_SEASON: 'true' }, { home: '/h' }).fullSeason, false, 'exactly "1" opts in');
});

test('fixture guards (D12): a production run refuses fixtures; a fake run needs Highlightly fixtures and (NBA fixtures or WEEKLY_NBA=0)', () => {
  const prod = { WEEKLY_CONFIRM_PROD: '1', BACKUP_CONFIRM_PROD: '1' };
  const cfg = (env) => loadWeeklyConfig(env, { home: '/h' });
  assert.equal(fixtureGuardError(cfg(prod), prod), null);
  for (const k of ['HIGHLIGHTLY_FIXTURES', 'SEED_FIXTURES', 'WEEKLY_STEP_FIXTURE']) {
    const env = { ...prod, [k]: k === 'WEEKLY_STEP_FIXTURE' ? '1' : '/some/dir' };
    assert.equal(fixtureGuardError(cfg(env), env), FIXTURES_ON_PROD_MSG, k);
  }
  const fake = { WEEKLY_RAILWAY_BIN: FAKE_BIN };
  assert.equal(fixtureGuardError(cfg(fake), fake), FAKE_NEEDS_FIXTURES_MSG, 'no Highlightly fixtures');
  const hlOnly = { ...fake, HIGHLIGHTLY_FIXTURES: '/d' };
  assert.equal(fixtureGuardError(cfg(hlOnly), hlOnly), FAKE_NEEDS_FIXTURES_MSG, 'NBA.com would be called');
  assert.equal(fixtureGuardError(cfg({ ...hlOnly, SEED_FIXTURES: '/n' }), { ...hlOnly, SEED_FIXTURES: '/n' }), null);
  assert.equal(fixtureGuardError(cfg({ ...hlOnly, WEEKLY_NBA: '0' }), { ...hlOnly, WEEKLY_NBA: '0' }), null);
  const step = { ...fake, WEEKLY_STEP_FIXTURE: '1' };
  assert.equal(fixtureGuardError(cfg(step), step), null, 'only the fake step runs');
});

test('redactor masks the Highlightly key as well as the tunnel password', () => {
  const out = [];
  const r = lineRedactor(['tunnel-pw', 'hl-key-0123456789'], (l) => out.push(l));
  r.push('key hl-key-0123456789 and tunnel-pw\n');
  assert.ok(!out[0].includes('hl-key-0123456789') && !out[0].includes('tunnel-pw'));
});

test('the Highlightly child and the best-effort loaders print a result line the parser accepts (contract with worker/ and scripts/)', async () => {
  const { weeklyLine } = await import('./nba-best-effort.mjs');
  const r = parseResultLine(weeklyLine({ step: 'backfill:nba', degraded: true, nba: 'down', skipped: ['nba:reconcile', 'nba:standings'], reason: 'nba.com unreachable: timeout' }), 'backfill:nba');
  assert.deepEqual([r.degraded, r.nba, r.skipped.length], [true, 'down', 2]);
});
