#!/usr/bin/env node
// Owner-run rollback. Prints the hook entry to remove from your settings (it never edits settings), clears the
// immutable flag, deletes the install dir. The decision log is kept unless --delete-logs.
//   node uninstall.mjs [--delete-logs] [--install-dir <dir>]
// Removing the hook entry alone already returns Claude Code to normal prompts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstall } from '../src/config.mjs';
import { ask, requireTTY, bothTTY, walk, defaultChflags, relaxPerms } from './_lib.mjs';
import { hookConfig } from './install.mjs';

export async function uninstall({ installDir, deleteLogs = false, isTTY = bothTTY(), readLine = ask, chflags = defaultChflags }) {
  requireTTY(isTTY, 'uninstall');
  const inst = loadInstall(installDir);
  if (!inst.ok) throw new Error(`nothing to uninstall at ${installDir} (${inst.error})`);
  const i = inst.install;
  const entry = JSON.stringify(hookConfig(i.node_path, i.install_dir).hooks.PermissionRequest[0], null, 2);
  const typed = await readLine(`This deletes ${installDir}${deleteLogs ? ' and the decision log' : ' (the decision log is kept)'}. Type UNINSTALL to continue: `);
  if (String(typed).trim() !== 'UNINSTALL') return { removed: false, text: 'Confirmation did not match. Nothing removed.\n' };
  const paths = [installDir, ...walk(installDir).map((e) => e.path)];
  try { chflags('nouchg', paths); } catch { /* not macOS or already clear */ }
  relaxPerms(installDir);
  fs.rmSync(installDir, { recursive: true, force: true });
  if (deleteLogs) fs.rmSync(i.log_dir, { recursive: true, force: true });
  return {
    removed: true,
    text: `Removed ${installDir}${deleteLogs ? ' and the log' : `. The log is kept at ${i.log_dir}`}.\nNow remove this entry from the "PermissionRequest" list in ~/.claude/settings.json (and any deny rules you added for the two folders):\n${entry}\n`,
  };
}

if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const args = process.argv.slice(2); const k = args.indexOf('--install-dir');
  const dir = k >= 0 ? args[k + 1] : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  uninstall({ installDir: dir, deleteLogs: args.includes('--delete-logs') })
    .then((r) => process.stdout.write(r.text))
    .catch((e) => { console.error('uninstall: ' + e.message); process.exit(e.code === 'NO_TTY' ? 2 : 1); });
}
