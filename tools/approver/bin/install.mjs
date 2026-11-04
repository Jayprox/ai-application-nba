#!/usr/bin/env node
// Owner-run installer. Copies the approver, policy and scripts outside the repo, records checksums,
// locks the files, starts in shadow mode and PRINTS the hook configuration. It never edits a settings file.
//
//   node tools/approver/bin/install.mjs --repo-visibility private|public [--model-name <id>] [--no-model]
//        [--install-dir <dir>] [--log-dir <dir>] [--repo-root <dir>] [--home <dir>]
//
// Needs an interactive terminal. The Keychain item is created by you afterwards (the command is printed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVER_VERSION, TESTED_CLAUDE_CODE, hashInstalled } from '../src/config.mjs';
import { realResolve } from '../src/paths.mjs';
import { copyTree, walk, shQuote, requireTTY, defaultChflags, bothTTY } from './_lib.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const KEYCHAIN = { service: 'claude-approver-anthropic', account: 'claude-approver' };

export function hookConfig(nodePath, installDir) {
  return { hooks: { PermissionRequest: [{ matcher: 'Bash|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: `${shQuote(nodePath)} ${shQuote(path.join(installDir, 'src', 'approver.mjs'))}`, timeout: 5 }] }] } };
}

function ruleDir(p, home) {
  const r = realResolve(p).real || p; const h = realResolve(home).real || home;
  return r.startsWith(h + '/') ? '~' + r.slice(h.length) : '/' + r; // `~/` and `//abs` are Claude Code's rule path forms
}

export function denyRules(installDir, logDir, home) {
  const i = ruleDir(installDir, home); const l = ruleDir(logDir, home);
  return {
    permissions: { deny: [`Edit(${i}/**)`, `Write(${i}/**)`, `Edit(${l}/**)`, `Write(${l}/**)`, 'Bash(security:*)'], disableBypassPermissionsMode: 'disable' },
  };
}

export function install(opts) {
  const {
    repoVisibility, home = os.homedir(), repoRoot = path.resolve(HERE, '..', '..'), isTTY = bothTTY(), chflags = defaultChflags,
    modelName = 'claude-haiku-4-5', noModel = false, nodePath = process.execPath, priceIn = 1.0, priceOut = 5.0,
  } = opts;
  requireTTY(isTTY, 'install');
  if (!['private', 'public'].includes(repoVisibility)) throw new Error('--repo-visibility private|public is required (run: gh repo view --json visibility). Unknown counts as ask for gh pr comment.');
  const installDir = opts.installDir || path.join(home, 'Library', 'Application Support', 'claude-approver');
  const logDir = opts.logDir || path.join(home, 'Library', 'Logs', 'claude-approver');
  const rr = realResolve(repoRoot);
  if (!rr.ok || !rr.exists || !fs.existsSync(path.join(rr.real, '.git'))) throw new Error(`repo root ${repoRoot} is not a git checkout`);
  if (fs.existsSync(path.join(installDir, 'install.json'))) throw new Error(`already installed at ${installDir}. Run uninstall first (upgrade = uninstall, then install).`);
  if (fs.existsSync(installDir) && fs.readdirSync(installDir).length) throw new Error(`${installDir} exists and is not empty; refusing to touch it.`);
  if (rr.real === realResolve(installDir).real || realResolve(installDir).real.startsWith(rr.real + '/')) throw new Error('the install directory must be outside the repo');

  fs.mkdirSync(installDir, { recursive: true, mode: 0o755 });
  copyTree(path.join(HERE, 'src'), path.join(installDir, 'src'));
  copyTree(path.join(HERE, 'bin'), path.join(installDir, 'bin'));
  fs.mkdirSync(path.join(installDir, 'test', 'fixtures'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'test', 'fixtures', 'requests.json'), path.join(installDir, 'test', 'fixtures', 'requests.json'));
  fs.copyFileSync(path.join(HERE, 'policy', 'policy.sample.json'), path.join(installDir, 'policy.json'));
  fs.copyFileSync(path.join(HERE, 'policy', 'policy.md'), path.join(installDir, 'policy.md'));
  const realInstall = realResolve(installDir).real;
  const realLog = realResolve(logDir).real || logDir;
  const record = {
    approver_version: APPROVER_VERSION, tested_claude_code: TESTED_CLAUDE_CODE, installed_at: new Date().toISOString(),
    repo_root: rr.real, repo_visibility: repoVisibility, node_path: realResolve(nodePath).real || nodePath,
    install_dir: realInstall, log_dir: realLog,
    model: { enabled: !noModel, name: modelName, max_tokens: 150, per_call_cap_usd: 0.02, daily_cap_usd: 1.0, timeout_ms: 8000, prices: { input_per_mtok: priceIn, output_per_mtok: priceOut }, breaker: { failures: 3, cooldown_ms: 600000 } },
    keychain: KEYCHAIN,
    files: hashInstalled(installDir),
  };
  fs.writeFileSync(path.join(installDir, 'install.json'), JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(path.join(installDir, 'mode'), 'shadow\n');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);

  // lock: files 0444, dirs 0555, `mode` stays 0644 so the owner can still switch it; then the immutable flag
  const entries = walk(installDir);
  for (const e of entries) fs.chmodSync(e.path, e.dir ? 0o555 : e.path === path.join(installDir, 'mode') ? 0o644 : 0o444);
  fs.chmodSync(installDir, 0o555);
  const flagged = [...entries.filter((e) => e.path !== path.join(installDir, 'mode')).map((e) => e.path), installDir];
  let flagNote = 'locked with the user-immutable flag (chflags uchg)';
  try { const r = chflags('uchg', flagged); if (r?.skipped) flagNote = 'NOT locked with chflags (not macOS); permissions 0444/0555 only'; } catch (e) { flagNote = `chflags failed (${e.message}); permissions 0444/0555 only`; }

  const cfg = hookConfig(record.node_path, realInstall);
  const text = [
    `Installed the approver ${APPROVER_VERSION} in SHADOW mode (it prints nothing and changes no prompt).`,
    `  install dir : ${realInstall}   (${flagNote})`,
    `  log dir     : ${realLog}`,
    `  repo        : ${rr.real}  (visibility: ${repoVisibility})`,
    `  model       : ${noModel ? 'off' : record.model.name} (log only, never decides)`,
    '', 'NEXT (you do these by hand; nothing below has been run for you):', '',
    '1. Create the API key item in the Keychain (it prompts for the key, so the key stays out of shell history):',
    `   security add-generic-password -a ${KEYCHAIN.account} -s ${KEYCHAIN.service} -T /usr/bin/security -w`,
    '   Use a dedicated key with a low spend limit set in the Anthropic Console. -T lets the background worker read it without a dialog;',
    '   it also lets any process that runs /usr/bin/security as you read it, hence the Bash(security:*) deny rule in step 3.',
    '', '2. Add this hook to ~/.claude/settings.json (merge it into "hooks"):', JSON.stringify(cfg, null, 2),
    '', '3. Recommended deny rules for your user settings (merge into "permissions"; they stop agents editing the approver or its log):',
    JSON.stringify(denyRules(realInstall, realLog, home), null, 2),
    '   The rule path syntax for a folder with a space is UNCONFIRMED: after pasting, ask Claude Code to Edit a file in the install dir and check it is refused.',
    '', '4. Check the repo visibility yourself (the approver never calls the network to find out):',
    '   gh repo view --json visibility    # must match --repo-visibility ' + repoVisibility,
    '', '5. Verify, then follow the owner checklist in tools/approver/README.md:',
    `   node ${shQuote(path.join(realInstall, 'bin', 'verify.mjs'))}`,
  ].join('\n');
  return { record, installDir: realInstall, logDir: realLog, hook: cfg, text, flagged };
}

function parseArgs(argv) {
  const o = {}; const val = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-visibility') o.repoVisibility = val(i++);
    else if (a === '--model-name') o.modelName = val(i++);
    else if (a === '--no-model') o.noModel = true;
    else if (a === '--install-dir') o.installDir = val(i++);
    else if (a === '--log-dir') o.logDir = val(i++);
    else if (a === '--repo-root') o.repoRoot = val(i++);
    else if (a === '--home') o.home = val(i++);
    else if (a === '--price-in') o.priceIn = Number(val(i++));
    else if (a === '--price-out') o.priceOut = Number(val(i++));
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  try { console.log(install(parseArgs(process.argv.slice(2))).text); } catch (e) { console.error('install: ' + e.message); process.exit(e.code === 'NO_TTY' ? 2 : 1); }
}
