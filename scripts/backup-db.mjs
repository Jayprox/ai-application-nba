// Off-Railway Postgres backup (M3, docs/plans/M3-backup.md, docs/backup-restore.md).
// `npm run db:backup`, or daily via ops/launchd/com.chalkthat.nba.backup.plist.
//
// Opens the Railway CLI SSH tunnel (`railway connect --tunnel-only`), reads the
// credentials from the CLI's output IN MEMORY, runs pg_dump with the password
// in the child's env only, validates the dump, renames it into place and
// rotates old dumps. Credentials never touch the log, the console, a file or argv.
// Deliberately does NOT import scripts/lib/env.mjs and never reads .env.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, dumpName, DUMP_RE, PARTIAL_RE, selectForDeletion, parseTunnelOutput, hasUrlToken,
  redact, buildPgEnv, isMountPoint, assertSafeBackupDir, prodGuard,
  timeMachineDevices,
} from './lib/backup.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUF_CAP = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

class Fail extends Error {
  constructor(stage, reason, code = 1) { super(reason); this.stage = stage; this.reason = reason; this.exitCode = code; }
}

process.umask(0o077);
const started = Date.now();
let cfg;
let stage = 'preflight';
let tunnel = null;       // { child, pid }
let activeChild = null;  // pg_dump / pg_restore
let partialPath = null;
let lockHeld = false;
let secrets = [];
let finishing = false;

function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(cfg.logPath, line + '\n', { mode: 0o600 });
  } catch { /* console still has it */ }
}
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim().slice(0, 500);
const duration = () => `${Math.round((Date.now() - started) / 1000)}s`;

function notify(msg) {
  if (!cfg?.notify) return;
  try {
    const c = spawn('osascript', ['-e', `display notification "${msg}" with title "Chalk That Hardwood"`], { stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
  } catch { /* ignore */ }
}

function groupAlive(pid) { try { process.kill(-pid, 0); return true; } catch { return false; } }
async function killTunnel() {
  if (!tunnel) return;
  const { pid } = tunnel;
  tunnel = null;
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 50 && groupAlive(pid); i++) await sleep(100);
  if (groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
}

function removePartial() { if (partialPath) { try { fs.rmSync(partialPath, { force: true }); } catch { /* ignore */ } } }
function releaseLock() { if (lockHeld) { try { fs.rmSync(cfg.lockDir, { recursive: true, force: true }); } catch { /* ignore */ } lockHeld = false; } }

async function cleanup() {
  if (activeChild) { try { activeChild.kill('SIGKILL'); } catch { /* gone */ } activeChild = null; }
  await killTunnel();
  removePartial();
  releaseLock();
  secrets = [];
}
// Last resort, synchronous.
process.on('exit', () => {
  if (tunnel) { try { process.kill(-tunnel.pid, 'SIGKILL'); } catch { /* gone */ } }
  if (activeChild) { try { activeChild.kill('SIGKILL'); } catch { /* gone */ } }
  removePartial();
  if (cfg) releaseLock();
});

async function finishFail(f) {
  if (finishing) return;
  finishing = true;
  await cleanup();
  const line = `${iso()} FAIL stage=${f.stage} reason="${oneLine(f.reason)}" duration=${duration()}`;
  logLine(line);
  console.error(line);
  notify('Database backup FAILED - see backup.log');
  process.exit(f.exitCode ?? 1);
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => { finishFail(new Fail(stage, `interrupted by ${sig}`, code)); });
}

// Run a short child to completion with a clean env, capturing capped output.
function runCapture(cmd, args, { env, timeoutMs = 60000, track = false } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let timedOut = false;
    const c = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (track) activeChild = c;
    c.stdout.on('data', (d) => { if (out.length < BUF_CAP * 4) out += d; });
    c.stderr.on('data', (d) => { if (err.length < BUF_CAP) err += d; });
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); if (track) activeChild = null; resolve({ code: -1, out, err: e.code || 'spawn error', timedOut }); });
    c.on('close', (code) => { clearTimeout(t); if (track) activeChild = null; resolve({ code, out, err, timedOut }); });
  });
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// A SIGKILLed run leaves its tunnel (own process group) alive. Its PGID is kept
// in the lock dir; a later run kills that group, but only if the group leader
// still looks like `railway connect ... --tunnel-only`.
async function reapStaleTunnel() {
  let pgid = 0;
  try { pgid = Number(fs.readFileSync(path.join(cfg.lockDir, 'tunnel.pgid'), 'utf8')); } catch { return false; }
  if (!(pgid > 1) || pgid === process.pid || !groupAlive(pgid)) return false;
  const r = spawnSync('/bin/ps', ['-p', String(pgid), '-o', 'command='], { encoding: 'utf8' });
  const cmd = r.status === 0 ? r.stdout : '';
  if (!/railway/i.test(cmd) || !/\bconnect\b/.test(cmd) || !/--tunnel-only/.test(cmd)) return false;
  try { process.kill(-pgid, 'SIGTERM'); } catch { return false; }
  for (let i = 0; i < 50 && groupAlive(pgid); i++) await sleep(100);
  if (groupAlive(pgid)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  return true;
}

async function takeLock() {
  fs.mkdirSync(path.dirname(cfg.lockDir), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(cfg.lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(cfg.lockDir, 'pid'), String(process.pid));
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new Fail('preflight', 'could not create lock');
      let pid = 0;
      try { pid = Number(fs.readFileSync(path.join(cfg.lockDir, 'pid'), 'utf8')); } catch { /* unreadable */ }
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (er) { alive = er.code === 'EPERM'; } }
      if (alive) throw new Fail('preflight', 'another backup is running');
      if (await reapStaleTunnel()) logLine(`${iso()} NOTE reaped an orphaned tunnel left by a crashed run`);
      fs.rmSync(cfg.lockDir, { recursive: true, force: true }); // stale
    }
  }
  throw new Fail('preflight', 'could not take lock');
}

