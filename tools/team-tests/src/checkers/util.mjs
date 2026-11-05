// Shared helpers for the mechanical checkers. Read-only access to the fixture repo.
// Everything the agent controls (the fixture's .git/config, hooks, files) is treated as hostile:
// git runs with hooks, fsmonitor, pager and external diff disabled, symlinks are never followed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export class CheckerInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CheckerInputError';
  }
}
export const need = (cond, code) => { if (!cond) throw new CheckerInputError(code); };

export const MANIFESTS = Object.freeze(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
export const isDocs = (p) => p.startsWith('docs/');
export const isTestFile = (p) => /^test\/.+\.(js|mjs|cjs)$/.test(p) || /\.test\.(js|mjs|cjs)$/.test(p);
const MAX_FILE = 8 * 1024 * 1024;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function fixtureDirOf(run) {
  need(run && typeof run.fixtureDir === 'string' && path.isAbsolute(run.fixtureDir), 'fixtureDir missing');
  need(fs.existsSync(run.fixtureDir) && fs.statSync(run.fixtureDir).isDirectory(), 'fixtureDir not found');
  return run.fixtureDir;
}

const HARDEN = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'protocol.allow=never', '--no-optional-locks'];

/** Runs git in `dir` with an argument array and a minimal env. Throws CheckerInputError on failure. */
export function gitRun(dir, args, { allowFail = false } = {}) {
  const r = spawnSync('git', [...HARDEN, '-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 60000,
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || r.status !== 0) {
    if (allowFail) return null;
    throw new CheckerInputError(`git ${args[0]} failed`);
  }
  return r.stdout;
}
export const git = (run, args, o) => gitRun(fixtureDirOf(run), args, o);

// A per-evaluation memo for the repeated read-only git queries. Active only inside withMemo(),
// so a later evaluation of a changed repo never sees stale data.
let memo = null;
export function withMemo(fn) {
  const outer = memo;
  memo = outer ?? new Map();
  try { return fn(); } finally { memo = outer; }
}
const memoised = (key, fn) => {
  if (!memo) return fn();
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};

export function baseShaOf(run) {
  need(typeof run.baseSha === 'string' && /^[0-9a-f]{40}$/.test(run.baseSha), 'baseSha missing');
  return run.baseSha;
}

export function branches(run) {
  return memoised('branches', () => {
    const out = git(run, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  });
}
export const tip = (run, branch) => memoised(`tip:${branch}`, () => git(run, ['rev-parse', '--verify', `refs/heads/${branch}`]).trim());

/** The ref holding the team's final work: the first fix/* branch, else the only other branch, else HEAD. */
export function finalRef(run) {
  const bs = branches(run);
  const fix = bs.find((b) => b.startsWith('fix/'));
  if (fix) return `refs/heads/${fix}`;
  const others = bs.filter((b) => b !== 'main');
  if (others.length === 1) return `refs/heads/${others[0]}`;
  return 'HEAD';
}

/** Files changed relative to the initial commit: every branch tip, the work tree and untracked files. */
export function changedFiles(run) {
  return memoised('changed', () => changedFilesUncached(run));
}
function changedFilesUncached(run) {
  const base = baseShaOf(run);
  const set = new Set();
  const add = (out) => out.split('\n').filter(Boolean).forEach((p) => set.add(p));
  for (const b of branches(run)) add(git(run, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', base, `refs/heads/${b}`, '--']));
  add(git(run, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--']));
  add(git(run, ['ls-files', '--others', '--exclude-standard']));
  return [...set].sort();
}

/** Changed files on one ref relative to the initial commit. */
export function changedOn(run, ref) {
  return git(run, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', baseShaOf(run), ref, '--']).split('\n').filter(Boolean).sort();
}

/** Walks regular files under `root` (never follows symlinks, skips .git). Returns relative paths. */
export function walkFiles(root, skipTop = ['.git']) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && skipTop.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

export function readRegular(root, rel) {
  const p = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (!st.isFile() || st.size > MAX_FILE) return null;
  return fs.readFileSync(p);
}

/**
 * Text files under the given path prefixes ('docs/' or an exact file like 'CLAUDE.md'): the union of
 * every branch tip's tree and the work tree (work tree wins on the same path). Map path -> text.
 */
export function textFiles(run, prefixes) {
  return memoised(`text:${prefixes.join('|')}`, () => textFilesUncached(run, prefixes));
}
function textFilesUncached(run, prefixes) {
  const dir = fixtureDirOf(run);
  const want = (p) => prefixes.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
  const files = new Map();
  for (const b of branches(run)) {
    const names = git(run, ['ls-tree', '-r', '-z', '--name-only', `refs/heads/${b}`, '--']).split('\0').filter(Boolean).filter(want);
    for (const n of names) {
      const t = git(run, ['show', `refs/heads/${b}:${n}`], { allowFail: true });
      if (t !== null) files.set(n, t);
    }
  }
  for (const rel of walkFiles(dir)) {
    if (!want(rel)) continue;
    const b = readRegular(dir, rel);
    if (b) files.set(rel, b.toString('utf8'));
  }
  return files;
}

/** One file at a ref, or null. */
export function showAt(run, ref, rel) {
  return git(run, ['show', `${ref}:${rel}`], { allowFail: true });
}

export const nonKeep = (files) => [...files.entries()].filter(([p]) => path.basename(p) !== '.gitkeep');
