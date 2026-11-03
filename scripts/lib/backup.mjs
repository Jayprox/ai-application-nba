// Pure helpers for scripts/backup-db.mjs (M3, docs/plans/M3-backup.md).
// No secrets are read from .env here, and this file must never import
// scripts/lib/env.mjs: the backup credentials come only from the Railway
// tunnel output, in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  if (env.BACKUP_RAILWAY_BIN && !path.isAbsolute(env.BACKUP_RAILWAY_BIN)) throw new Error('BACKUP_RAILWAY_BIN must be an absolute path');
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

const LIB_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FAKE_RAILWAY_REL = 'scripts/fixtures/fake-railway.sh';

// Production guard (M3 fix cycles 1-2, after the disclosed incident). Returns
// null when the run may proceed, else a fixed reason string. Allow-list,
// fail-closed: the run is exempt ONLY when BACKUP_RAILWAY_BIN resolves (realpath)
// to this repo's own scripts/fixtures/fake-railway.sh. Everything else (unset,
// empty, a binary called railway/Railway, copies, hard links, wrappers, a
// missing file) needs BACKUP_CONFIRM_PROD to be exactly "1". The drill's
// PATH-shadow cases need no exemption: the no-flag cases are refused before any
// lookup, and the flag=1 case points BACKUP_RAILWAY_BIN at a verified shadow.
export function confirmGuard(env, flagName, binVar, message, { repoRoot = LIB_REPO_ROOT } = {}) {
  if (env[flagName] === '1') return null;
  const bin = env[binVar] || '';
  if (bin) {
    try {
      const real = fs.realpathSync.native(bin);
      const fake = fs.realpathSync.native(path.join(repoRoot, FAKE_RAILWAY_REL));
      if (real === fake) return null;
    } catch { /* missing or unresolvable: not exempt */ }
  }
  return message;
}

export function prodGuard(env = process.env, opts = {}) {
  return confirmGuard(env, 'BACKUP_CONFIRM_PROD', 'BACKUP_RAILWAY_BIN', 'production run not confirmed (set BACKUP_CONFIRM_PROD=1)', opts);
}

// Devices of any Time Machine destination mount point (stat of the mount point
// only; nothing is listed, read or written inside it).
export function timeMachineDevices(run = spawnSync) {
  const cands = new Set(['/Volumes/TM-Prism', '/System/Volumes/Data/Volumes/TM-Prism']);
  try {
    const r = run('/usr/bin/tmutil', ['destinationinfo'], { encoding: 'utf8', timeout: 10000 });
    for (const m of String(r.stdout || '').matchAll(/Mount Point\s*:\s*(.+)/g)) cands.add(m[1].trim());
  } catch { /* tmutil unavailable */ }
  const devs = new Set();
  for (const c of cands) { try { devs.add(fs.statSync(c).dev); } catch { /* not mounted */ } }
  return devs;
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
// /System/Volumes/Data/Volumes/X is the same place as /Volumes/X (firmlink).
const normDeny = (p) => p.toLowerCase().replace(/^\/system\/volumes\/data(?=\/|$)/, '');
const deniedPath = (p) => within(normDeny(p), DENIED_VOLUME);
const nearestDev = (p) => { let c = p; for (;;) { try { return fs.statSync(c).dev; } catch { const n = path.dirname(c); if (n === c) return null; c = n; } } };

// Throws Error (fixed message) unless `dir` is safe to write backups into.
export function assertSafeBackupDir(dir, volume, { repoRoot, denyDevices } = {}) {
  if (deniedPath(path.resolve(dir)) || deniedPath(path.resolve(volume))) throw new Error('backup path is under the Time Machine volume');
  const rVol = realpathLoose(volume);
  const rDir = realpathLoose(dir);
  if (deniedPath(rDir) || deniedPath(rVol)) throw new Error('backup path resolves under the Time Machine volume');
  if (denyDevices && denyDevices.size && (denyDevices.has(nearestDev(rDir)) || denyDevices.has(nearestDev(rVol)))) throw new Error('backup path is on the Time Machine device');
  if (!within(rDir, rVol)) throw new Error('backup dir is outside the backup volume');
  if (repoRoot && within(rDir, realpathLoose(repoRoot))) throw new Error('backup dir is inside the repository');
  return { dir: rDir, volume: rVol };
}

// ---- M4: finding and safely signalling the ssh child (docs/plans/M4-backup-ssh-child.md) ----
// The real CLI starts `ssh -N -L ...` in its OWN process group (CLI v5.71.0
// native.rs process_group(0)) and kills it only on a graceful Ctrl+C. So the script
// must find and kill the ssh child itself. Everything that decides "may we signal this
// pid?" is a pure function here; backup-db.mjs only does the I/O. ps/lsof output and
// argv are never logged.

const tokens = (args) => String(args ?? '').trim().split(/\s+/).filter(Boolean);
const SSH_TARGET_RE = /^[^@\s]+@ssh\.railway(-develop|-staging)?\.com$/;
const FORWARD_RE = /^127\.0\.0\.1:(\d{1,5}):127\.0\.0\.1:(\d{1,5})$/;

// True only for the exact forward the Railway CLI starts for `connect --tunnel-only -P <port>`:
// argv0 basename `ssh`, -N, -o ExitOnForwardFailure=yes, exactly one -L 127.0.0.1:<port>:127.0.0.1:<n>,
// no -R/-D, last token user@ssh.railway[-develop|-staging].com. Extra tokens are allowed
// (the drill fixture has a script path). A path with spaces fails to match: the safe direction.
export function isRailwaySshForward(args, port) {
  const t = tokens(args);
  if (t.length < 4 || path.basename(t[0]) !== 'ssh') return false;
  if (!t.includes('-N')) return false;
  if (!t.some((x, i) => x === '-o' && t[i + 1] === 'ExitOnForwardFailure=yes')) return false;
  const ls = t.map((x, i) => (x === '-L' ? i : -1)).filter((i) => i >= 0);
  if (ls.length !== 1) return false;
  const m = FORWARD_RE.exec(t[ls[0] + 1] || '');
  if (!m || m[1] !== String(port)) return false;
  if (t.some((x) => x.startsWith('-R') || x.startsWith('-D'))) return false;
  return SSH_TARGET_RE.test(t[t.length - 1]);
}

// True only for `<railwayBin> connect ... --tunnel-only -P <port> ...` (also via /bin/sh, so the
// shell-script fixture matches). Replaces the loose regexes of the M3 reaper (Lead F5(3)).
export function isRailwayTunnelCmd(args, port, railwayBin) {
  if (!railwayBin) return false;
  let t = tokens(args);
  if ((t[0] === '/bin/sh' || t[0] === 'sh') && t[1] === railwayBin) t = t.slice(1);
  if (t[0] !== railwayBin || t[1] !== 'connect') return false;
  if (!t.includes('--tunnel-only')) return false;
  return t.some((x, i) => x === '-P' && t[i + 1] === String(port));
}

// `ps -axww -o pid=,ppid=,pgid=,uid=,lstart=,args=` (run with LC_ALL=C: lstart is 5 tokens).
export function parsePsRows(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], uid: +m[4], lstart: m[5].replace(/\s+/g, ' '), args: m[6] });
  }
  return rows;
}

