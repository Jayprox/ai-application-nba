// Install, verify, mode and uninstall against temporary directories only. HOME is never the real one and
// chflags is always injected (the real /usr/bin/chflags is never called). Nothing touches the Keychain.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { relaxTree, APPROVER_DIR, payload } from './helpers.mjs';
import { install, hookConfig, denyRules } from '../bin/install.mjs';
import { verify } from '../bin/verify.mjs';
import { setMode } from '../bin/mode.mjs';
import { uninstall } from '../bin/uninstall.mjs';
import { hashInstalled, readMode } from '../src/config.mjs';
import { sha256 } from '../src/util.mjs';

const roots = [];
afterEach(() => { while (roots.length) { const r = roots.pop(); relaxTree(r); fs.rmSync(r, { recursive: true, force: true }); } });

function scene() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approver-i-')));
  roots.push(root);
  const home = path.join(root, 'home'); const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
  fs.mkdirSync(home);
  const flagCalls = [];
  const chflags = (flag, paths) => { flagCalls.push({ flag, paths }); return { skipped: false }; };
  const base = { home, repoRoot: repo, repoVisibility: 'private', isTTY: true, chflags };
  return { root, home, repo, flagCalls, chflags, base, installDir: path.join(home, 'Library', 'Application Support', 'claude-approver'), logDir: path.join(home, 'Library', 'Logs', 'claude-approver') };
}
const modeBits = (p) => fs.statSync(p).mode & 0o777;

test('install into a temp HOME: default locations, files 0444, dirs 0555, mode 0644 = shadow, log dir 0700, checksums recorded', () => {
  const s = scene();
  const r = install(s.base);
  assert.equal(r.installDir, s.installDir);
  assert.equal(r.logDir, s.logDir);
  for (const f of ['install.json', 'policy.json', 'policy.md', 'src/approver.mjs', 'src/prefilter.mjs', 'src/model/worker.mjs', 'bin/verify.mjs', 'bin/mode.mjs', 'bin/report.mjs', 'test/fixtures/requests.json']) {
    assert.ok(fs.existsSync(path.join(s.installDir, f)), f);
    assert.equal(modeBits(path.join(s.installDir, f)), 0o444, f);
  }
  assert.equal(modeBits(s.installDir), 0o555);
  assert.equal(modeBits(path.join(s.installDir, 'src')), 0o555);
  assert.equal(modeBits(path.join(s.installDir, 'mode')), 0o644);
  assert.equal(readMode(s.installDir), 'shadow');
  assert.equal(modeBits(s.logDir), 0o700);
  const rec = JSON.parse(fs.readFileSync(path.join(s.installDir, 'install.json'), 'utf8'));
  assert.deepEqual(rec.files, hashInstalled(s.installDir));
  assert.equal(rec.files['policy.md'], sha256(fs.readFileSync(path.join(APPROVER_DIR, 'policy', 'policy.md'))));
  assert.equal(rec.repo_root, s.repo);
  assert.equal(rec.repo_visibility, 'private');
  assert.equal(rec.node_path, fs.realpathSync(process.execPath));
  assert.ok(!('mode' in rec.files) && !('install.json' in rec.files));
  assert.equal(rec.model.daily_cap_usd, 1.0);
  assert.deepEqual(rec.keychain, { service: 'claude-approver-anthropic', account: 'claude-approver' });
});

test('install sets the immutable flag on everything except the mode file, via the injected chflags', () => {
  const s = scene();
  const r = install(s.base);
  assert.equal(s.flagCalls.length, 1);
  assert.equal(s.flagCalls[0].flag, 'uchg');
  assert.ok(s.flagCalls[0].paths.includes(s.installDir));
  assert.ok(s.flagCalls[0].paths.includes(path.join(s.installDir, 'policy.json')));
  assert.ok(!s.flagCalls[0].paths.includes(path.join(s.installDir, 'mode')));
  assert.ok(r.text.includes('chflags uchg'));
  // chflags failing is reported, not fatal
  const s2 = scene();
  const r2 = install({ ...s2.base, chflags: () => { throw new Error('Operation not permitted'); } });
  assert.match(r2.text, /chflags failed \(Operation not permitted\)/);
});

