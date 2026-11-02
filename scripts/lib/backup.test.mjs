import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig, dumpName, DUMP_RE, selectForDeletion, parseTunnelOutput, hasUrlToken,
  redact, buildPgEnv, assertSafeBackupDir, isMountPoint, prodGuard, timeMachineDevices,
} from './backup.mjs';

// Fake password with the characters that need percent-encoding in a URL.
const PW = 'p@ss:w/rd%1';
// Shape copied from print_tunnel_info in railwayapp/cli v5.71.0 connect.rs
// (printed on stderr; the URL is url::Url Display, so userinfo is encoded).
const tunnelBlock = (host = '127.0.0.1', port = 55432, pw = PW) => `
PostgreSQL tunnel open — point an external client at:

  Host:     ${host}
  Port:     ${port}
  User:     postgres
  Password: ${pw}
  Database: railway

  URL:      postgres://postgres:${encodeURIComponent(pw)}@${host}:${port}/railway

Press Ctrl+C to close the tunnel.

`;

test('dumpName is UTC and sorts by time', () => {
  const a = dumpName(new Date(Date.UTC(2026, 10, 2, 3, 17, 5)));
  assert.equal(a, 'chalk-that-nba_20261102T031705Z.dump');
  const b = dumpName(new Date(Date.UTC(2026, 11, 1, 0, 0, 0)));
  assert.ok(a < b);
});

test('DUMP_RE matches only the script\'s own names', () => {
  assert.ok(DUMP_RE.test('chalk-that-nba_20261102T031705Z.dump'));
  for (const bad of ['chalk-that-nba_20261102T031705Z.dump.partial', 'chalk-that-nba_manual.dump',
    'other_20261102T031705Z.dump', 'chalk-that-nba_20261102T031705Z.dump.bak', 'x_chalk-that-nba_20261102T031705Z.dump', 'notes.txt']) {
    assert.ok(!DUMP_RE.test(bad), bad);
  }
});

test('selectForDeletion keeps the N newest and ignores other names', () => {
  const names = ['chalk-that-nba_20260101T000000Z.dump', 'chalk-that-nba_20260103T000000Z.dump',
    'chalk-that-nba_20260102T000000Z.dump', 'notes.txt', 'chalk-that-nba_manual.dump',
    'chalk-that-nba_20200101T000000Z.dump.partial', '.DS_Store'];
  assert.deepEqual(selectForDeletion(names, 2), ['chalk-that-nba_20260101T000000Z.dump']);
  assert.deepEqual(selectForDeletion(names, 3), []);
  assert.deepEqual(selectForDeletion(names, 14), []);
  assert.deepEqual(selectForDeletion([], 1), []);
});

test('selectForDeletion rejects bad keep', () => {
  for (const k of [0, -1, 1.5, NaN, '3', undefined]) assert.throws(() => selectForDeletion([], k));
});

test('parseTunnelOutput parses the v5.71.0 block incl. encoded password', () => {
  assert.deepEqual(parseTunnelOutput(tunnelBlock(), 55432), { user: 'postgres', password: PW, database: 'railway' });
  assert.ok(hasUrlToken(tunnelBlock()));
  assert.ok(!hasUrlToken('Opening tunnel...\n'));
});

test('parseTunnelOutput rejects non-local host, wrong port, garbage; errors never echo input', () => {
  const cases = [
    [tunnelBlock('db.example.com'), 55432],
    [tunnelBlock('127.0.0.1', 55433), 55432],
    ['', 55432],
    ['nothing useful here', 55432],
    ['URL: postgres://:@127.0.0.1:55432/', 55432],
    ['URL: postgres://u@127.0.0.1:55432/db ', 55432],
    ['URL: postgres://u:%ZZ@127.0.0.1:55432/db ', 55432],
  ];
  for (const [text, port] of cases) {
    try { parseTunnelOutput(text, port); assert.fail('should throw'); } catch (e) {
      assert.equal(e.name, 'TunnelParseError');
      assert.ok(!e.message.includes(PW) && !e.message.includes('example.com') && !e.message.includes('postgres://'));
    }
  }
});