function resolveRailway() {
  // When set, run exactly the file the guard approved (its realpath), for both
  // `whoami` and `connect`. Unset (production) is unchanged.
  if (cfg.railwayBin) {
    try { return fs.realpathSync(cfg.railwayBin); } catch { throw new Fail('preflight', 'BACKUP_RAILWAY_BIN not found'); }
  }
  const r = spawnSync('/usr/bin/which', ['railway'], { encoding: 'utf8' });
  const p = r.status === 0 ? r.stdout.trim() : '';
  return p || '/opt/homebrew/bin/railway';
}

async function preflight() {
  // 0. Production guard: before the drive check, the lock, and any CLI call.
  const blocked = prodGuard(process.env);
  if (blocked) throw new Fail('preflight', blocked);

  // 1. Drive: real mount point, safe path. Nothing touches the network before this.
  let dir;
  const tmDevs = timeMachineDevices();
  try {
    if (!isMountPoint(cfg.volume)) throw new Error('not a mount point');
  } catch { throw new Fail('preflight', `volume ${cfg.volume} is not mounted`); }
  try {
    ({ dir } = assertSafeBackupDir(cfg.dir, cfg.volume, { repoRoot: REPO_ROOT, denyDevices: tmDevs }));
  } catch (e) { throw new Fail('preflight', e.message); }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!isMountPoint(cfg.volume)) throw new Error('unmounted');
    assertSafeBackupDir(dir, cfg.volume, { repoRoot: REPO_ROOT, denyDevices: tmDevs }); // re-check after creation
    fs.accessSync(dir, fs.constants.W_OK);
  } catch { throw new Fail('preflight', `cannot write to ${cfg.dir}`); }
  cfg.realDir = dir;

  await takeLock();
  for (const n of fs.readdirSync(dir)) if (PARTIAL_RE.test(n)) fs.rmSync(path.join(dir, n), { force: true });

  // 2. Client tools.
  const pgDump = path.join(cfg.pgBinDir, 'pg_dump');
  const v = await runCapture(pgDump, ['--version'], { env: buildPgEnv('') , timeoutMs: 15000 });
  const major = Number((/(\d+)(?:\.\d+)*/.exec(v.out) || [])[1]);
  if (v.code !== 0 || !(major >= 18)) throw new Fail('preflight', `pg_dump 18 or newer required at ${cfg.pgBinDir}`);
  if (!fs.existsSync(path.join(cfg.pgBinDir, 'pg_restore'))) throw new Fail('preflight', 'pg_restore not found');

  // 3. Railway CLI session (local check only).
  cfg.railway = resolveRailway();
  const w = await runCapture(cfg.railway, ['whoami'], { env: process.env, timeoutMs: 20000 });
  if (w.code !== 0) throw new Fail('preflight', 'railway CLI not logged in');

  // 4. Port must be free, or the readiness probe could hit some other database.
  if (!(await checkPortFree(cfg.port))) throw new Fail('preflight', `tunnel port ${cfg.port} is already in use`);
}

