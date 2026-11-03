import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig, dumpName, DUMP_RE, selectForDeletion, parseTunnelOutput, hasUrlToken,
  redact, buildPgEnv, assertSafeBackupDir, isMountPoint, prodGuard, timeMachineDevices,
  isRailwaySshForward, isRailwayTunnelCmd, parsePsRows, descendantsOf, parseLsofPids, parseLsofListeners,
  reapDecision, parseTunnelRecord,
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

// ---- M4: ssh child of `railway connect --tunnel-only` ----
// Argv as built by base_ssh_command + apply_forward_options in railwayapp/cli v5.71.0
// src/commands/ssh/native.rs (key path and target are placeholders).
const sshArgs = (port = 55432, { target = 'svc-id:inst@ssh.railway.com', pre = '', extra = '' } = {}) =>
  `ssh ${pre}-i /Users/x/.railway/ssh/id_ed25519 -N -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes ` +
  `-o ServerAliveInterval=30 -o ServerAliveCountMax=3 ${extra}-L 127.0.0.1:${port}:127.0.0.1:5432 ${target}`;

test('isRailwaySshForward accepts the v5.71.0 argv (also -p 2222 and ssh.railway-develop.com) and the drill fixture argv', () => {
  assert.ok(isRailwaySshForward(sshArgs(), 55432));
  assert.ok(isRailwaySshForward(sshArgs(55432, { pre: '-p 2222 ', target: 'a:b@ssh.railway-develop.com' }), 55432));
  assert.ok(isRailwaySshForward('ssh /repo/scripts/fixtures/fake-ssh-forward.mjs -i /t/fake_key -N -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:55432:127.0.0.1:61000 service:fake@ssh.railway.com', 55432));
  assert.ok(isRailwaySshForward('/usr/bin/ssh ' + sshArgs().slice(4), 55432));
});

test('isRailwaySshForward rejects other ports (exact number, not substring), binds, and shapes', () => {
  for (const p of [5543, 554321, 155432]) assert.ok(!isRailwaySshForward(sshArgs(p), 55432), `port ${p}`);
  assert.ok(!isRailwaySshForward(sshArgs(55432), 5543));
  assert.ok(!isRailwaySshForward(sshArgs(55432).replace('127.0.0.1:55432', '0.0.0.0:55432'), 55432));
  assert.ok(!isRailwaySshForward(sshArgs(55432).replace('-L 127.0.0.1:55432', '-L localhost:55432'), 55432));
  assert.ok(!isRailwaySshForward(sshArgs(55432, { extra: '-L 127.0.0.1:1:127.0.0.1:2 ' }), 55432));
  assert.ok(!isRailwaySshForward(sshArgs(55432, { extra: '-R 9:127.0.0.1:22 ' }), 55432));
  assert.ok(!isRailwaySshForward(sshArgs(55432, { extra: '-D 1080 ' }), 55432));
  assert.ok(!isRailwaySshForward(sshArgs().replace(' -N', ''), 55432));
  assert.ok(!isRailwaySshForward(sshArgs().replace('ExitOnForwardFailure=yes', 'ExitOnForwardFailure=no'), 55432));
  assert.ok(!isRailwaySshForward(sshArgs(55432, { target: 'user@example.com' }), 55432));
  assert.ok(!isRailwaySshForward(sshArgs(55432, { target: 'u@ssh.railway.com.evil.net' }), 55432));
  for (const a0 of ['sshd', 'autossh', '/usr/bin/ssh-agent', 'grep', 'node']) {
    assert.ok(!isRailwaySshForward(sshArgs().replace(/^ssh/, a0), 55432), a0);
  }
  assert.ok(!isRailwaySshForward('', 55432));
});

test('isRailwayTunnelCmd matches the exact tunnel-only command, directly or via /bin/sh', () => {
  const bin = '/opt/homebrew/bin/railway';
  assert.ok(isRailwayTunnelCmd(`${bin} connect Postgres --tunnel-only -P 55432 -e production`, 55432, bin));
  const fake = '/repo/scripts/fixtures/fake-railway.sh';
  assert.ok(isRailwayTunnelCmd(`/bin/sh ${fake} connect Postgres --tunnel-only -P 55432 -e production`, 55432, fake));
  assert.ok(!isRailwayTunnelCmd(`${bin} connect Postgres --tunnel-only -P 55433 -e production`, 55432, bin));
  assert.ok(!isRailwayTunnelCmd(`${bin} connect Postgres --tunnel-only -e production`, 55432, bin));
  assert.ok(!isRailwayTunnelCmd(`${bin} connect Postgres -P 55432 -e production`, 55432, bin));
  assert.ok(!isRailwayTunnelCmd(`/usr/local/bin/railway connect Postgres --tunnel-only -P 55432`, 55432, bin));
  assert.ok(!isRailwayTunnelCmd(`vim railway connect --tunnel-only -P 55432`, 55432, bin));
  assert.ok(!isRailwayTunnelCmd(`${bin} whoami`, 55432, bin));
  assert.ok(!isRailwayTunnelCmd(`${bin} connect Postgres --tunnel-only -P 55432`, 55432, ''));
});

