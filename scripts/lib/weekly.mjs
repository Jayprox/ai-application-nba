// Pure helpers for scripts/weekly.mjs (M5, docs/plans/M5-weekly-tunnel.md).
// Like backup.mjs: never imports ./env.mjs and never reads .env. The tunnel URL is built in
// memory and handed to each step child's env only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, confirmGuard, prodGuard, isMountPoint, DUMP_RE, redact, FAKE_RAILWAY_REL } from './backup.mjs';

const LIB_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DAY_MS = 24 * 3600 * 1000;
export const WEEKLY_GUARD_MSG = 'production run not confirmed (set WEEKLY_CONFIRM_PROD=1 and BACKUP_CONFIRM_PROD=1)';
export const RESERVED_PORTS = [55432, 55433];
export const BACKUP_BUSY_LINE = /FAIL stage=preflight reason="another backup is running" duration=\d+s\s*$/;

// Step table: the same scripts as package.json db:schedule / db:positions / db:backfill / db:status,
// in the owner's order (Gate 1). `season` steps get `--season S`.
export const STEPS = [
  { name: 'schedule', script: 'scripts/load-schedule.mjs', season: true, npm: 'db:schedule' },
  { name: 'positions', script: 'scripts/load-positions.mjs', season: false, npm: 'db:positions' },
  { name: 'backfill', script: 'scripts/backfill.mjs', season: true, npm: 'db:backfill' },
  { name: 'status', script: 'scripts/db-status.mjs', season: false, npm: 'db:status' },
];
export const FIXTURE_STEP = 'scripts/fixtures/fake-weekly-step.mjs';

const intIn = (name, raw, dflt, min, max) => {
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

// Throws Error with a fixed message on bad config. `season` is the CLI arg (default 2026-27).
export function loadWeeklyConfig(env = process.env, { season = '2026-27', home = os.homedir(), repoRoot = LIB_REPO_ROOT } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(season))) throw new Error('season must look like 2026-27');
  if (env.WEEKLY_RAILWAY_BIN && !path.isAbsolute(env.WEEKLY_RAILWAY_BIN)) throw new Error('WEEKLY_RAILWAY_BIN must be an absolute path');
  const bcfg = loadConfig(env, { home }); // the backup's own config: its port, dir, log and lock
  const port = intIn('WEEKLY_TUNNEL_PORT', env.WEEKLY_TUNNEL_PORT, 55434, 1024, 65535);
  if (RESERVED_PORTS.includes(port) || port === bcfg.port) throw new Error('WEEKLY_TUNNEL_PORT must not be 55432, 55433 or the backup tunnel port');
  const stateDir = env.WEEKLY_STATE_DIR || path.join(home, 'Library/Logs/chalk-that-nba');
  const lockDir = path.join(stateDir, 'weekly.lock');
  if (path.resolve(lockDir) === path.resolve(bcfg.lockDir)) throw new Error('weekly lock dir must not be the backup lock dir');
  return {
    season,
    port,
    backupWaitS: intIn('WEEKLY_BACKUP_WAIT_S', env.WEEKLY_BACKUP_WAIT_S, 600, 1, 600),
    stepTimeoutS: intIn('WEEKLY_STEP_TIMEOUT_S', env.WEEKLY_STEP_TIMEOUT_S, 3600, 1, 14400),
    tunnelTimeoutS: intIn('WEEKLY_TUNNEL_TIMEOUT_S', env.WEEKLY_TUNNEL_TIMEOUT_S, 60, 1, 3600),
    service: env.WEEKLY_PG_SERVICE || 'Postgres',
    railwayEnv: env.WEEKLY_RAILWAY_ENV || 'production',
    railwayBin: env.WEEKLY_RAILWAY_BIN || '',
    logPath: env.WEEKLY_LOG || path.join(repoRoot, 'logs/weekly.log'),
    notify: env.WEEKLY_NOTIFY !== '0',
    stepFixture: env.WEEKLY_STEP_FIXTURE === '1',
    stateDir,
    lockDir,
    backup: bcfg,
  };
}

// True when env[binVar] resolves (realpath) to this repo's fake railway.
export function isFakeBin(env, binVar, { repoRoot = LIB_REPO_ROOT } = {}) {
  const bin = env[binVar] || '';
  if (!bin) return false;
  try { return fs.realpathSync.native(bin) === fs.realpathSync.native(path.join(repoRoot, FAKE_RAILWAY_REL)); } catch { return false; }
}

