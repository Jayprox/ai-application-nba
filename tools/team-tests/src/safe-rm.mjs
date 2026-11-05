// Removes only scratch roots that the harness created. Refuses anything else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER_NAME, MARKER_TOOL, SCRATCH_PREFIX, isWithin } from './paths.mjs';

export class SafeRmRefusal extends Error {
  constructor(reason) {
    super(`safe-rm refused: ${reason}`);
    this.name = 'SafeRmRefusal';
    this.reason = reason;
  }
}

/**
 * Remove a scratch root. Refuses (throws SafeRmRefusal, deletes nothing) unless:
 *  - target is an absolute path to an existing directory that is not a symlink,
 *    and no component of it is a symlink (realpath equals the given path);
 *  - it lies strictly inside realpath(os.tmpdir()) and its name starts with the scratch prefix;
 *  - it holds a regular-file marker written by createScratch (valid JSON, tool matches).
 * fs.rmSync does not follow symlinks found inside the tree.
 */
export function safeRm(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new SafeRmRefusal('path is not absolute');
  const given = path.resolve(target);
  let st;
  try {
    st = fs.lstatSync(given);
  } catch {
    throw new SafeRmRefusal('path does not exist');
  }
  if (st.isSymbolicLink()) throw new SafeRmRefusal('path is a symlink');
  if (!st.isDirectory()) throw new SafeRmRefusal('path is not a directory');
  const real = fs.realpathSync(given);
  if (real !== given) throw new SafeRmRefusal('path crosses a symlink');
  const base = fs.realpathSync(os.tmpdir());
  if (real === base || !isWithin(base, real)) throw new SafeRmRefusal('path is outside os.tmpdir()');
  if (!path.basename(real).startsWith(SCRATCH_PREFIX)) throw new SafeRmRefusal('name lacks scratch prefix');
  const marker = path.join(real, MARKER_NAME);
  let mst;
  try {
    mst = fs.lstatSync(marker);
  } catch {
    throw new SafeRmRefusal('marker file missing');
  }
  if (!mst.isFile()) throw new SafeRmRefusal('marker is not a regular file');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    throw new SafeRmRefusal('marker is not valid');
  }
  if (!parsed || parsed.tool !== MARKER_TOOL) throw new SafeRmRefusal('marker is not valid');
  fs.rmSync(real, { recursive: true, force: true });
}
