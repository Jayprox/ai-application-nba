// Test fixtures: a temporary repo, a temporary install dir, a temporary log dir. Never the real HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { hashInstalled, APPROVER_VERSION } from '../src/config.mjs';
import { run } from '../src/approver.mjs';

export const APPROVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function cpDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

export function makeEnv({ branch = 'feat/test', mode = 'shadow', visibility = 'private', policyJson } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approver-t-')));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const installDir = path.join(root, 'Library', 'Application Support', 'claude-approver'); // note the space
  const logDir = path.join(root, 'Library', 'Logs', 'claude-approver');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  if (branch) fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  cpDir(path.join(APPROVER_DIR, 'src'), path.join(installDir, 'src'));
  fs.copyFileSync(path.join(APPROVER_DIR, 'policy', 'policy.md'), path.join(installDir, 'policy.md'));
  if (policyJson !== undefined) fs.writeFileSync(path.join(installDir, 'policy.json'), policyJson);
  else fs.copyFileSync(path.join(APPROVER_DIR, 'policy', 'policy.sample.json'), path.join(installDir, 'policy.json'));
  const env = { root, repo, home, installDir, logDir, mode };
  writeInstall(env, { visibility });
  fs.writeFileSync(path.join(installDir, 'mode'), mode + '\n');
  return env;
}

export function writeInstall(env, { visibility = 'private', extra = {} } = {}) {
  const rec = {
    approver_version: APPROVER_VERSION, repo_root: env.repo, repo_visibility: visibility, node_path: process.execPath,
    install_dir: env.installDir, log_dir: env.logDir, files: hashInstalled(env.installDir), ...extra,
  };
  fs.writeFileSync(path.join(env.installDir, 'install.json'), JSON.stringify(rec, null, 2));
}

export const payload = (env, over = {}) => ({
  session_id: 's1', transcript_path: path.join(env.home, '.claude', 'projects', 'x', 's1.jsonl'), cwd: env.repo,
  prompt_id: 'p1', permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'ls' }, ...over,
});

export const stdinOf = (text) => Readable.from([Buffer.from(text)]);

export function runHook(env, p, deps = {}) {
  const text = typeof p === 'string' ? p : JSON.stringify(p);
  return run({ stdin: stdinOf(text), installDir: env.installDir, deps: { home: env.home, ...deps } });
}

export function spawnHook(env, text, { entry } = {}) {
  return spawnSync(process.execPath, [entry || path.join(env.installDir, 'src', 'approver.mjs')], {
    input: text, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: env.home },
  });
}

export function readLog(env) {
  const f = path.join(env.logDir, 'decisions.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export const cleanup = (env) => fs.rmSync(env.root, { recursive: true, force: true });

// ---- pre-filter fixtures ----
import { prefilter } from '../src/prefilter.mjs';

export const SAMPLE_POLICY = JSON.parse(fs.readFileSync(path.join(APPROVER_DIR, 'policy', 'policy.sample.json'), 'utf8'));

// A small repo with the files the rules look at, plus symlinks to things that must stay protected.
export function seedRepo(env) {
  const w = (rel, body = 'x') => { const f = path.join(env.repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  for (const f of ['README.md', 'CLAUDE.md', 'docs/a.md', 'docs/b.md', 'src/app.js', 'test/y.test.js', 'worker/test/x.test.js', 'worker/package.json', 'package.json',
    'package-lock.json', 'scripts/weekly-drill.sh', 'scripts/other.sh', 'certs/server.pem', '.env', '.env.example', 'sub/.env.production', '.claude/settings.json',
    'secrets/api.txt', '.npmrc', '.github/workflows/test.yml', 'tools/approver/src/x.mjs', 'db/schema.sql', 'ops/launchd/a.plist']) w(f);
  fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(env.home, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(path.join(env.home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(env.home, '.ssh', 'id_rsa'), 'k');
  fs.mkdirSync(env.logDir, { recursive: true });
  fs.symlinkSync(path.join(env.repo, '.env'), path.join(env.repo, 'notes.txt'));
  fs.symlinkSync(path.join(env.repo, '.claude'), path.join(env.repo, 'innocent'));
  fs.symlinkSync(env.installDir, path.join(env.repo, 'docs', 'inst'));
  fs.symlinkSync(path.join(env.home, '.claude'), path.join(env.repo, 'homeclaude'));
  fs.symlinkSync(env.home, path.join(env.repo, 'homelink'));
  return env;
}

export function mkCtx(env, over = {}) {
  return {
    repoRoot: env.repo, repoVisibility: 'private', home: env.home, installDir: env.installDir, actualInstallDir: env.installDir,
    logDir: env.logDir, policy: SAMPLE_POLICY, runGit: () => ({ status: 0 }), ...over,
  };
}

export function judge(env, tool, input, { cwd, branch = 'feat/test', ctx } = {}) {
  return prefilter({ tool, input, cwd: cwd || env.repo, branch, ctx: ctx || mkCtx(env) });
}
export const bash = (env, command, opt) => judge(env, 'Bash', { command }, opt);
