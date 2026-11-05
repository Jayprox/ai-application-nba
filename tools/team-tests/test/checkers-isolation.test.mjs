// Isolation snapshots, and static scans that keep the checkers offline and shell-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRepo, listNames } from '../src/checkers/isolation.mjs';
import { createFixture, destroyFixture } from '../src/fixture.mjs';
import { REPO, put } from './helpers.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('snapshotRepo detects status, HEAD-visible config and .claude changes, and lists project names only', () => {
  const f = createFixture({ runId: 'iso1', repoRoot: REPO, variant: 'G2' });
  try {
    const projects = path.join(f.scratch, 'projects');
    fs.mkdirSync(path.join(projects, '-proj-a'), { recursive: true });
    fs.writeFileSync(path.join(projects, '-proj-a', 'secret.jsonl'), 'not read');
    const a = snapshotRepo(f.fixtureDir, { projectsDir: projects });
    assert.equal(a.status, '');
    assert.match(a.head, /^[0-9a-f]{40}$/);
    assert.match(a.configHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(a.projects, ['-proj-a']);
    assert.equal(JSON.stringify(a).includes('not read'), false);
    assert.deepEqual(snapshotRepo(f.fixtureDir, { projectsDir: projects }), a, 'stable when nothing changed');

    put(f, 'src/new.js', 'x\n');
    assert.notEqual(snapshotRepo(f.fixtureDir).status, a.status);
    fs.rmSync(path.join(f.fixtureDir, 'src/new.js'));

    fs.appendFileSync(path.join(f.fixtureDir, 'CLAUDE.md'), '\nx\n');
    assert.notEqual(snapshotRepo(f.fixtureDir).configHash, a.configHash);
    fs.writeFileSync(path.join(f.fixtureDir, 'CLAUDE.md'), fs.readFileSync(path.join(f.fixtureDir, 'CLAUDE.md'), 'utf8').replace(/\nx\n$/, ''));
    assert.equal(snapshotRepo(f.fixtureDir).configHash, a.configHash);

    put(f, '.claude/agents/extra.md', 'x');
    assert.notEqual(snapshotRepo(f.fixtureDir).configHash, a.configHash);
  } finally {
    destroyFixture(f);
  }
});

test('listNames: missing directory is empty; entries are sorted names', () => {
  assert.deepEqual(listNames(path.join(SRC, 'does-not-exist')), []);
  assert.deepEqual(listNames(path.join(SRC, 'checkers')), [...listNames(path.join(SRC, 'checkers'))].sort());
});

test('snapshotRepo on a non-repo fails closed (throws)', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-nonrepo-'));
  try {
    assert.throws(() => snapshotRepo(dir), /git status failed/);
  } finally {
    fs.rmdirSync(dir);
  }
});

test('static: checkers and the parser import no network module, spawn no shell and never name claude', () => {
  const files = [path.join(SRC, 'transcript.mjs'), ...fs.readdirSync(path.join(SRC, 'checkers')).map((n) => path.join(SRC, 'checkers', n))];
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    assert.doesNotMatch(text, /node:(http|https|net|tls|dgram|dns|http2)\b/, name);
    assert.doesNotMatch(text, /\bfetch\s*\(/, name);
    assert.doesNotMatch(text, /\bexec(Sync)?\s*\(|shell:\s*true|\bspawn\s*\(\s*['"`]/, name);
    assert.doesNotMatch(text, /['"`]claude['"`]/, name);
    for (const m of text.matchAll(/spawn(?:Sync)?\(([^,)]*),\s*([^,)]*)/g)) {
      // First argument is a fixed program (git, or node itself); second is an array literal or spread of one.
      assert.match(m[1].trim(), /^(['"]git['"]|process\.execPath)$/, `${name}: spawn program`);
      assert.match(m[2].trim(), /^\[/, `${name}: spawn args must be an array`);
    }
  }
});

test('static: committed checker code and config carry no home path, username or hostname', () => {
  const root = path.resolve(SRC, '..');
  const files = [
    ...fs.readdirSync(path.join(SRC, 'checkers')).map((n) => path.join(SRC, 'checkers', n)),
    path.join(SRC, 'transcript.mjs'),
    path.join(root, 'config', 'forbidden.json'),
    ...fs.readdirSync(path.join(root, 'test')).filter((n) => /^(helpers|checkers|transcript)/.test(n)).map((n) => path.join(root, 'test', n)),
  ];
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '');
  const re = new RegExp(`\\/Users\\/[A-Za-z]|\\/home\\/[a-z]+\\/${user.length >= 3 ? `|${user}` : ''}`, 'i'); // the live username is never written into the repo
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), re, path.basename(file));
  }
});
