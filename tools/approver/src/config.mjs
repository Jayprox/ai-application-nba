// install.json, mode file, policy load + checksum. Anything wrong -> a result the caller turns into ask.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, isPlainObject } from './util.mjs';

export const APPROVER_VERSION = '1.0.0';
export const TESTED_CLAUDE_CODE = '2.1.318';
export const SUPPORTED_POLICY_VERSIONS = [1];
export const MODES = ['shadow', 'enforce-deny', 'enforce'];

function readText(file, maxBytes = 1024 * 1024) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > maxBytes) throw new Error('bad_file');
  return fs.readFileSync(file);
}

export function loadInstall(installDir) {
  let raw;
  try { raw = readText(path.join(installDir, 'install.json')); } catch { return { ok: false, error: 'install_missing' }; }
  let j;
  try { j = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, error: 'install_unparsable' }; }
  const ok = isPlainObject(j)
    && typeof j.approver_version === 'string'
    && typeof j.repo_root === 'string' && path.isAbsolute(j.repo_root)
    && typeof j.log_dir === 'string' && path.isAbsolute(j.log_dir)
    && typeof j.install_dir === 'string' && path.isAbsolute(j.install_dir)
    && isPlainObject(j.files)
    && typeof j.files['policy.json'] === 'string' && typeof j.files['policy.md'] === 'string';
  if (!ok) return { ok: false, error: 'install_invalid' };
  return { ok: true, install: j };
}

// Unreadable or unknown value means shadow (story 5.8): the safe mode.
export function readMode(installDir) {
  try {
    const m = readText(path.join(installDir, 'mode'), 256).toString('utf8').trim();
    return MODES.includes(m) ? m : 'shadow';
  } catch { return 'shadow'; }
}

export function loadPolicy(installDir, install) {
  let json, md;
  try { json = readText(path.join(installDir, 'policy.json')); md = readText(path.join(installDir, 'policy.md')); }
  catch { return { ok: false, error: 'policy_missing' }; }
  if (sha256(json) !== install.files['policy.json'] || sha256(md) !== install.files['policy.md']) {
    return { ok: false, error: 'policy_checksum_mismatch' };
  }
  let policy;
  try { policy = JSON.parse(json.toString('utf8')); } catch { return { ok: false, error: 'policy_unparsable' }; }
  if (!isPlainObject(policy) || !SUPPORTED_POLICY_VERSIONS.includes(policy.policy_version)) {
    return { ok: false, error: 'policy_version_unknown' };
  }
  return { ok: true, policy, policy_md: md.toString('utf8') };
}

export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

// Hashes of every installed file except install.json itself and the mode file (owner edits mode).
export function hashInstalled(installDir) {
  const files = {};
  for (const rel of listFiles(installDir)) {
    if (rel === 'install.json' || rel === 'mode') continue;
    files[rel] = sha256(fs.readFileSync(path.join(installDir, rel)));
  }
  return files;
}
