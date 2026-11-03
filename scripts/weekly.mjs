// Weekly NBA.com run through the Railway CLI tunnel (M5, docs/plans/M5-weekly-tunnel.md).
// `npm run db:weekly` (via scripts/weekly.sh), or Mondays via ops/launchd/com.chalkthat.nba.weekly.plist.
//
//   guard -> lock -> preflight -> backup (reuse a validated one < 24 h old, wait for a running one,
//   else take one; abort if it fails) -> tunnel -> schedule -> positions -> backfill -> status ->
//   close the tunnel on every exit path (scripts/lib/tunnel.mjs, the M4 sequence) and verify the port.
//
// The tunnel credentials stay in memory. The step children get them as DATABASE_PUBLIC_URL in their
// own env only (never argv, a file, tunnel.json or a log); all child output is redacted line by line.
// Deliberately does NOT import scripts/lib/env.mjs and never reads .env (the steps read it themselves).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTunnel, TunnelError } from './lib/tunnel.mjs';
import {
  loadWeeklyConfig, weeklyGuard, fakeIsolationError, isFakeBin, findFreshBackup, backupLockState, buildTunnelUrl,
  stepEnv, stepArgv, lineRedactor, STEPS, BACKUP_BUSY_LINE,
} from './lib/weekly.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim().slice(0, 500);

class Fail extends Error {
  constructor(stage, reason, code = 1) { super(reason); this.stage = stage; this.reason = reason; this.exitCode = code; }
}

process.umask(0o077);
const started = Date.now();
const duration = () => `${Math.round((Date.now() - started) / 1000)}s`;
let cfg = null;
let logPath = process.env.WEEKLY_LOG || path.join(REPO_ROOT, 'logs/weekly.log');
let notifyOn = process.env.WEEKLY_NOTIFY !== '0';
let stage = 'preflight';
let tunnel = null;
let lockHeld = false;
let active = null;       // { child, group, exited } for the running backup or step child
let secrets = [];
let finishing = false;
let season = '2026-27';

function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath, line + '\n', { mode: 0o600 });
  } catch { /* console still has the result line */ }
}
const note = (msg) => logLine(`${iso()} NOTE ${msg}`);

function notify(ok) {
  if (!notifyOn) return;
  const msg = ok ? 'Weekly NBA.com run OK' : 'Weekly NBA.com run FAILED — see logs/weekly.log';
  try {
    const c = spawn('/usr/bin/osascript', ['-e', `display notification "${msg}" with title "Chalk That Hardwood"`], { stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
  } catch { /* ignore */ }
}

function releaseLock() {
  if (lockHeld && cfg) { try { fs.rmSync(cfg.lockDir, { recursive: true, force: true }); } catch { /* ignore */ } lockHeld = false; }
}

const sigGroup = (a, sig) => { try { process.kill(-a.child.pid, sig); } catch { /* gone */ } };

// SIGTERM the active child's group, wait up to graceMs for it to exit (the backup closes its own
// tunnel in that time), then SIGKILL the group.
async function stopActive(graceMs) {
  const a = active;
  if (!a) return;
  sigGroup(a, 'SIGTERM');
  const end = Date.now() + graceMs;
  while (!a.exited && Date.now() < end) await sleep(100);
  if (!a.exited) sigGroup(a, 'SIGKILL');
  sigGroup(a, 'SIGKILL'); // stragglers in the group (pg_dump, a step's own children)
  active = null;
}

async function cleanup() {
  await stopActive(active?.kind === 'backup' ? 30000 : 10000);
  if (tunnel) await tunnel.kill();
  releaseLock();
  secrets = [];
}

// Last resort, synchronous.
process.on('exit', () => {
  if (tunnel) tunnel.killSync();
  if (active) sigGroup(active, 'SIGKILL');
  releaseLock();
});

async function finish(line, code, ok) {
  logLine(line);
  logLine(`=== exit ${code} ===`);
  (code === 0 ? console.log : console.error)(line);
  notify(ok);
  process.exit(code);
}

async function finishFail(f) {
  if (finishing) return;
  finishing = true;
  await cleanup();
  if (tunnel?.portStillHeld && f.stage !== 'cleanup') f.reason += `; tunnel port ${cfg.port} still in use after cleanup`;
  await finish(`${iso()} FAIL stage=${f.stage} reason="${oneLine(f.reason)}" duration=${duration()}`, f.exitCode ?? 1, false);
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => { finishFail(new Fail(stage, `interrupted by ${sig}`, code)); });
}
// After a signal the cleanup owns the process: main() must not carry on (e.g. open a tunnel).
const checkpoint = async () => { if (finishing) await new Promise(() => {}); };

// Run a short child to completion (whoami), capped output, no stdin.
function runCapture(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', () => { clearTimeout(t); resolve(-1); });
    c.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
}

// Run node `argv` in its own process group; output is redacted line by line into the weekly log.
// Resolves { code, signal, timedOut, lastErr }.
function runNode(kind, argv, env, { timeoutS = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const a = { child, kind, exited: false };
    active = a;
    let lastErr = ''; let timedOut = false; let killTimer = null;
    const out = lineRedactor(secrets, (l) => logLine(l));
    const err = lineRedactor(secrets, (l) => { if (l.trim()) lastErr = l; logLine(l); });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const t = timeoutS ? setTimeout(() => {
      timedOut = true;
      sigGroup(a, 'SIGTERM');
      killTimer = setTimeout(() => sigGroup(a, 'SIGKILL'), 10000);
    }, timeoutS * 1000) : null;
    const done = (code, signal) => {
      if (t) clearTimeout(t);
      if (killTimer) clearTimeout(killTimer);
      a.exited = true;
      sigGroup(a, 'SIGKILL'); // nothing from this step's group outlives it
      out.flush(); err.flush();
      if (active === a) active = null;
      resolve({ code, signal, timedOut, lastErr });
    };
    child.on('error', () => done(-1, null));
    child.on('exit', (code, signal) => { setTimeout(() => done(code, signal), 300); }); // let the pipes drain
  });
}

