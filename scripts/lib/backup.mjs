// Pure helpers for scripts/backup-db.mjs (M3, docs/plans/M3-backup.md).
// No secrets are read from .env here, and this file must never import
// scripts/lib/env.mjs: the backup credentials come only from the Railway
// tunnel output, in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DUMP_PREFIX = 'chalk-that-nba_';
export const DUMP_RE = /^chalk-that-nba_\d{8}T\d{6}Z\.dump$/;
export const PARTIAL_RE = /^chalk-that-nba_.*\.dump\.partial$/;
// Hard deny: the Time Machine destination volume (owner decision 2026-11-01).
export const DENIED_VOLUME = '/volumes/tm-prism';

const intIn = (name, raw, dflt, min, max) => {
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

export function loadConfig(env = process.env, { home = os.homedir() } = {}) {
  const volume = env.BACKUP_VOLUME || '/Volumes/DB-Backups';
  const logPath = env.BACKUP_LOG || path.join(home, 'Library/Logs/chalk-that-nba/backup.log');
  return {
    volume,
    dir: env.BACKUP_DIR || path.join(volume, 'db-backups'),
    keep: intIn('BACKUP_KEEP', env.BACKUP_KEEP, 14, 1, 10000),
    logPath,
    lockDir: path.join(path.dirname(logPath), 'backup.lock'),
    service: env.BACKUP_PG_SERVICE || 'Postgres',
    railwayEnv: env.BACKUP_RAILWAY_ENV || 'production',
    port: intIn('BACKUP_TUNNEL_PORT', env.BACKUP_TUNNEL_PORT, 55432, 1024, 65535),
    tunnelTimeoutS: intIn('BACKUP_TUNNEL_TIMEOUT_S', env.BACKUP_TUNNEL_TIMEOUT_S, 60, 1, 3600),
    dumpTimeoutS: intIn('BACKUP_DUMP_TIMEOUT_S', env.BACKUP_DUMP_TIMEOUT_S, 1800, 1, 86400),
    pgBinDir: env.BACKUP_PG_BIN_DIR || '/opt/homebrew/opt/libpq/bin',
    railwayBin: env.BACKUP_RAILWAY_BIN || '',
    notify: env.BACKUP_NOTIFY !== '0',
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function dumpName(date = new Date()) {
  const d = date;
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `${DUMP_PREFIX}${stamp}.dump`;
}

// Returns the names to delete: everything matching DUMP_RE except the `keep`
// newest. Non-matching names are never returned.
export function selectForDeletion(names, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be an integer >= 1');
  const own = names.filter((n) => DUMP_RE.test(n)).sort().reverse();
  return own.slice(keep);
}

export class TunnelParseError extends Error {
  constructor(code) {
    // Fixed strings only: the tunnel output holds the password.
    super(`could not parse tunnel output (output withheld): ${code}`);
    this.name = 'TunnelParseError';
    this.code = code;
  }
}

export const hasUrlToken = (text) => /postgres(?:ql)?:\/\/\S+\s/.test(text);

// `railway connect --tunnel-only` (CLI v5.71.0, src/commands/connect.rs
// print_tunnel_info) prints to STDERR a block ending in
//   "  URL:      postgres://user:pw%40x@127.0.0.1:55432/railway"
// Callers pass stdout + stderr joined. We take the first postgres URL token.
export function parseTunnelOutput(text, port) {
  const m = /postgres(?:ql)?:\/\/[^\s]+/.exec(String(text));
  if (!m) throw new TunnelParseError('no-url');
  let u;
  try { u = new URL(m[0]); } catch { throw new TunnelParseError('bad-url'); }
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new TunnelParseError('non-local-host');
  if (Number(u.port) !== Number(port)) throw new TunnelParseError('wrong-port');
  let user; let password; let database;
  try {
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
    database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch { throw new TunnelParseError('bad-encoding'); }
  if (!user || !password || !database) throw new TunnelParseError('missing-field');
  return { user, password, database };
}

export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (!s) continue;
    for (const v of new Set([s, encodeURIComponent(s)])) out = out.split(v).join('[redacted]');
  }
  return out
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .replace(/password=\S+/gi, 'password=[redacted]');
}

// Allow-list env for pg_dump / pg_restore: nothing is inherited except these.
export function buildPgEnv(password, base = process.env) {
  return {
    PATH: base.PATH || '/usr/bin:/bin',
    HOME: base.HOME || os.homedir(),
    LANG: base.LANG || 'en_US.UTF-8',
    PGPASSWORD: password,
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'chalk-backup',
  };
}

// Production guard (fix cycle 1 after the M3 incident). Returns null when the
// run may proceed, else a fixed reason string. Rule, fail-closed: the run is
// "test mode" only when BACKUP_RAILWAY_BIN is set to an executable whose name
// (and whose symlink target's name) is not `railway`. Anything else (unset,
// empty, or pointing at a binary called `railway`) targets the real CLI and
// needs BACKUP_CONFIRM_PROD to be exactly "1".
export function prodGuard(env = process.env) {
  const bin = env.BACKUP_RAILWAY_BIN || '';
  let testBin = false;
  if (bin) {
    let real = bin;
    try { real = fs.realpathSync(bin); } catch { /* keep the given name */ }
    testBin = path.basename(bin) !== 'railway' && path.basename(real) !== 'railway';
  }
  if (testBin || env.BACKUP_CONFIRM_PROD === '1') return null;
  return 'production run not confirmed (set BACKUP_CONFIRM_PROD=1)';
}

export function isMountPoint(p, statFn = fs.statSync) {
  const a = statFn(p);
  if (!a.isDirectory()) return false;
  return a.dev !== statFn(path.dirname(p)).dev;
}

// realpath that tolerates a not-yet-created tail.
export function realpathLoose(p, depth = 0) {
  if (depth > 20) throw new Error('too many symlinks');
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      // A dangling symlink must be followed, not treated as a missing name.
      let link = null;
      try { if (fs.lstatSync(cur).isSymbolicLink()) link = fs.readlinkSync(cur); } catch { /* not a link */ }
      if (link !== null) return path.join(realpathLoose(path.resolve(parent, link), depth + 1), ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const deniedPath = (p) => within(p.toLowerCase(), DENIED_VOLUME);

// Throws Error (fixed message) unless `dir` is safe to write backups into.
export function assertSafeBackupDir(dir, volume, { repoRoot } = {}) {
  if (deniedPath(path.resolve(dir)) || deniedPath(path.resolve(volume))) throw new Error('backup path is under the Time Machine volume');
  const rVol = realpathLoose(volume);
  const rDir = realpathLoose(dir);
  if (deniedPath(rDir) || deniedPath(rVol)) throw new Error('backup path resolves under the Time Machine volume');
  if (!within(rDir, rVol)) throw new Error('backup dir is outside the backup volume');
  if (repoRoot && within(rDir, realpathLoose(repoRoot))) throw new Error('backup dir is inside the repository');
  return { dir: rDir, volume: rVol };
}
