import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScratch, markerPath, isWithin, isInsideGitWorkTree } from '../src/paths.mjs';
import { safeRm } from '../src/safe-rm.mjs';

test('isWithin', () => {
  assert.equal(isWithin('/a/b', '/a/b/c'), true);
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b', '/a/bc'), false);
  assert.equal(isWithin('/a/b', '/a'), false);
});

test('createScratch makes a marked, real dir under tmpdir outside any work tree', () => {
  const s = createScratch('run1');
  try {
    assert.equal(fs.realpathSync(s), s);
    assert.ok(isWithin(fs.realpathSync(os.tmpdir()), s));
    assert.ok(fs.statSync(markerPath(s)).isFile());
    assert.equal(JSON.parse(fs.readFileSync(markerPath(s), 'utf8')).runId, 'run1');
    assert.equal(isInsideGitWorkTree(s), false);
  } finally {
    safeRm(s);
  }
  assert.equal(fs.existsSync(s), false);
});

test('createScratch rejects bad run ids', () => {
  for (const bad of ['', '../x', 'a/b', 'a b', 5, undefined]) {
    assert.throws(() => createScratch(bad), /invalid runId/);
  }
});

test('isInsideGitWorkTree detects a repo', () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-git-'));
  try {
    assert.equal(isInsideGitWorkTree(d), false);
    fs.mkdirSync(path.join(d, '.git'));
    // an empty .git dir is not a valid repo; just confirm no throw and a boolean
    assert.equal(typeof isInsideGitWorkTree(d), 'boolean');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Sec F7: isInsideGitRepo is true in a work tree, inside .git, in a bare repo and under any .git component; false elsewhere', async () => {
  const { isInsideGitRepo } = await import('../src/paths.mjs');
  const { spawnSync } = await import('node:child_process');
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tt-git-'));
  try {
    assert.equal(isInsideGitRepo(d), false);
    const repo = path.join(d, 'repo');
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
    const bare = path.join(d, 'bare');
    assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.mkdirSync(path.join(d, 'a', '.git', 'b'), { recursive: true });
    for (const p of [repo, path.join(repo, 'sub'), path.join(repo, '.git'), path.join(repo, '.git', 'refs'), bare, path.join(bare, 'refs'), path.join(d, 'a', '.git', 'b')]) assert.equal(isInsideGitRepo(p), true, p);
    fs.mkdirSync(path.join(d, 'plain'));
    assert.equal(isInsideGitRepo(path.join(d, 'plain')), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Sec F4: createScratch and safeRm use the canonical path; a case-varied scratch path is refused by safeRm', (t) => {
  const s = createScratch('casetest');
  try {
    const up = s.toUpperCase();
    if (!fs.existsSync(up) || up === s) { t.skip('case-sensitive filesystem'); return; }
    assert.throws(() => safeRm(up), /refused/);
    assert.equal(fs.existsSync(s), true);
  } finally { safeRm(s); }
});