async function takeLock() {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(cfg.lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(cfg.lockDir, 'pid'), String(process.pid), { mode: 0o600 });
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new Fail('preflight', 'could not create lock');
      let pid = 0;
      try { pid = Number(fs.readFileSync(path.join(cfg.lockDir, 'pid'), 'utf8')); } catch { /* unreadable */ }
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (er) { alive = er.code === 'EPERM'; } }
      if (alive) throw new Fail('preflight', 'another weekly run is in progress');
      if (await tunnel.reapStale()) note('reaped an orphaned tunnel left by a crashed run');
      fs.rmSync(cfg.lockDir, { recursive: true, force: true }); // stale
    }
  }
  throw new Fail('preflight', 'could not take lock');
}

function resolveRailway() {
  if (cfg.railwayBin) {
    try { return fs.realpathSync(cfg.railwayBin); } catch { throw new Fail('preflight', 'WEEKLY_RAILWAY_BIN not found'); }
  }
  const r = spawnSync('/usr/bin/which', ['railway'], { encoding: 'utf8' });
  const p = r.status === 0 ? r.stdout.trim() : '';
  return p || '/opt/homebrew/bin/railway';
}

async function preflight() {
  await takeLock();
  const bin = resolveRailway();
  tunnel.setRailwayBin(bin);
  if ((await runCapture(bin, ['whoami'], { env: process.env, timeoutMs: 20000 })) !== 0) throw new Fail('preflight', 'railway CLI not logged in');
  // The port must be free, or the readiness probe could hit some other database. An ssh forwarder
  // left by an earlier WEEKLY run (railway gone) is reaped; anything else is not touched.
  if (!(await tunnel.portFree())) {
    const n = await tunnel.reapOrphans();
    if (n > 0 && (await tunnel.waitPortFree(4))) note(`reaped an orphaned ssh tunnel on port ${cfg.port}`);
    else throw new Fail('preflight', `tunnel port ${cfg.port} is already in use`);
  }
}