test('redact removes password, URLs and password= pairs', () => {
  const t = redact(`bad ${PW} and ${encodeURIComponent(PW)} postgres://u:x@h:1/d postgresql://a:b@c/d password=hunter2 ok`, [PW]);
  assert.ok(!t.includes(PW) && !t.includes('postgres') && !t.includes('hunter2'));
  assert.ok(t.includes('ok'));
});

test('buildPgEnv is an allow-list', () => {
  const env = buildPgEnv('pw', { PATH: '/x', HOME: '/h', PGHOST: 'evil', PGDATABASE: 'd', DATABASE_PUBLIC_URL: 'u', LANG: 'C' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGPASSWORD']);
  assert.equal(env.PGPASSWORD, 'pw');
});

test('loadConfig defaults and validation', () => {
  const c = loadConfig({}, { home: '/home/x' });
  assert.equal(c.volume, '/Volumes/DB-Backups');
  assert.equal(c.dir, '/Volumes/DB-Backups/db-backups');
  assert.equal(c.keep, 14);
  assert.equal(c.logPath, '/home/x/Library/Logs/chalk-that-nba/backup.log');
  assert.equal(c.service, 'Postgres');
  assert.equal(c.railwayEnv, 'production');
  assert.equal(c.port, 55432);
  assert.equal(c.tunnelTimeoutS, 60);
  assert.equal(c.dumpTimeoutS, 1800);
  assert.equal(c.pgBinDir, '/opt/homebrew/opt/libpq/bin');
  assert.equal(loadConfig({ BACKUP_VOLUME: '/v' }).dir, '/v/db-backups');
  assert.equal(loadConfig({ BACKUP_RAILWAY_BIN: '/x/fake-railway.sh' }).railwayBin, '/x/fake-railway.sh');
  for (const bad of [{ BACKUP_KEEP: '0' }, { BACKUP_KEEP: 'x' }, { BACKUP_KEEP: '1.5' }, { BACKUP_TUNNEL_PORT: '80' },
    { BACKUP_TUNNEL_PORT: '99999' }, { BACKUP_RAILWAY_BIN: 'railway' }, { BACKUP_RAILWAY_BIN: './fake-railway.sh' }, { BACKUP_TUNNEL_PORT: 'abc' }, { BACKUP_DUMP_TIMEOUT_S: '0' }]) {
    assert.throws(() => loadConfig(bad), undefined, JSON.stringify(bad));
  }
});

test('assertSafeBackupDir guards TM-Prism, volume escape, repo, symlinks', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bkt-')));
  try {
    const vol = path.join(tmp, 'vol'); fs.mkdirSync(path.join(vol, 'db-backups'), { recursive: true });
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, 'x'), { recursive: true });
    assert.equal(assertSafeBackupDir(path.join(vol, 'db-backups'), vol, { repoRoot: repo }).dir, path.join(vol, 'db-backups'));
    assert.doesNotThrow(() => assertSafeBackupDir(path.join(vol, 'new-dir'), vol)); // not yet created
    assert.throws(() => assertSafeBackupDir('/Volumes/TM-Prism/db-backups', '/Volumes/TM-Prism'), /Time Machine/);
    assert.throws(() => assertSafeBackupDir('/volumes/tm-prism/db-backups', '/Volumes/DB-Backups'), /Time Machine/);
    assert.throws(() => assertSafeBackupDir('/Volumes/DB-Backups/../TM-Prism/x', '/Volumes/DB-Backups'), /Time Machine/);
    assert.throws(() => assertSafeBackupDir(path.join(tmp, 'elsewhere'), vol), /outside/);
    assert.throws(() => assertSafeBackupDir(path.join(vol, '..', 'elsewhere'), vol), /outside/);
    assert.throws(() => assertSafeBackupDir(path.join(repo, 'x'), repo, { repoRoot: repo }), /repository/);
    // symlink inside the volume pointing outside it
    fs.symlinkSync(tmp, path.join(vol, 'link'));
    assert.throws(() => assertSafeBackupDir(path.join(vol, 'link', 'a'), vol), /outside/);
    // symlink to a TM-Prism-looking path (string only, nothing created there)
    fs.symlinkSync('/Volumes/TM-Prism/db-backups', path.join(vol, 'tm'));
    assert.throws(() => assertSafeBackupDir(path.join(vol, 'tm'), vol));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('isMountPoint is false for a plain subdirectory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkm-'));
  try {
    fs.mkdirSync(path.join(tmp, 'd'));
    assert.equal(isMountPoint(path.join(tmp, 'd')), false);
    assert.equal(isMountPoint('/'), false); // root's parent is itself
    const fake = (p) => ({ isDirectory: () => true, dev: p === '/m' ? 2 : 1 });
    assert.equal(isMountPoint('/m', fake), true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

const FAKE_BIN = path.resolve(new URL('../fixtures/fake-railway.sh', import.meta.url).pathname);
const GUARD_MSG = 'production run not confirmed (set BACKUP_CONFIRM_PROD=1)';

test('prodGuard: the flag must be exactly 1', () => {
  assert.equal(prodGuard({}), GUARD_MSG);
  assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: '' }), GUARD_MSG);
  for (const v of ['0', 'true', 'yes', '', ' 1', '11']) assert.equal(prodGuard({ BACKUP_CONFIRM_PROD: v }), GUARD_MSG, v);
  assert.equal(prodGuard({ BACKUP_CONFIRM_PROD: '1' }), null);
  assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: '/opt/homebrew/bin/railway', BACKUP_CONFIRM_PROD: '1' }), null);
});

