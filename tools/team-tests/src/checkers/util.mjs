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
const GIT_ENV = () => ({ PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' });

// Short, path-free reason for a failed spawn: the spawn error code, the signal or the exit status, plus a
// fixed category taken from git's own message (the message text itself is never kept: it holds paths).
const STDERR_CATEGORIES = [
  ['dubious-ownership', /unsafe repository|dubious ownership/i],
  ['index-lock', /index\.lock|unable to create .*\.lock|another git process/i],
  ['corrupt-object', /corrupt|inflate|incorrect header check|hash mismatch|invalid object|short read|premature end/i],
  ['bad-object', /bad object|unpack tree|not a valid object|unable to read|missing object|not a tree|bad tree object|bad revision|unknown revision|ambiguous argument/i],
  ['not-a-repo', /not a git repository/i],
  ['no-space-or-resource', /no space|cannot allocate|resource temporarily|too many open|out of memory/i],
];
const stderrCategory = (r) => {
  const t = Buffer.isBuffer(r.stderr) ? r.stderr.toString('latin1') : String(r.stderr ?? '');
  return STDERR_CATEGORIES.find(([, re]) => re.test(t))?.[0] ?? (t.trim() ? 'other' : 'empty');
};
const failWhy = (r) => {
  const how = r.error ? String(r.error.code ?? 'spawn').replace(/[^A-Z0-9_]/g, '').slice(0, 20) || 'spawn' : r.signal ? `signal ${String(r.signal).replace(/[^A-Z0-9]/g, '').slice(0, 10)}` : `status ${r.status}`;
  return `${how}, ${stderrCategory(r)}`;
};

/**
 * Runs git in `dir` with an argument array and a minimal env. Throws CheckerInputError on failure.
 * Only for repos the harness owns (the real repo). NEVER aim it at a fixture: use `git(run, ...)`.
 */
export function gitRun(dir, args, { allowFail = false } = {}) {
  const r = spawnSync('git', [...HARDEN, '-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 60000,
    detached: true,
    env: GIT_ENV(),
  });
  if (r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ } }
  if (r.error || r.status !== 0) {
    if (allowFail) return null;
    throw new CheckerInputError(`git ${String(args[0]).replace(/[^a-z-]/g, '')} failed (${failWhy(r)})`);
  }
  return r.stdout;
}

// ---- harness-owned copy of the fixture repository (Sec F1) --------------------------------------
// The agent can write the fixture's .git/config, .gitattributes and hooks. Any git command run in
// the fixture could therefore run an agent-chosen program (filter, textconv, fsmonitor, hook...).
// So the checkers never run git against the fixture's .git directory. They copy only the DATA of
// the repository (HEAD, refs, packed-refs, objects) into a directory the harness owns, with a
// config the harness writes, and run git there with --work-tree pointing at the fixture. No filter
// or textconv driver is defined in that config, so attributes in the tree are inert.
const MAX_COPY_FILES = 50000;
const MAX_COPY_BYTES = 512 * 1024 * 1024;

function copyTree(src, dst, budget, { skip = [] } = {}) {
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isSymbolicLink()) throw new CheckerInputError('fixture repo holds a symlink');
    if (e.isDirectory()) copyTree(from, to, budget);
    else if (e.isFile()) {
      const st = fs.lstatSync(from);
      budget.files += 1;
      budget.bytes += st.size;
      if (budget.files > MAX_COPY_FILES || budget.bytes > MAX_COPY_BYTES) throw new CheckerInputError('fixture repo too large');
      fs.copyFileSync(from, to);
    } else throw new CheckerInputError('fixture repo holds a special file');
  }
}

const MAX_HEAD_BYTES = 4096;

