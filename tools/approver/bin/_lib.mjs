// Shared helpers for the owner-run scripts (install, uninstall, mode, verify). Not used by the hook.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

export const FLAGS_BIN = '/usr/bin/chflags';

// user-immutable flag via /usr/bin/chflags (macOS, no sudo). Injected in tests; a no-op elsewhere.
export function defaultChflags(flag, paths) {
  if (process.platform !== 'darwin') return { skipped: true };
  for (let i = 0; i < paths.length; i += 100) execFileSync(FLAGS_BIN, [flag, ...paths.slice(i, i + 100)], { stdio: 'ignore' });
  return { skipped: false };
}

export function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push({ path: p, dir: e.isDirectory() });
    if (e.isDirectory()) walk(p, out);
  }
  return out;
}

export function copyTree(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (!filter(s, e)) continue;
    if (e.isDirectory()) copyTree(s, d, filter); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

export function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

export function requireTTY(isTTY, what) {
  if (!isTTY) {
    const err = new Error(`${what} needs an interactive terminal (a TTY) and a typed confirmation. It refuses to run from a script, a pipe or an agent shell.`);
    err.code = 'NO_TTY';
    throw err;
  }
}

export function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (a) => { rl.close(); resolve(a); });
    rl.on('close', () => resolve(''));
  });
}

export const bothTTY = () => !!(process.stdin.isTTY && process.stdout.isTTY);

export function relaxPerms(dir) {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o755);
  for (const e of walk(dir)) fs.chmodSync(e.path, e.dir ? 0o755 : 0o644);
}
