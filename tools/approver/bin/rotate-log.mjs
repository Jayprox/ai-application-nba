#!/usr/bin/env node
// Owner-run: drop decision records older than --days (default 90). Usage:
//   node rotate-log.mjs [--days 90] [--log-dir <dir>] [--install-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { rotate } from '../src/log.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let logDir = opt('--log-dir');
if (!logDir) {
  try { logDir = JSON.parse(fs.readFileSync(path.join(opt('--install-dir', here), 'install.json'), 'utf8')).log_dir; } catch { /* fall through */ }
}
logDir ||= path.join(os.homedir(), 'Library', 'Logs', 'claude-approver');
const days = Number(opt('--days', '90'));
if (!Number.isFinite(days) || days < 1) { console.error('--days must be a number >= 1'); process.exit(2); }
const r = rotate(logDir, { days });
console.log(`rotate-log: ${logDir}: kept ${r.kept} record(s), dropped ${r.dropped}, removed ${r.ledgers} old spend ledger(s)`);
