// The one place that starts a process: a read-only git diff for the npm test guard (A8).
// Injected in tests. Minimal environment, no user or system git config, short timeout.
import { spawnSync } from 'node:child_process';

export function runGit(args, { cwd, timeoutMs = 1500, env = {}, capture = false } = {}) {
  const r = spawnSync('git', args, {
    cwd, timeout: timeoutMs, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], encoding: 'utf8', maxBuffer: 64 * 1024,
    // minimal environment: nothing GIT_* from the caller, no user or system git config
    env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', ...env },
  });
  return { status: r.error ? -1 : r.status, stdout: capture ? String(r.stdout || '') : '' };
}
