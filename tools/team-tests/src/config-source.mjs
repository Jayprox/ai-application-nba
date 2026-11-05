// Reads the team config (CLAUDE.md, agents, commands) from a git ref, read-only.
// Only these paths are ever returned: never settings, hooks or tools/approver.
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ALLOWED = [/^CLAUDE\.md$/, /^\.claude\/agents\/[^/]+\.md$/, /^\.claude\/commands\/[^/]+\.md$/];
const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,200}$/;

export const isAllowedConfigPath = (p) => ALLOWED.some((re) => re.test(p));

function git(repoRoot, args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  if (r.status !== 0) throw new Error(`config-source: git ${args[0]} failed`);
  return r.stdout;
}

/** Returns [{path, content: Buffer}] for the allowed config files at `ref`. */
export function readConfigAtRef(repoRoot, ref = 'HEAD') {
  if (!REF.test(ref)) throw new Error('config-source: invalid ref');
  const names = git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', ref, '--']).toString('utf8').split('\0').filter(Boolean);
  return names
    .filter(isAllowedConfigPath)
    .sort()
    .map((p) => ({ path: p, content: git(repoRoot, ['show', `${ref}:${p}`]) }));
}