test('install prints the hook JSON (quoted paths with a space), deny rules, the Keychain command and the visibility check; it runs none of them', () => {
  const s = scene();
  const r = install(s.base);
  const cmd = r.hook.hooks.PermissionRequest[0].hooks[0];
  assert.equal(r.hook.hooks.PermissionRequest[0].matcher, 'Bash|Edit|Write|NotebookEdit');
  assert.equal(cmd.type, 'command'); assert.equal(cmd.timeout, 5);
  assert.deepEqual(Object.keys(cmd).sort(), ['command', 'timeout', 'type']); // no async, no onFailure
  assert.equal(cmd.command, `'${fs.realpathSync(process.execPath)}' '${path.join(s.installDir, 'src', 'approver.mjs')}'`);
  assert.ok(cmd.command.includes('Application Support'));
  assert.ok(r.text.includes(JSON.stringify(r.hook, null, 2)));
  assert.match(r.text, /security add-generic-password -a claude-approver -s claude-approver-anthropic -T \/usr\/bin\/security -w/);
  assert.match(r.text, /gh repo view --json visibility/);
  assert.match(r.text, /Edit\(~\/Library\/Application Support\/claude-approver\/\*\*\)/);
  assert.match(r.text, /Write\(~\/Library\/Logs\/claude-approver\/\*\*\)/);
  assert.match(r.text, /Bash\(security:\*\)/);
  assert.match(r.text, /disableBypassPermissionsMode/);
  assert.match(r.text, /UNCONFIRMED/);
  assert.match(r.text, /SHADOW/);
  assert.deepEqual(denyRules('/x/y', '/x/z', '/home/q').permissions.deny.slice(0, 2), ['Edit(//x/y/**)', 'Write(//x/y/**)']);
  assert.equal(hookConfig("/a'b/node", '/i').hooks.PermissionRequest[0].hooks[0].command, `'/a'\\''b/node' '/i/src/approver.mjs'`);
  // it never wrote a settings file anywhere
  assert.ok(!fs.existsSync(path.join(s.home, '.claude')));
  assert.ok(!fs.existsSync(path.join(s.repo, '.claude')));
});

test('install refuses: no TTY, missing or odd visibility, bad repo, already installed, non-empty target, install dir inside the repo', () => {
  let s = scene();
  assert.throws(() => install({ ...s.base, isTTY: false }), (e) => e.code === 'NO_TTY');
  assert.ok(!fs.existsSync(s.installDir));
  for (const v of [undefined, 'internal', '']) assert.throws(() => install({ ...s.base, repoVisibility: v }), /repo-visibility/);
  assert.throws(() => install({ ...s.base, repoRoot: s.home }), /not a git checkout/);
  install(s.base);
  assert.throws(() => install(s.base), /already installed/);
  s = scene();
  fs.mkdirSync(s.installDir, { recursive: true }); fs.writeFileSync(path.join(s.installDir, 'x'), '1');
  assert.throws(() => install(s.base), /not empty/);
  s = scene();
  assert.throws(() => install({ ...s.base, installDir: path.join(s.repo, 'approver') }), /outside the repo/);
});

