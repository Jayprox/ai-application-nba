// Decision log: one JSON line per call, one atomic O_APPEND write. Failures are swallowed by the caller.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_FILE = 'decisions.jsonl';

export function appendRecord(logDir, record) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify(record) + '\n';
  const fd = fs.openSync(path.join(logDir, LOG_FILE), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
}
