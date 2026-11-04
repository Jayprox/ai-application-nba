// Decision log: one JSON line per call, one atomic O_APPEND write (<= 8 KiB). Redaction runs on every
// string field before anything is written (story 7.3). Failures are swallowed by the caller.
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

export const LOG_FILE = 'decisions.jsonl';
export const MAX_RECORD_BYTES = 8192;
export const MAX_INPUT_CHARS = 2048;
const MAX_FIELD_CHARS = 500;
export const REDACT_INPUT_CAP = 4096;
const MAX_SHORT_CHARS = 300;
// Fields that are identifiers or hashes and must stay byte-exact for matching.
const EXACT_KEYS = new Set(['input_hash', 'record_id', 'session_id', 'ts', 'type']);
const SHORT_KEYS = new Set(['reason', 'error', 'model_reason']);

const NAME_RE = '(?:[A-Za-z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]{0,40}|DATABASE_[A-Za-z0-9_]{1,40})';
// Every pattern is linear: bounded repeats, no nested quantifiers, and redact() works on a capped slice.
// `sk-` also occurs inside words (task-list), so it needs 16+ key characters that include a digit or capital
const KEYPREFIX = '(?:sk[-_](?=[A-Za-z0-9_-]{15,}$|(?=[A-Za-z0-9_-]{0,60}[0-9A-Z])[A-Za-z0-9_-]{15,})|ghp_|gho_|ghs_|ghu_|github_pat_|xox[a-z]-|AKIA)';
const PATTERNS = [
  [/(Authorization\s*[:=]\s*)(?:Bearer\s+|Basic\s+|Token\s+)?[^\s"']+/gi, '$1[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]'],
  [/([a-z][a-z0-9+.-]{0,30}:\/\/)[^\/\s:@]{1,100}:[^@\s\/]{0,100}@/gi, '$1[REDACTED]@'],
  [new RegExp(`\\b(${NAME_RE})(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s;&|]+)`, 'gi'), '$1$2[REDACTED]'],
  [new RegExp(`("${NAME_RE}"\\s*:\\s*)"[^"]*"`, 'gi'), '$1"[REDACTED]"'],
  [/(--?(?:password|passwd|token|secret|api[-_]?key)[= ]+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]'],
  // key prefixes anywhere (also glued to preceding text), plus following words that still look like key material
  [new RegExp(`${KEYPREFIX}[A-Za-z0-9_-]+(?:\\s+(?=[A-Za-z0-9_-]{0,40}[0-9A-Z])[A-Za-z0-9_-]{8,})*`, 'g'), '[REDACTED]'],
  [/(?<![A-Fa-f0-9])[A-Fa-f0-9]{32,}(?![A-Fa-f0-9])/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9+\/_-])[A-Za-z0-9+\/]{40,}={0,2}(?![A-Za-z0-9+\/_-])/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? '[REDACTED]' : m)],
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? '[REDACTED]' : m)],
];

export function redact(s) {
  if (typeof s !== 'string') return s;
  // bounded work: anything past the cap is dropped before the patterns run (it would be truncated anyway)
  let out = s.length > REDACT_INPUT_CAP ? s.slice(0, REDACT_INPUT_CAP) + '...[cut]' : s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function cap(s, n) { return s.length > n ? [s.slice(0, n) + '...[truncated]', true] : [s, false]; }

// What the log (and the model) may know about a request. File contents are never included, only sizes.
export function summarizeInput(tool, input) {
  const str = (v) => (typeof v === 'string' ? v : '[not a string]');
  const len = (v) => (typeof v === 'string' ? v.length : 0);
  switch (tool) {
    case 'Bash': return str(input?.command);
    case 'Write': return `Write ${str(input?.file_path)} (content ${len(input?.content)} chars)`;
    case 'Edit': return `Edit ${str(input?.file_path)} (old ${len(input?.old_string)}, new ${len(input?.new_string)} chars)`;
    case 'NotebookEdit': return `NotebookEdit ${str(input?.notebook_path)} (source ${len(input?.new_source)} chars)`;
    default: return `${tool} (input not logged)`;
  }
}

// What the model is shown: the command, or just the file path. Never content.
export function modelTarget(tool, input) {
  if (tool === 'Bash') return typeof input?.command === 'string' ? input.command : '[not a string]';
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === 'string' ? p : '[not a string]';
}

export function prepareRecord(record) {
  const r = { ...record };
  let truncated = !!r.truncated;
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== 'string' || EXACT_KEYS.has(k)) continue;
    const limit = k === 'input_redacted' ? MAX_INPUT_CHARS : SHORT_KEYS.has(k) ? MAX_SHORT_CHARS : MAX_FIELD_CHARS;
    // redact first on the full text so a secret cut in half by the cap cannot survive
    const [c, t] = cap(redact(v), limit);
    r[k] = c;
    if (t && k === 'input_redacted') truncated = true;
  }
  r.truncated = truncated;
  let line = JSON.stringify(r);
  if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) {
    r.input_redacted = typeof r.input_redacted === 'string' ? r.input_redacted.slice(0, 512) + '...[truncated]' : r.input_redacted;
    r.truncated = true;
    line = JSON.stringify(r);
    if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) {
      r.input_redacted = null; r.cwd = null; r.transcript_path = null;
      line = JSON.stringify(r);
    }
  }
  return line + '\n';
}

export function appendRecord(logDir, record) {
  const line = prepareRecord(record);
  const created = fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  if (created) fs.chmodSync(logDir, 0o700);
  const fd = fs.openSync(path.join(logDir, LOG_FILE), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, line);
  } finally { fs.closeSync(fd); }
}

// Owner-run rotation (story 7.6): keep records newer than `days`, drop old daily spend ledgers.
export function rotate(logDir, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 86400000;
  const file = path.join(logDir, LOG_FILE);
  let kept = 0; let dropped = 0;
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    for (const l of lines) {
      let ts = NaN;
      try { ts = Date.parse(JSON.parse(l).ts); } catch { /* unparsable line: keep it, a human should look */ }
      if (Number.isNaN(ts) || ts >= cutoff) keep.push(l); else dropped++;
    }
    kept = keep.length;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  let ledgers = 0;
  for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
    const m = /^spend-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && Date.parse(m[1] + 'T00:00:00Z') < cutoff) { fs.rmSync(path.join(logDir, f)); ledgers++; }
  }
  return { kept, dropped, ledgers };
}