// Every transitive child of rootPid (root excluded). Cycle-safe.
export function descendantsOf(rows, rootPid) {
  const out = []; const seen = new Set([rootPid]); const queue = [rootPid];
  while (queue.length) {
    const cur = queue.shift();
    for (const r of rows) if (r.ppid === cur && !seen.has(r.pid)) { seen.add(r.pid); out.push(r); queue.push(r.pid); }
  }
  return out;
}

// `lsof -Fp` output: "p<pid>" lines.
export function parseLsofPids(text) {
  const pids = [];
  for (const line of String(text ?? '').split('\n')) { const m = /^p(\d+)$/.exec(line.trim()); if (m) pids.push(+m[1]); }
  return pids;
}

// The one place that decides whether an ssh process on the backup port may be reaped.
// Kill only if EVERY rule holds. `recordedRailwayPid` is passed only when our own stale
// tunnel.json named it and that process passed isRailwayTunnelCmd. `expectedLstart` is
// the start time we recorded for this pid (PID-reuse guard), if any.
export function reapDecision({ row, myUid, port, listenerPids, recordedRailwayPid = null, expectedLstart = null, selfPid = process.pid }) {
  if (!row || !Number.isInteger(row.pid) || row.pid <= 1 || row.pid === selfPid) return { kill: false, reason: 'bad-pid' };
  if (row.uid !== myUid) return { kill: false, reason: 'wrong-uid' };
  if (expectedLstart && row.lstart !== expectedLstart) return { kill: false, reason: 'pid-reused' };
  if (!isRailwaySshForward(row.args, port)) return { kill: false, reason: 'argv-mismatch' };
  if (!Array.isArray(listenerPids) || !listenerPids.includes(row.pid)) return { kill: false, reason: 'not-listener' };
  if (row.ppid !== 1 && !(recordedRailwayPid && row.ppid === recordedRailwayPid)) return { kill: false, reason: 'parent-alive' };
  return { kill: true, reason: 'orphaned-railway-ssh' };
}

// Validates the lock dir's tunnel.json (written by us, but read back defensively).
export function parseTunnelRecord(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return null; }
  const isPid = (n) => Number.isInteger(n) && n > 1;
  if (!j || typeof j !== 'object' || !isPid(j.railwayPid) || !Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null;
  if (typeof j.railwayBin !== 'string' || !j.railwayBin) return null;
  const ssh = Array.isArray(j.ssh) ? j.ssh.filter((s) => s && isPid(s.pid)).map((s) => ({ pid: s.pid, lstart: typeof s.lstart === 'string' ? s.lstart : null })) : [];
  return { railwayPid: j.railwayPid, port: j.port, railwayBin: j.railwayBin, ssh };
}

// I/O wrappers (absolute tool paths, timeouts). On any error: null / [] = "no match, no kill".
export function psSnapshot(run = spawnSync) {
  try {
    const r = run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,args='],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
    return r.status === 0 ? parsePsRows(r.stdout) : null;
  } catch { return null; }
}
// Pids listening on exactly 127.0.0.1:<port> (lsof -Fpn: "p<pid>" then "n<name>" lines).
export function parseLsofListeners(text, port) {
  const pids = new Set(); let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const p = /^p(\d+)$/.exec(line.trim());
    if (p) { cur = +p[1]; continue; }
    if (cur && line.trim() === `n127.0.0.1:${port}`) pids.add(cur);
  }
  return [...pids];
}
export function listenerPids(port, run = spawnSync) {
  try {
    const r = run('/usr/sbin/lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 5000 });
    return parseLsofListeners(r.stdout, Number(port));
  } catch { return []; }
}
