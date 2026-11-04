#!/usr/bin/env node
// Owner-run: one command to see what is installed and whether any installed file changed.
//   node verify.mjs [--install-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstall, readMode, hashInstalled, APPROVER_VERSION } from '../src/config.mjs';

export function verify(installDir) {
  const lines = []; let ok = true;
  const inst = loadInstall(installDir);
  if (!inst.ok) return { ok: false, text: `VERIFY FAILED: ${inst.error} in ${installDir}\n` };
  const i = inst.install;
  let policyVersion = '?';
  try { policyVersion = JSON.parse(fs.readFileSync(path.join(installDir, 'policy.json'), 'utf8')).policy_version; } catch { ok = false; }
  lines.push(`approver version : ${i.approver_version} (this copy: ${APPROVER_VERSION}; tested with Claude Code ${i.tested_claude_code ?? '?'})`);
  lines.push(`policy version   : ${policyVersion}`);
  lines.push(`mode             : ${readMode(installDir)}`);
  lines.push(`repo             : ${i.repo_root} (visibility ${i.repo_visibility})`);
  lines.push(`node             : ${i.node_path}`);
  lines.push(`install dir      : ${i.install_dir}`);
  lines.push(`log file         : ${path.join(i.log_dir, 'decisions.jsonl')}`);
  lines.push(`model (log only) : ${i.model?.enabled ? i.model.name : 'off'}`);
  lines.push('installed files (sha256):');
  const now = hashInstalled(installDir);
  for (const f of Object.keys(i.files).sort()) {
    const status = now[f] === undefined ? 'MISSING' : now[f] === i.files[f] ? 'ok' : 'CHANGED';
    if (status !== 'ok') ok = false;
    lines.push(`  ${status.padEnd(7)} ${(now[f] ?? i.files[f]).slice(0, 16)}  ${f}`);
  }
  for (const f of Object.keys(now)) if (!(f in i.files)) { ok = false; lines.push(`  EXTRA   ${now[f].slice(0, 16)}  ${f}`); }
  const modeFile = path.join(installDir, 'mode');
  lines.push(`  (mode file is not checksummed; the owner edits it)  ${fs.existsSync(modeFile) ? 'present' : 'MISSING'}`);
  if (!fs.existsSync(modeFile)) ok = false;
  lines.push(ok ? 'VERIFY OK' : 'VERIFY FAILED');
  return { ok, text: lines.join('\n') + '\n' };
}

if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const args = process.argv.slice(2); const k = args.indexOf('--install-dir');
  const dir = k >= 0 ? args[k + 1] : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const r = verify(dir);
  process.stdout.write(r.text);
  process.exit(r.ok ? 0 : 1);
}
