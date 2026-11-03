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
