import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScratch, MARKER_NAME, MARKER_TOOL } from '../src/paths.mjs';
import { safeRm, SafeRmRefusal } from '../src/safe-rm.mjs';

const tmp = () => fs.realpathSync(os.tmpdir());
const mk = (prefix = 'team-tests-') => fs.mkdtempSync(path.join(tmp(), prefix));
const mark = (d) => fs.writeFileSync(path.join(d, MARKER_NAME), JSON.stringify({ tool: MARKER_TOOL }));
const refuses = (p, re) =>
  assert.throws(() => safeRm(p), (e) => e instanceof SafeRmRefusal && re.test(e.reason));

test('positive: removes a marked scratch root and its contents', () => {
  const s = createScratch('pos');
  fs.mkdirSync(path.join(s, 'fixture/sub'), { recursive: true });
  fs.writeFileSync(path.join(s, 'fixture/sub/f.txt'), 'x');
  safeRm(s);
  assert.equal(fs.existsSync(s), false);
});

test('refuses a directory without a marker', () => {
  const d = mk();
  try {
    refuses(d, /marker file missing/);
    assert.ok(fs.existsSync(d));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('refuses an invalid or foreign marker, or a marker that is a directory', () => {
  const d = mk();
  try {
    fs.writeFileSync(path.join(d, MARKER_NAME), 'not json');
    refuses(d, /marker is not valid/);
    fs.writeFileSync(path.join(d, MARKER_NAME), JSON.stringify({ tool: 'other' }));
    refuses(d, /marker is not valid/);
    fs.rmSync(path.join(d, MARKER_NAME));
    fs.mkdirSync(path.join(d, MARKER_NAME));
    refuses(d, /not a regular file/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('refuses a marked directory outside os.tmpdir()', () => {
  const root = mk('tt-outer-');
  const inside = path.join(root, 'tmproot');
  const outside = path.join(root, 'team-tests-outside');
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  mark(outside);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = inside;
  try {
    assert.equal(fs.realpathSync(os.tmpdir()), inside);
    refuses(outside, /outside os\.tmpdir/);
    assert.ok(fs.existsSync(outside));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses os.tmpdir() itself, relative paths, missing paths, files', () => {
  refuses(tmp(), /outside os\.tmpdir|lacks scratch prefix|marker/);
  assert.throws(() => safeRm('relative/path'), SafeRmRefusal);
  assert.throws(() => safeRm(''), SafeRmRefusal);
  assert.throws(() => safeRm(undefined), SafeRmRefusal);
  refuses(path.join(tmp(), 'team-tests-does-not-exist'), /does not exist/);
  const d = mk();
  try {
    const f = path.join(d, 'file');
    fs.writeFileSync(f, 'x');
    refuses(f, /not a directory/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('refuses a symlink to a marked scratch root and leaves the target intact', () => {
  const real = createScratch('link');
  const link = path.join(tmp(), `team-tests-link-${process.pid}`);
  fs.symlinkSync(real, link);
  try {
    refuses(link, /symlink/);
    assert.ok(fs.existsSync(path.join(real, MARKER_NAME)));
  } finally {
    fs.unlinkSync(link);
    safeRm(real);
  }
});

test('refuses a path that crosses a symlinked parent', () => {
  const real = createScratch('parent');
  const link = path.join(tmp(), `team-tests-plink-${process.pid}`);
  fs.symlinkSync(real, link);
  const sub = path.join(real, 'team-tests-sub');
  fs.mkdirSync(sub);
  mark(sub);
  try {
    refuses(path.join(link, 'team-tests-sub'), /crosses a symlink/);
    assert.ok(fs.existsSync(sub));
  } finally {
    fs.unlinkSync(link);
    safeRm(real);
  }
});

test('does not follow a symlink inside the tree', () => {
  const victim = mk('tt-victim-');
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
  const s = createScratch('inner');
  fs.symlinkSync(victim, path.join(s, 'escape'));
  try {
    safeRm(s);
    assert.equal(fs.existsSync(s), false);
    assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(victim, { recursive: true, force: true });
  }
});

test('refuses a marked dir whose name lacks the scratch prefix', () => {
  const d = mk('other-');
  mark(d);
  try {
    refuses(d, /prefix/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
