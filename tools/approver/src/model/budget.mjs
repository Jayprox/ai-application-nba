// Spend ledger, single-flight lock and circuit breaker (story 11). All state is small files in the log dir
// that can be deleted safely.
import fs from 'node:fs';
import path from 'node:path';

export const utcDate = (now) => new Date(now).toISOString().slice(0, 10);
const ledgerFile = (logDir, now) => path.join(logDir, `spend-${utcDate(now)}.jsonl`);

export function dailySpend(logDir, now) {
  try {
    return fs.readFileSync(ledgerFile(logDir, now), 'utf8').split('\n').filter(Boolean).reduce((sum, l) => {
      try { const c = JSON.parse(l).cost_usd; return sum + (Number.isFinite(c) ? c : 0); } catch { return sum; }
    }, 0);
  } catch { return 0; }
}

export function addSpend(logDir, now, cost, recordId) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(ledgerFile(logDir, now), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try { fs.writeSync(fd, JSON.stringify({ ts: new Date(now).toISOString(), cost_usd: cost, record_id: recordId }) + '\n'); } finally { fs.closeSync(fd); }
}

const lockFile = (logDir) => path.join(logDir, 'model.lock');

// One model call at a time bounds concurrent spend. A lock older than staleMs is a crashed worker.
export function acquireLock(logDir, now, staleMs = 30000) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile(logDir), 'wx', 0o600);
      fs.writeSync(fd, String(now)); fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        if (now - fs.statSync(lockFile(logDir)).mtimeMs > staleMs) fs.rmSync(lockFile(logDir), { force: true }); else return false;
      } catch { /* raced with a release: try again */ }
    }
  }
  return false;
}

export function releaseLock(logDir) { try { fs.rmSync(lockFile(logDir), { force: true }); } catch { /* ignore */ } }

const breakerFile = (logDir) => path.join(logDir, 'breaker.json');
function readBreaker(logDir) {
  try { const j = JSON.parse(fs.readFileSync(breakerFile(logDir), 'utf8')); return { failures: Number(j.failures) || 0, open_until: Number(j.open_until) || 0 }; } catch { return { failures: 0, open_until: 0 }; }
}
function writeBreaker(logDir, b) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(breakerFile(logDir), JSON.stringify(b), { mode: 0o600 });
}

export function breakerOpen(logDir, now) {
  const b = readBreaker(logDir);
  if (b.open_until > now) return true;
  if (b.open_until && b.open_until <= now) writeBreaker(logDir, { failures: 0, open_until: 0 }); // cool-down over: close
  return false;
}

export function recordOutcome(logDir, now, ok, { failures = 3, cooldown_ms = 600000 } = {}) {
  const b = readBreaker(logDir);
  if (ok) { if (b.failures || b.open_until) writeBreaker(logDir, { failures: 0, open_until: 0 }); return; }
  b.failures += 1;
  if (b.failures >= failures) { b.open_until = now + cooldown_ms; b.failures = 0; }
  writeBreaker(logDir, b);
}