const PS = [
  '  100     1   100   501 Mon Nov  2 22:59:25 2026 /sbin/launchd',
  '  200   100   200   501 Mon Nov  2 22:59:26 2026 /bin/sh /x/fake railway.sh connect Postgres --tunnel-only -P 55432',
  '  300   200   300   501 Mon Nov  2 22:59:27 2026 ssh -N -L 127.0.0.1:55432:127.0.0.1:1 a@ssh.railway.com',
  '  400   300   400   501 Mon Nov  2 22:59:28 2026 child-of-ssh',
  'garbage line',
].join('\n');

test('parsePsRows handles leading spaces, lstart and args with spaces', () => {
  const rows = parsePsRows(PS);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { pid: 200, ppid: 100, pgid: 200, uid: 501, lstart: 'Mon Nov 2 22:59:26 2026', args: '/bin/sh /x/fake railway.sh connect Postgres --tunnel-only -P 55432' });
  assert.deepEqual(parsePsRows(''), []);
});

test('descendantsOf walks several levels, excludes the root and survives cycles', () => {
  const rows = parsePsRows(PS);
  assert.deepEqual(descendantsOf(rows, 200).map((r) => r.pid), [300, 400]);
  assert.deepEqual(descendantsOf(rows, 400), []);
  const cyc = [{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }];
  assert.deepEqual(descendantsOf(cyc, 1).map((r) => r.pid), [2]);
});

test('parseLsofPids and parseLsofListeners read -F output and ignore garbage', () => {
  assert.deepEqual(parseLsofPids('p123\nf4\n'), [123]);
  assert.deepEqual(parseLsofPids('what\npx\n'), []);
  assert.deepEqual(parseLsofListeners('p123\nf12\nn127.0.0.1:55432\np9\nn*:55432\np7\nn127.0.0.1:55433\n', 55432), [123]);
  assert.deepEqual(parseLsofListeners('', 55432), []);
});

test('reapDecision kills only when every rule holds, with one negative per rule', () => {
  const row = { pid: 500, ppid: 1, pgid: 500, uid: 501, lstart: 'Mon Nov 2 22:59:27 2026', args: sshArgs() };
  const ok = { row, myUid: 501, port: 55432, listenerPids: [500], selfPid: 1 };
  assert.deepEqual(reapDecision(ok), { kill: true, reason: 'orphaned-railway-ssh' });
  assert.equal(reapDecision({ ...ok, row: { ...row, ppid: 777 }, recordedRailwayPid: 777 }).kill, true);
  assert.equal(reapDecision({ ...ok, expectedLstart: row.lstart }).kill, true);
  assert.equal(reapDecision({ ...ok, row: { ...row, uid: 0 } }).reason, 'wrong-uid');
  assert.equal(reapDecision({ ...ok, row: { ...row, ppid: 777 } }).reason, 'parent-alive');
  assert.equal(reapDecision({ ...ok, row: { ...row, ppid: 777 }, recordedRailwayPid: 778 }).reason, 'parent-alive');
  assert.equal(reapDecision({ ...ok, row: { ...row, args: sshArgs(55433) } }).reason, 'argv-mismatch');
  assert.equal(reapDecision({ ...ok, listenerPids: [501] }).reason, 'not-listener');
  assert.equal(reapDecision({ ...ok, expectedLstart: 'Mon Nov 2 01:00:00 2026' }).reason, 'pid-reused');
  assert.equal(reapDecision({ ...ok, row: { ...row, pid: 1 }, listenerPids: [1] }).reason, 'bad-pid');
  assert.equal(reapDecision({ ...ok, selfPid: 500 }).reason, 'bad-pid');
  assert.equal(reapDecision({ ...ok, listenerPids: undefined }).kill, false);
});

test('parseTunnelRecord validates what was read back from the lock dir', () => {
  const good = { railwayPid: 10, port: 55432, railwayBin: '/x/railway', ssh: [{ pid: 11, lstart: 'a' }, { pid: 'x' }, { pid: 1 }] };
  assert.deepEqual(parseTunnelRecord(JSON.stringify(good)), { railwayPid: 10, port: 55432, railwayBin: '/x/railway', ssh: [{ pid: 11, lstart: 'a' }] });
  for (const bad of ['', 'nope', '{}', JSON.stringify({ ...good, railwayPid: 1 }), JSON.stringify({ ...good, port: 0 }), JSON.stringify({ ...good, railwayBin: '' })]) {
    assert.equal(parseTunnelRecord(bad), null);
  }
});
