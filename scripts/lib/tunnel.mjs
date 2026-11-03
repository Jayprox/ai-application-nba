// Railway CLI tunnel lifecycle, shared by scripts/backup-db.mjs and scripts/weekly.mjs
// (M5, docs/plans/M5-weekly-tunnel.md). Extracted from backup-db.mjs unchanged in behavior;
// the M4 rules apply (docs/plans/M4-backup-ssh-child.md): railway starts its `ssh -N -L` child in
// its OWN process group and only stops it on a graceful Ctrl+C, so every exit path finds that
// ssh child (while railway is still its parent), signals it explicitly, then checks the port.
//
// A factory with no module globals: each caller gets its own port and lock dir, and the reapers
// only ever look at that port and that lock dir's tunnel.json. The pure decision functions live
// in ./backup.mjs; this file does the I/O. Credentials are returned in memory only and are never
// logged, written or put in argv. Must not import ./env.mjs and never reads .env.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseTunnelOutput, hasUrlToken, isRailwaySshForward, isRailwayTunnelCmd, descendantsOf,
  psSnapshot, listenerPids, reapDecision, parseTunnelRecord,
} from './backup.mjs';

const BUF_CAP = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `reason` strings are exactly the ones backup-db.mjs has always logged for stage=tunnel.
export class TunnelError extends Error {
  constructor(reason) { super(reason); this.name = 'TunnelError'; this.stage = 'tunnel'; this.reason = reason; }
}

const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const procAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitUntil(pred, ms) { for (let i = 0; i < ms / 100 && !pred(); i++) await sleep(100); return pred(); }

// The real CLI's ssh is its own group leader (also covers a ProxyCommand child); else only the pid.
const sigProc = (r, sig) => { try { process.kill(r.pgid === r.pid ? -r.pid : r.pid, sig); } catch { /* gone */ } };