// Returns null when the run may proceed, else a fixed reason string.
//  - real weekly: WEEKLY_CONFIRM_PROD and BACKUP_CONFIRM_PROD must both be exactly "1"
//  - fake weekly (WEEKLY_RAILWAY_BIN is the repo fake): exempt, but only if the backup it would
//    start is fake too (BACKUP_RAILWAY_BIN), so a test run can never start a real backup.
export function weeklyGuard(env = process.env, { repoRoot = LIB_REPO_ROOT } = {}) {
  const blocked = confirmGuard(env, 'WEEKLY_CONFIRM_PROD', 'WEEKLY_RAILWAY_BIN', WEEKLY_GUARD_MSG, { repoRoot });
  if (blocked) return blocked;
  if (isFakeBin(env, 'WEEKLY_RAILWAY_BIN', { repoRoot })) {
    const { BACKUP_CONFIRM_PROD: _drop, ...noFlag } = env;
    return prodGuard(noFlag, { repoRoot }) === null ? null : WEEKLY_GUARD_MSG;
  }
  return env.BACKUP_CONFIRM_PROD === '1' ? null : WEEKLY_GUARD_MSG;
}

const STAMP_RE = /^chalk-that-nba_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;
export function stampMs(name) {
  const m = STAMP_RE.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOG_TAIL = 1024 * 1024;

function readTail(file, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const size = fsImpl.fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL);
    const buf = Buffer.alloc(len);
    fsImpl.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } } }
}

// Newest validated backup under 24 h old, or null. "Validated" = the name exists in its final form
// (backup-db.mjs renames only after pg_restore --list and the teams check) AND backup.log has the
// run's OK line for exactly that name (so rotate and port cleanup also finished).
// `bcfg` is loadConfig(env) from backup.mjs. Returns { name, ageMs } or null.
export function findFreshBackup(bcfg, { now = Date.now(), fsImpl = fs, mountCheck = isMountPoint } = {}) {
  try { if (!mountCheck(bcfg.volume)) return null; } catch { return null; }
  let names;
  try { names = fsImpl.readdirSync(bcfg.dir); } catch { return null; }
  const cands = names.filter((n) => DUMP_RE.test(n)).sort().reverse();
  if (!cands.length) return null;
  const log = readTail(bcfg.logPath, fsImpl);
  for (const name of cands) {
    const age = now - stampMs(name);
    if (!(age >= 0 && age < DAY_MS)) continue; // 24 h old or older, or stamped in the future
    let st;
    try { st = fsImpl.lstatSync(path.join(bcfg.dir, name)); } catch { continue; }
    if (!st.isFile() || !(st.size > 0)) continue; // symlinks and empty files are never reused
    if (!new RegExp(`^\\S+Z OK +file=${escRe(name)} `, 'm').test(log)) continue;
    return { name, ageMs: age };
  }
  return null;
}

// 'none' | 'live' | 'stale' for the backup lock dir. Read only; never creates or removes it.
export function backupLockState(lockDir, { fsImpl = fs, kill = process.kill.bind(process) } = {}) {
  try { fsImpl.statSync(lockDir); } catch { return 'none'; }
  let pid = 0;
  try { pid = Number(fsImpl.readFileSync(path.join(lockDir, 'pid'), 'utf8')); } catch { /* unreadable */ }
  if (pid > 0) { try { kill(pid, 0); return 'live'; } catch (e) { if (e.code === 'EPERM') return 'live'; } }
  return 'stale';
}

export function buildTunnelUrl({ user, password, database }, port) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${Number(port)}/${encodeURIComponent(database)}`;
}

// Env for one step child: a copy of `base` with DATABASE_PUBLIC_URL set and both prod flags removed.
export function stepEnv(base, url) {
  const { WEEKLY_CONFIRM_PROD: _w, BACKUP_CONFIRM_PROD: _b, ...rest } = base;
  return { ...rest, DATABASE_PUBLIC_URL: url };
}

// `[script, ...args]` for node. In fixture mode schedule/positions/backfill are the fake step.
export function stepArgv(step, season, { fixture = false } = {}) {
  const seasonArgs = step.season ? ['--season', season] : [];
  if (fixture && step.name !== 'status') return [FIXTURE_STEP, step.name, ...seasonArgs];
  return [step.script, ...seasonArgs];
}

// Line-buffered redactor: a secret split across two chunks never slips through, because only
// complete lines are written. `write(line)` gets the redacted text without the newline.
export function lineRedactor(secrets, write) {
  let buf = '';
  const out = (line) => write(redact(line, secrets));
  return {
    push(chunk) {
      buf += String(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { out(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 65536) { out(buf.slice(0, buf.length - 1024)); buf = buf.slice(-1024); }
    },
    flush() { if (buf) { out(buf); buf = ''; } },
  };
}
