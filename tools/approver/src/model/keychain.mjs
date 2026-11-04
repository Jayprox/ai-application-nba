// Reads the API key from the macOS Keychain into memory. execFile, no shell. The key is never put in an
// environment variable, a file, an argument or a log. execFile is injected so tests never touch the Keychain.
import { execFile as nodeExecFile } from 'node:child_process';

export const SECURITY_BIN = '/usr/bin/security';

export function defaultExecFile(file, args, opts) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export async function readKey({ service, account, execFile = defaultExecFile, timeoutMs = 3000 }) {
  if (typeof service !== 'string' || typeof account !== 'string' || !service || !account) return { ok: false, error: 'key_unavailable' };
  try {
    const out = await execFile(SECURITY_BIN, ['find-generic-password', '-a', account, '-s', service, '-w'], {
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin' }, windowsHide: true,
    });
    const key = String(out).trim();
    if (!key || /\s/.test(key) || key.length > 512) return { ok: false, error: 'key_unavailable' };
    return { ok: true, key };
  } catch {
    return { ok: false, error: 'key_unavailable' }; // absent, locked, slow, or security exited non-zero
  }
}