export function checkPortFree(port) {
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

// opts: { railwayBin, service, railwayEnv, port, timeoutS, lockDir, cwd, env, myUid }
// railwayBin may be set later with setRailwayBin() (the backup resolves it after taking its lock).
export function createTunnel(opts) {
  const { service, railwayEnv, port, timeoutS, lockDir, cwd } = opts;
  const env = opts.env || process.env;
  const myUid = opts.myUid ?? process.getuid();
  let railwayBin = opts.railwayBin || '';
  let tunnel = null;       // { child, pid, ssh: [{pid, lstart}] }
  let killing = null;      // promise of the kill in progress, so a signal mid-kill waits for it
  let portStillHeld = false;

  // ssh processes we may signal for a tunnel on `port`: descendants of the railway pid (found
  // while railway is still their parent) plus the ones recorded earlier (same start time), all
  // ours (uid) and with the CLI's exact forward argv. Anything else is never returned.
  function sshTargets(rows, railwayPid, recorded, p) {
    if (!rows) return [];
    const ok = (r) => r && r.pid > 1 && r.pid !== process.pid && r.uid === myUid && isRailwaySshForward(r.args, p);
    const out = new Map();
    for (const r of descendantsOf(rows, railwayPid)) if (ok(r)) out.set(r.pid, r);
    for (const s of recorded || []) {
      const r = rows.find((x) => x.pid === s.pid);
      if (ok(r) && s.lstart && s.lstart === r.lstart) out.set(r.pid, r);
    }
    return [...out.values()];
  }

  // SIGTERM, wait up to 5 s, then SIGKILL anything that is still the same verified process.
  async function stopSsh(targets, p) {
    for (const r of targets) sigProc(r, 'SIGTERM');
    await waitUntil(() => !targets.some((r) => procAlive(r.pid)), 5000);
    const left = targets.filter((r) => procAlive(r.pid));
    if (!left.length) return;
    const rows = psSnapshot();
    for (const r of left) {
      const now = rows && rows.find((x) => x.pid === r.pid);
      if (now && now.lstart === r.lstart && now.uid === myUid && isRailwaySshForward(now.args, p)) sigProc(now, 'SIGKILL');
    }
    await waitUntil(() => !left.some((r) => procAlive(r.pid)), 2000);
  }

  async function waitPortFree(tries = 6) {
    for (let i = 0; i < tries; i++) { if (await checkPortFree(port)) return true; await sleep(500); }
    return false;
  }

  // An ssh forwarder on `port` whose railway parent is gone (PPID 1, or the verified railway of a
  // stale lock). reapDecision (pure, unit-tested) is the only gate; anything failing it is untouched.
  async function reapOrphans({ recordedRailwayPid = null, recorded = [], port: p = port } = {}) {
    const rows = psSnapshot();
    if (!rows) return 0;
    const lp = listenerPids(p);
    const targets = [];
    for (const pid of lp) {
      const row = rows.find((r) => r.pid === pid);
      const rec = recorded.find((x) => x.pid === pid);
      if (row && reapDecision({ row, myUid, port: p, listenerPids: lp, recordedRailwayPid, expectedLstart: rec?.lstart ?? null }).kill) targets.push(row);
    }
    if (targets.length) await stopSsh(targets, p);
    return targets.length;
  }

  function writeRecord() {
    if (!tunnel) return;
    try {
      fs.writeFileSync(path.join(lockDir, 'tunnel.json'),
        JSON.stringify({ railwayPid: tunnel.pid, port, railwayBin, ssh: tunnel.ssh.map(({ pid, lstart }) => ({ pid, lstart })) }),
        { mode: 0o600 });
    } catch { /* best effort */ }
  }

  async function doKill(t) {
    // 1. Find ssh NOW, while railway is still its parent.
    const targets = sshTargets(psSnapshot(), t.pid, t.ssh, port);
    // 2. ssh first, then railway by its own stop path (SIGINT), escalating on its group.
    for (const r of targets) sigProc(r, 'SIGTERM');
    try { process.kill(-t.pid, 'SIGINT'); } catch { /* already gone */ }
    if (!(await waitUntil(() => !groupAlive(t.pid), 2000))) {
      try { process.kill(-t.pid, 'SIGTERM'); } catch { /* gone */ }
      if (!(await waitUntil(() => !groupAlive(t.pid), 3000))) { try { process.kill(-t.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    await stopSsh(targets, port);
    // 3. The port must be free now; one orphan sweep, then it is a reported failure.
    let free = await waitPortFree();
    if (!free) { await reapOrphans(); free = await waitPortFree(4); }
    if (!free) portStillHeld = true;
  }

  function kill() {
    if (killing) return killing;
    if (!tunnel) return Promise.resolve();
    const t = tunnel;
    tunnel = null;
    killing = doKill(t);
    return killing;
  }

  // Last resort, synchronous (process 'exit' handler): ssh first, then railway's group.
  function killSync() {
    if (!tunnel) return;
    try { for (const r of sshTargets(psSnapshot(), tunnel.pid, tunnel.ssh, port)) sigProc(r, 'SIGKILL'); } catch { /* best effort */ }
    try { process.kill(-tunnel.pid, 'SIGKILL'); } catch { /* gone */ }
  }

  // A SIGKILLed run leaves its tunnel (railway in its own group, plus railway's ssh child in
  // another). tunnel.json in the lock dir records them. A later run kills railway's group only if
  // the recorded pid still runs exactly `<railwayBin> connect ... --tunnel-only -P <port>`, stops the
  // ssh children (descendants and recorded pids, verified), then sweeps orphaned ssh listeners.
  async function reapStale() {
    let rec = null;
    try { rec = parseTunnelRecord(fs.readFileSync(path.join(lockDir, 'tunnel.json'), 'utf8')); } catch { /* none */ }
    if (!rec) return false;
    let did = false;
    const rows = psSnapshot();
    const rw = rows && rows.find((r) => r.pid === rec.railwayPid);
    let verified = null;
    if (rw && rw.pid !== process.pid && rw.uid === myUid && isRailwayTunnelCmd(rw.args, rec.port, rec.railwayBin)) {
      verified = rw.pid;
      await stopSsh(sshTargets(rows, rw.pid, rec.ssh, rec.port), rec.port);
      const sig = (s) => { try { process.kill(rw.pgid === rw.pid ? -rw.pid : rw.pid, s); } catch { /* gone */ } };
      const dead = () => !(rw.pgid === rw.pid ? groupAlive(rw.pid) : procAlive(rw.pid));
      sig('SIGTERM');
      if (!(await waitUntil(dead, 5000))) sig('SIGKILL');
      did = true;
    }
    if ((await reapOrphans({ recordedRailwayPid: verified, recorded: rec.ssh, port: rec.port })) > 0) did = true;
    return did;
  }

  // Starts railway, waits for the URL and a reachable port, returns { user, password, database }.
  async function open() {
    const child = spawn(railwayBin, ['connect', service, '--tunnel-only', '-P', String(port), '-e', railwayEnv],
      { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let exited = false;
    let buf = '';
    const onData = (d) => { if (buf.length < BUF_CAP) buf += d; }; // keep draining after the cap
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', () => { exited = true; });
    const spawnErr = new Promise((r) => child.once('error', () => r(true)));
    if (!child.pid) { await spawnErr; throw new TunnelError('could not start railway CLI'); }
    tunnel = { child, pid: child.pid, ssh: [] };
    writeRecord();

    const deadline = Date.now() + timeoutS * 1000;
    let creds = null;
    while (Date.now() < deadline) {
      if (!creds && hasUrlToken(buf)) {
        try { creds = parseTunnelOutput(buf, port); } catch (e) {
          throw new TunnelError(e.name === 'TunnelParseError' ? e.message : 'could not parse tunnel output (output withheld)');
        }
        buf = ''; // drop the raw output
      }
      if (creds && (await canConnect(port))) {
        // The URL is printed only after ssh is ready: record it while railway is still its parent.
        tunnel.ssh = sshTargets(psSnapshot(), tunnel.pid, [], port).map((r) => ({ pid: r.pid, lstart: r.lstart }));
        writeRecord();
        return creds;
      }
      if (exited) throw new TunnelError('railway tunnel process exited early (output withheld)');
      await sleep(creds ? 500 : 200);
    }
    throw new TunnelError(creds ? 'tunnel port never became reachable' : `no tunnel details within ${timeoutS}s (output withheld)`);
  }

  return {
    open, kill, killSync, reapStale, reapOrphans,
    portFree: () => checkPortFree(port),
    waitPortFree,
    setRailwayBin(b) { railwayBin = b; },
    get portStillHeld() { return portStillHeld; },
    get pid() { return tunnel ? tunnel.pid : null; },
    get active() { return tunnel !== null; },
  };
}
