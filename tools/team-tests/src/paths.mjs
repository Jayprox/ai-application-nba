// Scratch-directory creation and path checks for the team-tests harness.
// Node built-ins only. Never spawns `claude`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MARKER_NAME = '.team-tests-scratch';
export const MARKER_TOOL = 'team-tests';
export const SCRATCH_PREFIX = 'team-tests-';

/** True if `p` is `root` or lies under it (both must already be resolved). */
export function isWithin(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True if any ancestor of `dir` (or dir itself) is a git work tree. Requires an existing dir. */
export function isInsideGitWorkTree(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

export function markerPath(root) {
  return path.join(root, MARKER_NAME);
}

/**
 * Create a scratch root under os.tmpdir(): mkdtemp, realpath, refuse if it is a symlink or
 * inside any git work tree, then write the marker file that safe-rm requires.
 * Returns the realpath of the scratch root.
 */
export function createScratch(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(runId)) {
    throw new Error('createScratch: invalid runId');
  }
  const base = fs.realpathSync(os.tmpdir());
  const made = fs.mkdtempSync(path.join(base, SCRATCH_PREFIX));
  try {
    const real = fs.realpathSync(made);
    if (fs.lstatSync(made).isSymbolicLink() || real !== made) {
      throw new Error('createScratch: scratch path is or crosses a symlink');
    }
    if (!isWithin(base, real) || real === base) throw new Error('createScratch: scratch outside tmpdir');
    if (isInsideGitWorkTree(real)) throw new Error('createScratch: scratch is inside a git work tree');
    fs.writeFileSync(
      markerPath(real),
      JSON.stringify({ tool: MARKER_TOOL, runId, createdAt: new Date().toISOString() }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    return real;
  } catch (err) {
    fs.rmSync(made, { recursive: true, force: true });
    throw err;
  }
}