async function openTunnel() {
  stage = 'tunnel';
  const child = spawn(cfg.railway, ['connect', cfg.service, '--tunnel-only', '-P', String(cfg.port), '-e', cfg.railwayEnv],
    { cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let exited = false;
  let buf = '';
  const onData = (d) => { if (buf.length < BUF_CAP) buf += d; }; // keep draining after the cap
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('exit', () => { exited = true; });
  const spawnErr = new Promise((r) => child.once('error', () => r(true)));
  if (!child.pid) { await spawnErr; throw new Fail('tunnel', 'could not start railway CLI'); }
  tunnel = { child, pid: child.pid };
  try { fs.writeFileSync(path.join(cfg.lockDir, 'tunnel.pgid'), String(child.pid)); } catch { /* best effort */ }

  const deadline = Date.now() + cfg.tunnelTimeoutS * 1000;
  let creds = null;
  while (Date.now() < deadline) {
    if (!creds && hasUrlToken(buf)) {
      try { creds = parseTunnelOutput(buf, cfg.port); } catch (e) {
        throw new Fail('tunnel', e.name === 'TunnelParseError' ? e.message : 'could not parse tunnel output (output withheld)');
      }
      secrets = [creds.password];
      buf = ''; // drop the raw output
    }
    if (creds && (await canConnect(cfg.port))) return creds;
    if (exited) throw new Fail('tunnel', 'railway tunnel process exited early (output withheld)');
    await sleep(creds ? 500 : 200);
  }
  throw new Fail('tunnel', creds ? 'tunnel port never became reachable' : `no tunnel details within ${cfg.tunnelTimeoutS}s (output withheld)`);
}

async function runDump(creds, finalName) {
  stage = 'dump';
  partialPath = path.join(cfg.realDir, finalName + '.partial');
  const args = ['-h', '127.0.0.1', '-p', String(cfg.port), '-U', creds.user, '-d', creds.database,
    '--format=custom', '--no-owner', `--file=${partialPath}`];
  const r = await runCapture(path.join(cfg.pgBinDir, 'pg_dump'), args,
    { env: buildPgEnv(creds.password), timeoutMs: cfg.dumpTimeoutS * 1000, track: true });
  if (r.timedOut) throw new Fail('dump', `pg_dump timed out after ${cfg.dumpTimeoutS}s`);
  if (r.code !== 0) throw new Fail('dump', `pg_dump failed (exit ${r.code}): ${redact(r.err, secrets).slice(0, 500)}`);
}

async function validate() {
  stage = 'validate';
  let st;
  try { st = fs.statSync(partialPath); } catch { throw new Fail('validate', 'dump file missing'); }
  if (!(st.size > 0)) throw new Fail('validate', 'dump file is empty');
  const r = await runCapture(path.join(cfg.pgBinDir, 'pg_restore'), ['--list', partialPath], { env: buildPgEnv(''), timeoutMs: 120000, track: true });
  if (r.code !== 0) throw new Fail('validate', `pg_restore --list failed: ${redact(r.err, secrets).slice(0, 300)}`);
  if (!/TABLE DATA public teams\b/.test(r.out)) throw new Fail('validate', 'dump does not contain public.teams (wrong or empty database)');
  return st.size;
}

function fsyncPath(p) { const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

function commit(finalName) {
  stage = 'rename';
  const finalPath = path.join(cfg.realDir, finalName);
  try {
    if (fs.existsSync(finalPath)) throw new Error('exists');
    fs.chmodSync(partialPath, 0o600);
    fsyncPath(partialPath);
    fs.renameSync(partialPath, finalPath);
    partialPath = null;
    fsyncPath(cfg.realDir);
  } catch { throw new Fail('rename', `could not move ${finalName} into place`); }
}

function rotate(finalName) {
  stage = 'rotate';
  try {
    const names = fs.readdirSync(cfg.realDir);
    const del = selectForDeletion(names, cfg.keep).filter((n) => n !== finalName);
    for (const n of del) fs.rmSync(path.join(cfg.realDir, n));
    return { deleted: del.length, kept: names.filter((n) => DUMP_RE.test(n)).length - del.length };
  } catch { throw new Fail('rotate', `dump ${finalName} saved but rotation failed`, 2); }
}

async function main() {
  try { cfg = loadConfig(process.env); } catch (e) {
    cfg = loadConfig({ BACKUP_LOG: process.env.BACKUP_LOG });
    throw new Fail('preflight', `bad configuration: ${e.message}`);
  }
  await preflight();
  const finalName = dumpName(new Date());
  let creds = await openTunnel();
  try { await runDump(creds, finalName); } finally {
    creds = null; secrets = [];
    await killTunnel();
  }
  const size = await validate();
  commit(finalName);
  const { deleted, kept } = rotate(finalName);
  const line = `${iso()} OK   file=${finalName} size=${(size / 1048576).toFixed(1)}MB kept=${kept} deleted=${deleted} duration=${duration()}`;
  logLine(line);
  console.log(line);
  await cleanup();
}

main().then(() => process.exit(0), async (e) => {
  if (!cfg) cfg = loadConfig({});
  if (e instanceof Fail) return finishFail(e);
  return finishFail(new Fail(stage, `unexpected error (${e?.code || e?.name || 'unknown'})`));
});
