// Path resolution, scope check, branch lookup. Pure fs reads, no process spawned.
import fs from 'node:fs';
import path from 'node:path';

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Resolve like the kernel would: symlinks followed component by component, '..' applied to the
// real directory. A path that does not exist yet keeps its existing real prefix and the rest is
// appended. A '..' after the first missing component cannot be resolved safely: not ok.
export function realResolve(input, base) {
  if (typeof input !== 'string' || input === '' || input.includes('\0')) return { ok: false, error: 'bad_path' };
  let queue;
  if (path.isAbsolute(input)) queue = input.split('/');
  else {
    if (typeof base !== 'string' || !path.isAbsolute(base)) return { ok: false, error: 'bad_base' };
    queue = [...base.split('/'), ...input.split('/')];
  }
  let cur = '/';
  let exists = true;
  let links = 0;
  while (queue.length) {
    const c = queue.shift();
    if (c === '' || c === '.') continue;
    if (c === '..') {
      if (!exists) return { ok: false, error: 'dotdot_after_missing' };
      cur = path.dirname(cur);
      continue;
    }
    const next = cur === '/' ? '/' + c : cur + '/' + c;
    if (!exists) { cur = next; continue; }
    let st;
    try { st = fs.lstatSync(next); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { exists = false; cur = next; continue; }
      return { ok: false, error: e.code || 'stat_failed' };
    }
    if (st.isSymbolicLink()) {
      if (++links > 40) return { ok: false, error: 'symlink_loop' };
      let t;
      try { t = fs.readlinkSync(next); } catch { return { ok: false, error: 'readlink_failed' }; }
      if (t.startsWith('/')) cur = '/';
      queue.unshift(...t.split('/'));
      continue;
    }
    cur = next;
  }
  return { ok: true, real: cur, exists };
}

// Scope (Q9): the session cwd, with symlinks resolved, is the repo root or below it.
export function inScope(cwd, repoRootReal) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const r = realResolve(cwd);
  return r.ok && r.exists && isInside(r.real, repoRootReal);
}

// Branch from .git/HEAD, no git process. null = unknown (detached, missing, .git is a file...).
export function readBranch(repoRoot) {
  try {
    const gitDir = path.join(repoRoot, '.git');
    if (!fs.lstatSync(gitDir).isDirectory()) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
    const m = /^ref: refs\/heads\/([^\n\r]{1,200})\n?$/.exec(head);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Classification: protected (self-protection), secret, ask-list. All comparisons are case-insensitive
// because the owner's volume is case-insensitive (macOS default).

const lc = (s) => s.toLowerCase();
const insideCI = (child, parent) => isInside(lc(child), lc(parent));

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

export function matchGlobs(rel, globs) {
  const key = globs;
  if (!matchGlobs.cache) matchGlobs.cache = new WeakMap();
  let res = matchGlobs.cache.get(key);
  if (!res) { res = globs.map(globToRegExp); matchGlobs.cache.set(key, res); }
  return res.some((r) => r.test(rel));
}

// Per-request context for path judgements, built once from the install record and the home dir.
export function buildPathCtx(ctx) {
  if (ctx._pc) return ctx._pc;
  const rr = (p) => { const r = realResolve(p); return r.ok ? r.real : p; };
  const uniq = (a) => [...new Set(a)];
  const roots = uniq([ctx.installDir, ctx.actualInstallDir, ctx.logDir].filter(Boolean).flatMap((p) => [p, rr(p)]));
  const home = ctx.home ? rr(ctx.home) : null;
  const managed = (ctx.policy.paths.managed_dirs || []).map(rr);
  const pc = {
    repoRoot: ctx.repoRoot, home,
    roots: uniq([...roots, ...managed, ctx.repoRoot + '/.git', ctx.repoRoot + '/.claude', ...(home ? [home + '/.claude', home + '/.claude.json'] : [])]),
    markers: (ctx.policy.paths.protected_markers || []).map(lc).concat(roots.map(lc)),
    secretish: ctx.policy.paths.secretish_globs || [],
  };
  ctx._pc = pc;
  return pc;
}

// real: an absolute, symlink-free path (from realResolve).
export function classifyPath(real, pc) {
  const inRepo = isInside(real, pc.repoRoot);
  const rel = inRepo ? path.relative(pc.repoRoot, real) : null;
  const segs = (rel !== null ? rel : real).split('/').filter(Boolean).map(lc);
  const base = segs.length ? segs[segs.length - 1] : '';
  const L = lc(real);
  const isProtected = pc.roots.some((r) => insideCI(real, r)) || segs.includes('.claude') || segs.includes('.claude.json');
  const protectedAncestor = !isProtected && pc.roots.some((r) => insideCI(r, real));
  return {
    inRepo, rel, protected: isProtected, protectedAncestor,
    envfile: segs.some((s) => s.startsWith('.env')),
    secret: segs.includes('secrets') || segs.includes('.ssh') || L.includes('/library/keychains')
      || segs.some((s) => /^id_(rsa|ed25519|ecdsa)/.test(s)),
    secretish: matchGlobs(base, pc.secretish),
  };
}

// Textual secret test for a word that may not exist on disk (no resolution): D-SECRET-ENVFILE / D-SECRET-PATH.
export function textSecret(text) {
  const L = lc(text);
  // grep --exclude=.env* is the one place a .env pattern is allowed to appear (A14).
  if (L.startsWith('--exclude=') || L.startsWith('--exclude-dir=')) return { envfile: false, secret: false };
  const parts = L.split(/[\/:=]/).filter(Boolean);
  const envfile = parts.some((s) => s.startsWith('.env'));
  const secret = parts.includes('secrets') || parts.includes('.ssh') || L.includes('library/keychains')
    || parts.some((s) => /^id_(rsa|ed25519|ecdsa)/.test(s));
  return { envfile, secret };
}

// Expand ~ and $HOME / ${HOME} prefixes for analysis. Returns null when the word is not a usable path.
export function expandHome(text, home) {
  if (text === '~' || text.startsWith('~/')) return home ? home + text.slice(1) : null;
  const m = /^(\$HOME|\$\{HOME\})(\/.*)?$/.exec(text);
  if (m) return home ? home + (m[2] || '') : null;
  return text;
}

export function branchIsProtected(branch, policy) {
  return !branch || policy.branches.protected.includes(branch);
}