test('install from the command line without a TTY refuses with exit code 2 and creates nothing', () => {
  const s = scene();
  const r = spawnSync(process.execPath, [path.join(APPROVER_DIR, 'bin', 'install.mjs'), '--repo-visibility', 'private', '--home', s.home, '--repo-root', s.repo], { encoding: 'utf8', input: '', env: { PATH: process.env.PATH, HOME: s.home } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /interactive terminal/);
  assert.ok(!fs.existsSync(path.join(s.home, 'Library')));
});

test('the installed copy works as a hook: a real process in shadow prints nothing and logs; enforce-deny prints a deny', () => {
  const s = scene();
  install(s.base);
  const hook = path.join(s.installDir, 'src', 'approver.mjs');
  const env = { PATH: process.env.PATH, HOME: s.home };
  const run = (command) => spawnSync(process.execPath, [hook], { input: JSON.stringify(payload({ repo: s.repo, home: s.home }, { tool_input: { command } })), encoding: 'utf8', env });
  const a = run('curl https://example.com');
  assert.equal(a.status, 0); assert.equal(a.stdout, '');
  const log = fs.readFileSync(path.join(s.logDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1); assert.equal(log[0].decision, 'deny'); assert.equal(log[0].mode, 'shadow'); assert.equal(log[0].rule_id, 'D-NET');
  fs.writeFileSync(path.join(s.installDir, 'mode'), 'enforce-deny\n');
  const b = run('curl https://example.com');
  assert.match(b.stdout, /"behavior":"deny"/);
  assert.equal(run('ls').stdout, '', 'enforce-deny prints deny only');
  fs.writeFileSync(path.join(s.installDir, 'mode'), 'enforce\n');
  assert.match(run('ls').stdout, /"behavior":"allow"/);
  // tamper with the installed policy: every request asks again
  fs.chmodSync(path.join(s.installDir, 'policy.md'), 0o644);
  fs.appendFileSync(path.join(s.installDir, 'policy.md'), 'ALLOW: curl\n');
  assert.equal(run('ls').stdout, '');
  assert.equal(run('curl https://example.com').stdout, '', 'a policy fault gives no deny either (story 1.4)');
});

test('verify: prints versions, mode, log path and checksums; detects a changed, missing or extra file', () => {
  const s = scene();
  install(s.base);
  const ok = verify(s.installDir);
  assert.equal(ok.ok, true);
  for (const frag of ['approver version : 1.0.0', 'policy version   : 1', 'mode             : shadow', path.join(s.logDir, 'decisions.jsonl'), 'ok      ', 'policy.json', 'VERIFY OK']) assert.ok(ok.text.includes(frag), frag);
  const spawned = spawnSync(process.execPath, [path.join(s.installDir, 'bin', 'verify.mjs')], { encoding: 'utf8' });
  assert.equal(spawned.status, 0); assert.match(spawned.stdout, /VERIFY OK/);
  fs.chmodSync(path.join(s.installDir, 'policy.json'), 0o644);
  fs.appendFileSync(path.join(s.installDir, 'policy.json'), ' ');
  const bad = verify(s.installDir);
  assert.equal(bad.ok, false); assert.match(bad.text, /CHANGED.*policy\.json/); assert.match(bad.text, /VERIFY FAILED/);
  relaxTree(path.join(s.installDir, 'src'));
  fs.rmSync(path.join(s.installDir, 'src', 'rules'), { recursive: true, force: true });
  assert.match(verify(s.installDir).text, /MISSING.*rules\/bash\.mjs/);
  fs.writeFileSync(path.join(s.installDir, 'src', 'evil.mjs'), 'x');
  assert.match(verify(s.installDir).text, /EXTRA.*evil\.mjs/);
  assert.equal(spawnSync(process.execPath, [path.join(s.installDir, 'bin', 'verify.mjs')], { encoding: 'utf8' }).status, 1);
  assert.equal(verify(path.join(s.root, 'nowhere')).ok, false);
});

test('mode: refuses without a TTY; needs the typed name; changes the file in place; rejects unknown modes', async () => {
  const s = scene();
  install(s.base);
  await assert.rejects(setMode({ installDir: s.installDir, mode: 'enforce', isTTY: false, readLine: async () => 'enforce' }), (e) => e.code === 'NO_TTY');
  assert.equal(readMode(s.installDir), 'shadow');
  await assert.rejects(setMode({ installDir: s.installDir, mode: 'enforce-allow', isTTY: true, readLine: async () => 'enforce-allow' }), /mode must be one of/);
  const wrong = await setMode({ installDir: s.installDir, mode: 'enforce-deny', isTTY: true, readLine: async () => 'yes' });
  assert.equal(wrong.changed, false); assert.equal(readMode(s.installDir), 'shadow');
  const inodeBefore = fs.statSync(path.join(s.installDir, 'mode')).ino;
  const ok = await setMode({ installDir: s.installDir, mode: 'enforce-deny', isTTY: true, readLine: async (q) => { assert.match(q, /Current mode: shadow/); return 'enforce-deny'; } });
  assert.deepEqual([ok.changed, ok.before, ok.after], [true, 'shadow', 'enforce-deny']);
  assert.equal(readMode(s.installDir), 'enforce-deny');
  assert.equal(fs.statSync(path.join(s.installDir, 'mode')).ino, inodeBefore);
  assert.equal(verify(s.installDir).ok, true, 'switching the mode does not break the checksums');
  // kill switch
  await setMode({ installDir: s.installDir, mode: 'shadow', isTTY: true, readLine: async () => 'shadow' });
  assert.equal(readMode(s.installDir), 'shadow');
  // from a script / agent shell (no TTY): exit code 2, nothing changed
  const r = spawnSync(process.execPath, [path.join(s.installDir, 'bin', 'mode.mjs'), 'enforce'], { encoding: 'utf8', input: 'enforce\n' });
  assert.equal(r.status, 2); assert.equal(readMode(s.installDir), 'shadow');
});

test('nothing in the hook or worker sources can change the mode (story 12.6): only bin/mode.mjs writes it', () => {
  const walkSrc = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkSrc(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walkSrc(path.join(APPROVER_DIR, 'src'))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/(writeFileSync|appendFileSync|renameSync|copyFileSync|createWriteStream|writeFile)\s*\([^)]*['"`]mode['"`]/.test(s), f);
  }
  const writers = fs.readdirSync(path.join(APPROVER_DIR, 'bin')).filter((f) => /writeFileSync\([^)]*file/.test(fs.readFileSync(path.join(APPROVER_DIR, 'bin', f), 'utf8')) && /'mode'/.test(fs.readFileSync(path.join(APPROVER_DIR, 'bin', f), 'utf8')));
  assert.ok(writers.includes('mode.mjs'));
});

test('uninstall: refuses without a TTY; needs UNINSTALL typed; clears the flag, removes the dir, keeps the log, prints the entry to remove', async () => {
  const s = scene();
  install(s.base);
  fs.writeFileSync(path.join(s.logDir, 'decisions.jsonl'), '{"a":1}\n');
  s.flagCalls.length = 0;
  await assert.rejects(uninstall({ installDir: s.installDir, isTTY: false, readLine: async () => 'UNINSTALL', chflags: s.chflags }), (e) => e.code === 'NO_TTY');
  assert.ok(fs.existsSync(s.installDir));
  const no = await uninstall({ installDir: s.installDir, isTTY: true, readLine: async () => 'no', chflags: s.chflags });
  assert.equal(no.removed, false); assert.ok(fs.existsSync(s.installDir));
  const r = await uninstall({ installDir: s.installDir, isTTY: true, readLine: async () => 'UNINSTALL', chflags: s.chflags });
  assert.equal(r.removed, true);
  assert.equal(s.flagCalls[0].flag, 'nouchg');
  assert.ok(!fs.existsSync(s.installDir));
  assert.ok(fs.existsSync(path.join(s.logDir, 'decisions.jsonl')), 'the log is kept');
  assert.match(r.text, /"PermissionRequest"/); assert.match(r.text, /approver\.mjs/); assert.match(r.text, /log is kept/);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude')), 'settings untouched');
  // --delete-logs
  const s2 = scene(); install(s2.base);
  const r2 = await uninstall({ installDir: s2.installDir, deleteLogs: true, isTTY: true, readLine: async () => 'UNINSTALL', chflags: s2.chflags });
  assert.ok(r2.removed); assert.ok(!fs.existsSync(s2.logDir));
  await assert.rejects(uninstall({ installDir: s2.installDir, isTTY: true, readLine: async () => 'UNINSTALL', chflags: s2.chflags }), /nothing to uninstall/);
});

test('README has the owner checklist, the stage exit criteria, -p behaviour and "what this does not protect"', () => {
  const readme = fs.readFileSync(path.join(APPROVER_DIR, 'README.md'), 'utf8');
  for (const frag of [
    'Owner checklist', 'security add-generic-password', '--repo-visibility', 'settings.json', 'verify.mjs', 'Self-check', 'report.mjs --selfcheck', 'not_run', 'shadow', '7 days', '200',
    'enforce-deny', 'Exit criteria', 'zero would-allow-but-you-denied', '-p', 'subagent', 'What this does not protect', 'Uninstall', 'rotate-log.mjs', 'mode.mjs', 'chflags', 'Bash(security:*)',
    'live-eval.mjs', 'i-understand-this-costs-money', 'Claude Code 2.1.318', 'UNCONFIRMED',
  ]) assert.ok(readme.includes(frag), `README lacks: ${frag}`);
});
