// The one place that starts a process: a read-only git diff for the npm test guard (A8).
// Injected in tests. Minimal environment, no user or system git config, short timeout.
import { spawnSync } from 'node:child_process';

export function runGit(args, { cwd, timeoutMs = 1500 } = {}) {
  const r = spawnSync('git', args, {
    cwd, timeout: timeoutMs, stdio: 'ignore', encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  });
  return { status: r.error ? -1 : r.status };
}
