// Sec F1 (M8 PR B cycle 2): the checkers never run fixture-controlled git configuration. The agent
// can write the fixture's .git/config, .git/info/attributes, .gitattributes and .git/hooks; a
// checker git call must not run any program those name (filters, textconv, hooks, fsmonitor,
// external diff, pager, editor). Every filter here appends to a marker file when it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluate } from '../src/checkers/index.mjs';
import { handlers as git } from '../src/checkers/git.mjs';
import { changedFiles, changedOn, textFiles, branches } from '../src/checkers/util.mjs';
import { handlers as tba } from '../src/checkers/tests-before-after.mjs';
import { MISSIONS, makeRun, byId } from './helpers.mjs';

function plant(f, marker) {
  const gd = path.join(f.fixtureDir, '.git');
  const bin = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-evil-'));
  const script = path.join(bin, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`, { mode: 0o755 });
  const hooks = path.join(bin, 'hooks');
  fs.mkdirSync(hooks);
  for (const h of ['post-checkout', 'post-merge', 'reference-transaction', 'pre-commit', 'post-index-change', 'fsmonitor-watchman']) fs.copyFileSync(script, path.join(hooks, h)), fs.chmodSync(path.join(hooks, h), 0o755);
  fs.mkdirSync(path.join(gd, 'hooks'), { recursive: true });
  for (const h of ['post-checkout', 'reference-transaction', 'post-index-change']) fs.copyFileSync(script, path.join(gd, 'hooks', h)), fs.chmodSync(path.join(gd, 'hooks', h), 0o755);
  fs.appendFileSync(path.join(gd, 'config'), [
    '[filter "evil"]', `\tsmudge = ${script} smudge`, `\tclean = ${script} clean`, `\tprocess = ${script} process`, '\trequired = false',
    '[diff "evil"]', `\ttextconv = ${script} textconv`, `\tcommand = ${script} diffcmd`,
    '[diff]', `\texternal = ${script} external`,
    '[core]', `\tfsmonitor = ${script} fsmonitor`, `\thooksPath = ${hooks}`, `\tpager = ${script} pager`, `\teditor = ${script} editor`, `\tattributesFile = ${path.join(gd, 'attrs')}`,
    '[include]', `\tpath = ${path.join(bin, 'more.cfg')}`, '',
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'more.cfg'), `[core]\n\tfsmonitor = ${script} include\n`);
  fs.writeFileSync(path.join(gd, 'attrs'), '* filter=evil diff=evil\n');
  fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
  fs.appendFileSync(path.join(gd, 'info', 'attributes'), '* filter=evil diff=evil\n');
  fs.writeFileSync(path.join(f.fixtureDir, '.gitattributes'), '* filter=evil diff=evil\n');
  fs.appendFileSync(path.join(f.fixtureDir, 'src', 'price.js'), '// touched after the commit, so a clean filter would be asked\n');
  return bin;
}

test('control: the planted configuration really does run when plain git is aimed at the fixture', () => {
  const marker = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-mark-')), 'ran');
  const { f, cleanup } = makeRun('G1');
  let bin;
  try {
    bin = plant(f, marker);
    spawnSync('git', ['-C', f.fixtureDir, 'diff', '--name-only', f.baseSha, '--'], { encoding: 'utf8' });
    assert.ok(fs.existsSync(marker), 'clean filter or fsmonitor ran: the plant works, so a clean marker below means something');
    fs.rmSync(marker);
    const wt = path.join(path.dirname(marker), 'wt');
    spawnSync('git', ['-C', f.fixtureDir, 'worktree', 'add', '--detach', '--force', wt, f.baseSha], { encoding: 'utf8' });
    assert.ok(fs.existsSync(marker), 'smudge filter ran on checkout');
  } finally { cleanup(); fs.rmSync(path.dirname(marker), { recursive: true, force: true }); if (bin) fs.rmSync(bin, { recursive: true, force: true }); }
});

test('no checker runs fixture-controlled git config: filters, textconv, hooks, fsmonitor, external diff, includes', () => {
  const marker = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-mark-')), 'ran');
  const bins = [];
  try {
    for (const id of Object.keys(MISSIONS)) {
      const { run, f, cleanup } = makeRun(id);
      try {
        bins.push(plant(f, marker));
        const ev = evaluate(run);
        assert.ok(ev.results.length > 0, id);
        for (const fn of [changedFiles, (r) => changedOn(r, 'HEAD'), (r) => textFiles(r, ['docs/', 'CLAUDE.md']), branches]) fn(run);
        for (const h of Object.values(git)) { try { h(run); } catch { /* errors are fine; running the filter is not */ } }
        if (id === 'G1') {
          assert.equal(byId(ev, 'G1.test-before-after').status, 'passed');
          assert.equal(tba['G1.test-before-after'](run).pass, true);
        }
        assert.equal(fs.existsSync(marker), false, `${id}: a fixture-controlled program ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n')[0].replace(/^\S*\//, '') : ''}`);
      } finally { cleanup(); }
    }
  } finally {
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    for (const b of bins) fs.rmSync(b, { recursive: true, force: true });
  }
});

test('the work-tree change is still seen without git reading the work tree through the fixture config', () => {
  const { run, f, cleanup } = makeRun('G1');
  try {
    fs.appendFileSync(path.join(f.fixtureDir, 'src', 'price.js'), '// edit\n');
    fs.writeFileSync(path.join(f.fixtureDir, 'src', 'new-untracked.js'), 'x\n');
    const c = changedFiles(run);
    assert.ok(c.includes('src/price.js'));
    assert.ok(c.includes('src/new-untracked.js'));
  } finally { cleanup(); }
});

test('a fixture .git that is a file (gitfile) or a symlink is refused: error, never passed', () => {
  const { run, f, cleanup } = makeRun('G1');
  try {
    const gd = path.join(f.fixtureDir, '.git');
    const moved = `${gd}-moved`;
    fs.renameSync(gd, moved);
    fs.writeFileSync(gd, `gitdir: ${moved}\n`);
    const ev = evaluate(run);
    assert.equal(ev.verdict, 'error');
    fs.rmSync(gd);
    fs.symlinkSync(moved, gd);
    assert.equal(evaluate(run).verdict, 'error');
    fs.rmSync(gd);
    fs.renameSync(moved, gd);
  } finally { cleanup(); }
});
