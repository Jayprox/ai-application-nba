// The only module that may touch stdout. Everything the hook prints goes through
// outputForMode() + writeStdout(), once, as the very last step (story 1.5).
// A test fails the build if any other src file mentions process.stdout or console.log.
import { Buffer } from 'node:buffer';

export const MAX_STDIN = 4 * 1024 * 1024;

export function readStdin(stream, { max = MAX_STDIN, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'stdin_timeout' }), timeoutMs);
    stream.on('data', (c) => {
      size += c.length;
      if (size > max) return finish({ ok: false, error: 'stdin_oversized' });
      chunks.push(c);
    });
    stream.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    stream.on('error', () => finish({ ok: false, error: 'stdin_error' }));
  });
}

export const ALLOW_JSON = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

export function denyJson(ruleId) {
  const id = /^[A-Z0-9-]{1,40}$/.test(String(ruleId)) ? ruleId : 'UNKNOWN';
  // No command text, no interrupt, no updatedInput, no updatedPermissions.
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: `Denied by the approval policy (rule ${id}). Ask the owner if this is needed.` },
    },
  });
}

// Table 3.2 of the plan. Anything not a clean final allow/deny prints nothing.
export function outputForMode(mode, result) {
  if (!result || result.error) return '';
  if (result.decision === 'deny' && (mode === 'enforce-deny' || mode === 'enforce')) return denyJson(result.rule_id);
  if (result.decision === 'allow' && mode === 'enforce') return ALLOW_JSON;
  return '';
}

export function writeStdout(text) {
  return new Promise((resolve) => { process.stdout.write(text, () => resolve()); });
}
