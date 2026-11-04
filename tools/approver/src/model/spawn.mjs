// Starts the detached worker. Request goes in on stdin; stdout and stderr are ignored, so nothing the
// worker prints can reach the hook's stdout. The environment is minimal: no API key, nothing inherited.
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

export function workerSpawnSpec({ install, installDir, home }) {
  return {
    cmd: install.node_path,
    args: [path.join(installDir, 'src', 'model', 'worker.mjs')],
    options: { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: home }, cwd: '/' },
  };
}

// Resolves once the request has been handed to the child (or after 300 ms), never rejects.
export function spawnWorker({ install, installDir, home, request, spawnFn = nodeSpawn }) {
  return new Promise((resolve) => {
    let child;
    const done = () => resolve();
    try {
      const spec = workerSpawnSpec({ install, installDir, home });
      child = spawnFn(spec.cmd, spec.args, spec.options);
      child.on('error', done);
      child.stdin.on('error', done);
      child.unref();
      child.stdin.end(JSON.stringify(request), done);
      setTimeout(done, 300).unref?.();
    } catch { done(); }
  });
}
