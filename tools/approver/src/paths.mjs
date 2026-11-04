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