// Owner Gate 1 answer 1: back up before writing. Returns { name, reused }.
async function ensureBackup() {
  stage = 'backup';
  const bcfg = cfg.backup;
  const deadline = Date.now() + cfg.backupWaitS * 1000;
  let waited = false;
  for (;;) {
    // a. a running backup: wait (it may produce the dump we want)
    while (backupLockState(bcfg.lockDir) === 'live') {
      if (Date.now() >= deadline) throw new Fail('backup', `backup still running after ${cfg.backupWaitS}s`);
      if (!waited) { note('waiting for a running backup'); waited = true; }
      await sleep(Math.max(100, Math.min(2000, deadline - Date.now())));
      await checkpoint();
    }
    // b. a validated backup under 24 h old
    const fresh = findFreshBackup(bcfg);
    if (fresh) { note(`using backup ${fresh.name} (age ${(fresh.ageMs / 3600000).toFixed(1)}h)`); return { name: fresh.name, reused: true }; }
    // c. take one with the backup script (its own tunnel, lock, validation and rotation)
    const r = await runNode('backup', ['scripts/backup-db.mjs'], process.env);
    await checkpoint();
    if (r.code === 0) {
      const made = findFreshBackup(bcfg);
      if (!made) throw new Fail('backup', 'backup reported OK but no validated dump found');
      return { name: made.name, reused: false };
    }
    if (BACKUP_BUSY_LINE.test(r.lastErr) && Date.now() < deadline) { note('another backup took the lock first; waiting for it'); waited = true; continue; }
    throw new Fail('backup', `db:backup failed (exit ${r.code ?? r.signal})`);
  }
}

async function main() {
  season = process.argv[2] || '2026-27';
  try { cfg = loadWeeklyConfig(process.env, { season }); } catch (e) {
    logLine(`=== ${new Date().toLocaleString('sv').slice(0, 16)} weekly run, season ${oneLine(season)} ===`);
    throw new Fail('preflight', `bad configuration: ${e.message}`);
  }
  logPath = cfg.logPath; notifyOn = cfg.notify;
  logLine(`=== ${new Date().toLocaleString('sv').slice(0, 16)} weekly run, season ${season} ===`);

  // Production guard: first, before the lock, the backup, any CLI call or any child.
  const blocked = weeklyGuard(process.env);
  if (blocked) throw new Fail('preflight', blocked);
  const notIsolated = fakeIsolationError(cfg, process.env);
  if (notIsolated) throw new Fail('preflight', notIsolated);
  if (cfg.stepFixture && !isFakeBin(process.env, 'WEEKLY_RAILWAY_BIN')) throw new Fail('preflight', 'step fixture requires the fake railway');

  tunnel = createTunnel({
    railwayBin: cfg.railwayBin, service: cfg.service, railwayEnv: cfg.railwayEnv, port: cfg.port,
    timeoutS: cfg.tunnelTimeoutS, lockDir: cfg.lockDir, cwd: REPO_ROOT, env: process.env, myUid: process.getuid(),
  });
  await preflight();
  await checkpoint();

  const backup = await ensureBackup();
  await checkpoint();

  stage = 'tunnel';
  let creds;
  try { creds = await tunnel.open(); } catch (e) {
    if (e instanceof TunnelError) throw new Fail('tunnel', e.reason);
    throw e;
  }
  secrets = [creds.password];
  let url = buildTunnelUrl(creds, cfg.port);
  creds = null;
  try {
    for (const step of STEPS) {
      await checkpoint();
      stage = step.name;
      const argv = stepArgv(step, season, { fixture: cfg.stepFixture });
      const r = await runNode(step.name, argv, stepEnv(process.env, url), { timeoutS: cfg.stepTimeoutS });
      await checkpoint();
      if (r.timedOut) throw new Fail(step.name, `timed out after ${cfg.stepTimeoutS}s`);
      if (r.code !== 0) throw new Fail(step.name, `exit ${r.code ?? r.signal}`);
    }
  } finally {
    url = null; secrets = [];
    await tunnel.kill();
  }
  await checkpoint();
  // Same convention as the backup: a leaked port is reported even if every step passed.
  if (tunnel.portStillHeld) throw new Fail('cleanup', `tunnel port ${cfg.port} still in use after run`, 2);
  finishing = true;
  releaseLock();
  await finish(`${iso()} OK season=${season} backup=${backup.reused ? 'reused' : 'new'}:${backup.name} duration=${duration()}`, 0, true);
}

main().catch(async (e) => {
  if (e instanceof Fail) return finishFail(e);
  return finishFail(new Fail(stage, `unexpected error (${e?.code || e?.name || 'unknown'})`));
});
