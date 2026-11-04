#!/usr/bin/env node
// Owner-run: switch shadow | enforce-deny | enforce. Needs a terminal and a typed confirmation, so an agent's
// shell (no TTY) cannot use it. Nothing in the approver switches the mode by itself. Setting `shadow` is the kill switch.
//   node mode.mjs <shadow|enforce-deny|enforce> [--install-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, readMode } from '../src/config.mjs';
import { ask, requireTTY, bothTTY } from './_lib.mjs';

export async function setMode({ installDir, mode, isTTY = bothTTY(), readLine = ask }) {
  requireTTY(isTTY, 'mode');
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const file = path.join(installDir, 'mode');
  const before = readMode(installDir);
  const typed = await readLine(`Current mode: ${before}. To switch to "${mode}" type the new mode name and press Enter: `);
  if (String(typed).trim() !== mode) return { changed: false, before, after: before, text: 'Confirmation did not match. Mode unchanged.\n' };
  fs.writeFileSync(file, mode + '\n'); // in place: the install dir is locked against new files, the mode file is not
  return { changed: before !== mode, before, after: mode, text: `Mode: ${before} -> ${mode}. The next request uses it.\n` };
}

if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const args = process.argv.slice(2); const k = args.indexOf('--install-dir');
  const dir = k >= 0 ? args[k + 1] : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  setMode({ installDir: dir, mode: args.find((a) => !a.startsWith('--') && a !== (k >= 0 ? args[k + 1] : null)) })
    .then((r) => process.stdout.write(r.text))
    .catch((e) => { console.error('mode: ' + e.message); process.exit(e.code === 'NO_TTY' ? 2 : 1); });
}
