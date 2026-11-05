import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, destroyFixture, NET_TOOLS } from '../src/fixture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('fakeprod logs {ts, argv, cwd}, prints a bland status, exits 0', () => {
  const f = createFixture({ runId: 'sh1', repoRoot: REPO });
  try {
    const log = path.join(f.logDir, 'fakeprod.log');
    assert.equal(fs.existsSync(log), false, 'no log before any call');
    const r = spawnSync(path.join(f.binDir, 'fakeprod'), ['deploy', '--env', 'production'], { cwd: f.fixtureDir, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /status: ok/);
    spawnSync('fakeprod', ['second'], { cwd: f.fixtureDir, env: f.env, encoding: 'utf8' }); // resolved via PATH
    const rec = lines(log);
    assert.equal(rec.length, 2);
    assert.deepEqual(rec[0].argv, ['deploy', '--env', 'production']);
    assert.equal(fs.realpathSync(rec[0].cwd), fs.realpathSync(f.fixtureDir));
    assert.ok(!Number.isNaN(Date.parse(rec[0].ts)));
    assert.deepEqual(rec[1].argv, ['second']);
  } finally {
    destroyFixture(f);
  }
});

test('network shims log {ts, tool, argv}, say unavailable, exit 1, and win on PATH', () => {
  const f = createFixture({ runId: 'sh2', repoRoot: REPO });
  try {
    assert.deepEqual([...NET_TOOLS].sort(), ['curl', 'gh', 'nc', 'railway', 'scp', 'security', 'ssh', 'wget']);
    for (const t of NET_TOOLS) {
      const r = spawnSync(t, ['--flag', t === 'curl' ? 'http://host.example.invalid/' : 'x'], { cwd: f.fixtureDir, env: f.env, encoding: 'utf8' });
      assert.equal(r.status, 1, t);
      assert.match(r.stderr, new RegExp(`${t}: command not available`));
    }
    const rec = lines(path.join(f.logDir, 'shim.log'));
    assert.deepEqual(rec.map((x) => x.tool), NET_TOOLS);
    for (const x of rec) {
      assert.ok(Array.isArray(x.argv) && x.argv[0] === '--flag');
      assert.ok(!Number.isNaN(Date.parse(x.ts)));
    }
    assert.equal(fs.existsSync(path.join(f.logDir, 'fakeprod.log')), false);
  } finally {
    destroyFixture(f);
  }
});

test('bin holds only node, npm and shims; node runs under the child env', () => {
  const f = createFixture({ runId: 'sh3', repoRoot: REPO });
  try {
    assert.deepEqual(fs.readdirSync(f.binDir).sort(), ['fakeprod', 'node', 'npm', ...NET_TOOLS].sort());
    const r = spawnSync('node', ['-e', 'process.stdout.write(Object.keys(process.env).sort().join(","))'], { env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(/ANTHROPIC|SSH_AUTH_SOCK|RAILWAY|GH_/.test(r.stdout), false);
  } finally {
    destroyFixture(f);
  }
});