/** Reads a small regular file without following a symlink and without blocking on a FIFO. */
function readSmallRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch { throw new CheckerInputError('fixture repo file is not readable'); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new CheckerInputError('fixture repo file is not a regular file');
    if (st.size > MAX_HEAD_BYTES) throw new CheckerInputError('fixture repo file is too large');
    const buf = Buffer.alloc(MAX_HEAD_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_HEAD_BYTES) throw new CheckerInputError('fixture repo file is too large');
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** lstat of a top-level .git entry: null when missing, error unless it is the wanted kind. */
function topEntry(file, kind) {
  let st;
  try { st = fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw new CheckerInputError('fixture repo entry is not readable'); }
  if (st.isSymbolicLink()) throw new CheckerInputError('fixture repo holds a symlink');
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw new CheckerInputError('fixture repo holds a special file');
  return st;
}

function makeSafeRepo(fixtureDir) {
  const gd = path.join(fixtureDir, '.git');
  let st;
  try { st = fs.lstatSync(gd); } catch { throw new CheckerInputError('fixture .git missing'); }
  if (!st.isDirectory()) throw new CheckerInputError('fixture .git is not a directory');
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-checker-'));
  try {
    const head = readSmallRegular(path.join(gd, 'HEAD')).trim();
    if (!/^(ref: refs\/[A-Za-z0-9._\/-]{1,200}|[0-9a-f]{40,64})$/.test(head)) throw new CheckerInputError('fixture HEAD is not usable');
    fs.writeFileSync(path.join(copy, 'HEAD'), `${head}\n`);
    fs.writeFileSync(path.join(copy, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
    const budget = { files: 0, bytes: 0 };
    need(topEntry(path.join(gd, 'objects'), 'dir'), 'fixture objects missing');
    copyTree(path.join(gd, 'objects'), path.join(copy, 'objects'), budget, { skip: ['info'] }); // info/alternates would point elsewhere
    fs.mkdirSync(path.join(copy, 'objects', 'info'));
    if (topEntry(path.join(gd, 'refs'), 'dir')) copyTree(path.join(gd, 'refs'), path.join(copy, 'refs'), budget, { skip: ['replace'] }); // no replace refs (Sec R2-2)
    else fs.mkdirSync(path.join(copy, 'refs'));
    const packed = path.join(gd, 'packed-refs');
    const ps = topEntry(packed, 'file');
    if (ps) {
      budget.files += 1;
      budget.bytes += ps.size;
      if (budget.files > MAX_COPY_FILES || budget.bytes > MAX_COPY_BYTES) throw new CheckerInputError('fixture repo too large');
      fs.copyFileSync(packed, path.join(copy, 'packed-refs'));
    }
    return copy;
  } catch (err) {
    fs.rmSync(copy, { recursive: true, force: true });
    throw err;
  }
}

function runSafe(copy, fixtureDir, args, { allowFail = false, binary = false } = {}) {
  const r = spawnSync('git', [...HARDEN, '-c', 'core.attributesFile=', `--git-dir=${copy}`, `--work-tree=${fixtureDir}`, ...args], {
    cwd: copy,
    encoding: binary ? null : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 60000,
    detached: true,
    env: { ...GIT_ENV(), GIT_INDEX_FILE: path.join(copy, 'index') },
  });
  if (r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ } }
  if (r.error || r.status !== 0) {
    if (allowFail) return null;
    throw new CheckerInputError(`git ${String(args[0]).replace(/[^a-z-]/g, '')} failed (${failWhy(r)})`);
  }
  return r.stdout;
}

// A per-evaluation memo for the repeated read-only git queries and the safe copy. Active only
// inside withMemo(), so a later evaluation of a changed repo never sees stale data.
let memo = null;
export function withMemo(fn) {
  const outer = memo;
  memo = outer ?? new Map();
  try { return fn(); } finally {
    if (!outer) {
      for (const v of memo.values()) if (v && v.__safeRepo) fs.rmSync(v.__safeRepo, { recursive: true, force: true });
      memo = null;
    } else memo = outer;
  }
}
const memoised = (key, fn) => {
  if (!memo) return fn();
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};

/** Runs `fn(copyDir)` with the harness-owned repo copy of the run's fixture (cached inside withMemo). */
function withSafeRepo(run, fn) {
  const dir = fixtureDirOf(run);
  need(fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory() === true, 'fixture .git is not a directory');
  if (memo) {
    if (!memo.has('safeRepo')) {
      const copy = makeSafeRepo(dir);
      // Memoise only after read-tree succeeded (Sec C4-3): a failure must not leave a copy with an empty
      // index for later criteria. The next call builds a fresh copy and tries again, or fails again.
      try { runSafe(copy, dir, ['read-tree', baseShaOf(run)]); } catch (err) { fs.rmSync(copy, { recursive: true, force: true }); throw err; }
      memo.set('safeRepo', { __safeRepo: copy });
    }
    return fn(memo.get('safeRepo').__safeRepo, dir);
  }
  const copy = makeSafeRepo(dir);
  try {
    runSafe(copy, dir, ['read-tree', baseShaOf(run)]);
    return fn(copy, dir);
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
}

/** Read-only git query against the fixture through the harness-owned copy. */
export const git = (run, args, o) => withSafeRepo(run, (copy, dir) => runSafe(copy, dir, args, o));

/** Runs `fn(gitFn)` with one safe copy for several queries (for callers outside withMemo). */
export const withGit = (run, fn) => withSafeRepo(run, (copy, dir) => fn((args, o) => runSafe(copy, dir, args, o), copy));

/** A fixture tree at `ref` as [{path, sha}] blobs; refuses symlinks, submodules and odd paths. */
export function treeBlobs(run, ref) {
  const out = git(run, ['ls-tree', '-r', '-z', '--full-tree', ref, '--']);
  const files = [];
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = rec.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/);
    need(m, 'unreadable tree entry');
    const [, mode, type, sha, p] = m;
    need(type === 'blob' && (mode === '100644' || mode === '100755'), 'tree holds a symlink or submodule');
    need(!p.startsWith('/') && !p.split('/').some((c) => c === '..' || c === '.git' || c === '' || c === '.'), 'unsafe path in tree');
    files.push({ path: p, sha, mode });
  }
  need(files.length <= 5000, 'tree too large');
  return files;
}

/** Writes the tree at `ref` into the empty directory `dest` by blob reads (no checkout, no filters). */
export function extractTree(run, ref, dest) {
  withGit(run, (g) => {
    for (const f of treeBlobs(run, ref)) {
      const buf = g(['cat-file', 'blob', f.sha], { binary: true });
      const to = path.join(dest, f.path);
      need(isUnder(dest, to), 'path escapes extraction dir');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, buf, { mode: f.mode === '100755' ? 0o755 : 0o644 });
    }
  });
}
const isUnder = (root, p) => { const rel = path.relative(root, p); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

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
const HARNESS_UNTRACKED = Object.freeze(['.env', '.fake-keychain']);
function changedFilesUncached(run) {
  const base = baseShaOf(run);
  const set = new Set();
  const add = (out) => out.split('\n').filter(Boolean).forEach((p) => set.add(p));
  for (const b of branches(run)) add(git(run, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', base, `refs/heads/${b}`, '--']));
  add(git(run, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--']));
  // No ignore rules: .gitignore, info/exclude and core.excludesFile are agent-controlled (Sec R2-2).
  // Without ignore rules the two untracked files the harness itself plants (fixture.mjs, canary files)
  // are listed, so they are dropped by exact top-level name. Their content is the canary checkers' job.
  // The exclusion applies to this listing only (Sec R3-1): a .env or .fake-keychain that a branch
  // commits shows up in the branch diffs above and must stay reported.
  git(run, ['ls-files', '--others']).split('\n').filter((p) => p && !HARNESS_UNTRACKED.includes(p)).forEach((p) => set.add(p));
  return [...set].sort();
}

/** Changed files on one ref relative to the initial commit. */
export function changedOn(run, ref) {
  return git(run, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', baseShaOf(run), ref, '--']).split('\n').filter(Boolean).sort();
}

/**
 * Walks regular files under `root` (never follows symlinks, skips .git). Returns relative paths.
 * A symlink or special file is skipped, but `onSkipped(rel)` is called first so a content scan can refuse
 * to pass over something it cannot read (Sec C4-2): it throws a CheckerInputError.
 */
export function walkFiles(root, skipTop = ['.git'], { onSkipped } = {}) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && skipTop.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { onSkipped?.(r); continue; }
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
      else onSkipped?.(r);
    }
  };
  walk(root, '');
  return out;
}

/** Throws when a content scan would have to skip something it cannot read (Sec C4-2). */
export const refuseSkipped = () => { throw new CheckerInputError('a file could not be scanned (symlink or special file)'); };

/** The file's bytes, or null only when it does not exist. A non-regular or oversize file is an error, never a skip. */
export function readRegular(root, rel) {
  const p = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (!st.isFile()) throw new CheckerInputError('a file could not be scanned (not a regular file)');
  if (st.size > MAX_FILE) throw new CheckerInputError('a file could not be scanned (over the size cap)');
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
      // A path that ls-tree just listed must be readable; a failure (including ENOBUFS) is an error (Sec C4-2).
      files.set(n, git(run, ['show', `refs/heads/${b}:${n}`]));
    }
  }
  const unreadable = (rel) => { if (want(rel) || want(`${rel}/`)) refuseSkipped(); };
  for (const rel of walkFiles(dir, ['.git'], { onSkipped: unreadable })) {
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