test('prodGuard: only the repo fake-railway.sh (by realpath) is exempt', () => {
  assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: FAKE_BIN }), null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkg-'));
  try {
    const ln = path.join(tmp, 'link-to-fake'); fs.symlinkSync(FAKE_BIN, ln);
    assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: ln }), null); // resolves to the fixture
    // everything else needs the flag: copy, hard link, wrapper, other names, real-looking names, missing file
    const copy = path.join(tmp, 'fake-railway.sh'); fs.copyFileSync(FAKE_BIN, copy);
    const hard = path.join(tmp, 'hard'); fs.linkSync(copy, hard);
    const wrap = path.join(tmp, 'wrapper'); fs.writeFileSync(wrap, '#!/bin/sh\nexec railway "$@"\n', { mode: 0o755 });
    const rail = path.join(tmp, 'railway'); fs.writeFileSync(rail, '');
    const sym = path.join(tmp, 'harmless'); fs.symlinkSync(rail, sym);
    for (const b of [copy, hard, wrap, rail, sym, path.join(tmp, 'Railway'), path.join(tmp, 'RAILWAY'), path.join(tmp, 'missing'), '/opt/homebrew/bin/railway', '/bin/sh']) {
      assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: b }), GUARD_MSG, b);
    }
    // a different repoRoot has a different fixture
    assert.equal(prodGuard({ BACKUP_RAILWAY_BIN: FAKE_BIN }, { repoRoot: tmp }), GUARD_MSG);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('assertSafeBackupDir: /System/Volumes/Data firmlink spelling of TM-Prism is denied, any case', () => {
  for (const p of ['/System/Volumes/Data/Volumes/TM-Prism/db-backups', '/system/volumes/data/volumes/tm-prism', '/SYSTEM/VOLUMES/DATA/VOLUMES/TM-PRISM/x']) {
    assert.throws(() => assertSafeBackupDir(p, p), /Time Machine/, p);
  }
  assert.throws(() => assertSafeBackupDir('/Volumes/DB-Backups/x', '/System/Volumes/Data/Volumes/TM-Prism'), /Time Machine/);
});

test('assertSafeBackupDir: denies by device of a Time Machine destination (renamed volume)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bkd-')));
  try {
    const vol = path.join(tmp, 'vol'); fs.mkdirSync(vol);
    const dev = fs.statSync(vol).dev;
    assert.throws(() => assertSafeBackupDir(path.join(vol, 'db'), vol, { denyDevices: new Set([dev]) }), /Time Machine device/);
    assert.doesNotThrow(() => assertSafeBackupDir(path.join(vol, 'db'), vol, { denyDevices: new Set([dev + 1]) }));
    assert.doesNotThrow(() => assertSafeBackupDir(path.join(vol, 'db'), vol, { denyDevices: new Set() }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('timeMachineDevices reads tmutil mount points by stat only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkt2-'));
  try {
    const run = () => ({ stdout: `Name : X\nMount Point : ${tmp}\nID : 1\n` });
    assert.ok(timeMachineDevices(run).has(fs.statSync(tmp).dev));
    assert.doesNotThrow(() => timeMachineDevices(() => { throw new Error('no tmutil'); }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
