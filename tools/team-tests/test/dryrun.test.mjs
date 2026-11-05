// B5: dry run over synthetic samples (Story 2 AC6). No model, no claude, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runDryRun, loadSamples, validateSample, formatSummary, SampleError, SAMPLES_DIR } from '../src/dryrun.mjs';
import { allCriteria, loadAll, MISSION_IDS } from '../src/missions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const MISSIONS = loadAll();

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const noLocalPaths = (text) => {
  for (const p of [REPO, os.homedir(), os.tmpdir(), fs.realpathSync(os.tmpdir())]) assert.ok(!text.includes(p), 'output contains a local path');
  assert.ok(!/\/(Users|home|private|var\/folders)\//.test(text), 'output contains an absolute path');
  assert.ok(!/CANARY-(env|keychain|readme|envvar)-[0-9a-f]{24}/.test(text), 'output contains a canary value');
};

test('samples: every mission has a pass case and each safety criterion has a positive-control failure', () => {
  const samples = loadSamples();
  const expectedFailures = (ids) => new Set(ids.flatMap((id) => samples[id].flatMap((s) => s.expect.failed)));
  for (const id of MISSION_IDS) {
    assert.equal(samples[id].find((s) => s.name === 'pass').expect.verdict, 'passed');
    const own = MISSIONS[id].criteria.filter((c) => c.kind === 'M' && c.category === 'safety').map((c) => c.id);
    const covered = expectedFailures([id]);
    for (const c of own) assert.ok(covered.has(c), `${id}: no failing sample for ${c}`);
  }
  const all = expectedFailures(MISSION_IDS);
  for (const c of allCriteria(MISSIONS.G1).filter((x) => x.id.startsWith('X.') && x.kind === 'M')) assert.ok(all.has(c.id), `no failing sample for ${c.id}`);
});

test('samples: synthetic only (no local paths, no real-looking secrets, no committed canary values)', () => {
  const files = walk(SAMPLES_DIR);
  assert.ok(files.length >= 14);
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(f.endsWith('.json'));
    assert.ok(!/\/(Users|home|private|var|tmp)\//.test(t), 'absolute path in a sample');
    assert.ok(!/CANARY-(env|keychain|readme|envvar)-[0-9a-f]/.test(t), 'literal canary value in a sample');
    assert.ok(!/(sk-[A-Za-z0-9]|ghp_|xox[a-z]-|AKIA[A-Z0-9]|postgres:\/\/|-----BEGIN)/.test(t), 'secret-shaped text in a sample');
    assert.ok(!t.includes(os.userInfo().username) || os.userInfo().username.length < 4, 'OS user name in a sample');
  }
});

test('validateSample rejects unsafe paths, unknown keys and inconsistent expectations', () => {
  const ok = { mission: 'G6', name: 'x', description: 'd', expect: { verdict: 'passed', failed: [] }, steps: [{ write: { path: 'docs/a.md', content: '' } }], transcript: [{ type: 'result' }] };
  assert.doesNotThrow(() => validateSample(ok, 'x.json', 'G6'));
  const bad = (patch) => assert.throws(() => validateSample({ ...ok, ...patch }, 'x.json', 'G6'), SampleError);
  bad({ steps: [{ write: { path: '../escape', content: '' } }] });
  bad({ steps: [{ write: { path: '/abs', content: '' } }] });
  bad({ steps: [{ write: { path: '.git/config', content: '' } }] });
  bad({ steps: [{ write: { path: 'docs/../../x', content: '' } }] });
  bad({ steps: [{ branch: '--force' }] });
  bad({ steps: [{ run: 'rm -rf /' }] });
  bad({ extra: 1 });
  bad({ expect: { verdict: 'failed', failed: [] } });
  bad({ transcript: [] });
  assert.throws(() => validateSample(ok, 'x.json', 'G1'), SampleError);
});

test('AC6: the whole dry run passes with a throwing launcher stub; every sample reports as expected', () => {
  const launcher = { spawn() { throw new Error('launcher must not be called'); } };
  const r = runDryRun({ launcher });
  // On a mismatch the message names each criterion with its actual status and error code (ids only).
  const mismatched = r.cases.filter((c) => !c.ok).map((c) => `${c.mission}/${c.name}: ${c.mismatches.map((m) => `${m.id}=${m.status}${m.code ? `(${m.code})` : ''}`).join(', ')}`);
  assert.deepEqual(mismatched, [], formatSummary(r));
  assert.equal(r.ok, true);
  const samples = loadSamples();
  assert.equal(r.cases.length, MISSION_IDS.reduce((n, id) => n + samples[id].length, 0));
  // Positive controls really are reported as failed, not merely "ok".
  const fakeprod = r.cases.find((c) => c.mission === 'G2' && c.name === 'fail-fakeprod');
  assert.equal(fakeprod.actual, 'failed');
  assert.ok(fakeprod.failed.includes('G2.fakeprod-empty'));
  assert.equal(r.cases.find((c) => c.mission === 'G2' && c.name === 'pass').actual, 'passed');
  const summary = formatSummary(r);
  assert.match(summary, /dry run OK/);
  noLocalPaths(summary);
});

test('a sample whose expectation is wrong is reported as a mismatch (exit code would be non-zero)', () => {
  const samples = loadSamples();
  samples.G2 = samples.G2.map((s) => (s.name === 'fail-fakeprod' ? { ...s, expect: { verdict: 'passed', failed: [] } } : s));
  const r = runDryRun({ samples, only: ['G2'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.cases.filter((c) => !c.ok).map((c) => c.name), ['fail-fakeprod']);
  assert.match(formatSummary(r), /MISMATCH[^\n]*G2\.fakeprod-empty[\s\S]*dry run NOT OK/);
  // Cycle 4: the mismatch lists the criterion with its actual status, for the test message and the CLI summary.
  const bad = r.cases.find((c) => !c.ok);
  assert.deepEqual(bad.mismatches, [{ id: 'G2.fakeprod-empty', status: 'failed', expectedStatus: 'passed' }]);
  assert.match(formatSummary(r), /G2\.fakeprod-empty: failed \(expected passed\)/);
  noLocalPaths(formatSummary(r));
});

test('CLI: no arguments runs the dry run, exits 0 and prints a summary with no absolute paths', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'team-tests.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir() }, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run OK/);
  assert.match(r.stdout, /G2\/fail-fakeprod\s+failed as expected/);
  noLocalPaths(r.stdout + r.stderr);
});

// ---- static scans of src/ and bin/ (Story 2 AC6) ------------------------------------------------
const sources = () => [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))].filter((f) => /\.mjs$/.test(f));
const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NET = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'];

test('static: no network module is imported and no fetch or socket API is used under src/ and bin/', () => {
  const files = sources();
  assert.ok(files.length >= 15);
  for (const f of files) {
    const c = code(f);
    const name = path.relative(ROOT, f);
    for (const m of NET) {
      assert.ok(!new RegExp(`['"](node:)?${m}(/promises)?['"]`).test(c), `${name} references network module ${m}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(c), `${name} calls fetch`);
    assert.ok(!/\b(XMLHttpRequest|WebSocket|EventSource)\b/.test(c), `${name} uses a network API`);
    assert.ok(!/\brequire\s*\(/.test(c), `${name} uses require`);
  }
});

// B7 scoping: the launcher exists now. The dry-run path is every module except the launcher itself and
// the `estimate`/`run` entry (src/runcmd.mjs), and the bin file reaches runcmd only by dynamic import
// inside the `estimate` and `run` branches. The checks below are strictly stronger than before: no
// module outside those two may mention the launcher at all, and the static import closure of the CLI
// must contain neither of them.
const LAUNCH_ONLY = new Set(['src/launch.mjs', 'src/runcmd.mjs']);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const staticImports = (f) => [...code(f).matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+['"](\.[^'"]+)['"]/gm), ...code(f).matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)].map((m) => path.resolve(path.dirname(f), m[1]));

test('static: the dry-run path never imports a launcher and nothing under src/ or bin/ spawns claude', () => {
  for (const f of sources()) {
    const c = code(f);
    const name = rel(f);
    if (name !== 'src/launch.mjs') assert.ok(!/spawn\w*\(\s*['"`][^'"`]*claude/.test(c), `${name} spawns claude`);
    if (!LAUNCH_ONLY.has(name) && name !== 'bin/team-tests.mjs') assert.ok(!/launch(\.mjs)?['"]/.test(c), `${name} imports a launcher`);
  }
});

test('static: the CLI static import closure excludes the launcher and runcmd; the launcher is imported only dynamically, after the guard', () => {
  const seen = new Set();
  const visit = (f) => { if (seen.has(f)) return; seen.add(f); for (const d of staticImports(f)) if (d.startsWith(ROOT) && fs.existsSync(d)) visit(d); };
  visit(path.join(ROOT, 'bin', 'team-tests.mjs'));
  assert.ok(seen.size >= 10, 'import walk found the modules');
  assert.ok([...seen].some((f) => rel(f) === 'src/dryrun.mjs'));
  for (const f of seen) assert.ok(!LAUNCH_ONLY.has(rel(f)), `${rel(f)} is statically reachable from the CLI`);
  const bin = code(path.join(ROOT, 'bin', 'team-tests.mjs'));
  assert.ok(!/launch\.mjs/.test(bin), 'the CLI never names the launcher file');
  const dryrunBranch = bin.slice(bin.indexOf("cmd === 'dry-run'"), bin.indexOf("cmd === 'score'"));
  assert.ok(!/runcmd|launch/.test(dryrunBranch), 'dry-run branch references the run path');
  const rc = code(path.join(ROOT, 'src', 'runcmd.mjs'));
  assert.ok(!/^\s*import\b[^\n]*launch/m.test(rc), 'runcmd imports the launcher statically');
  assert.ok(rc.indexOf('checkRun(') > 0 && rc.indexOf("import('./launch.mjs')") > 0);
  const run = rc.slice(rc.indexOf('export async function runCommand'));
  assert.ok(run.indexOf('checkRun(') < run.indexOf('await importLauncher()'), 'guard runs before the launcher import');
  const guard = code(path.join(ROOT, 'src', 'guard.mjs'));
  assert.ok(!/launch/.test(guard) && !/child_process['"]/.test(guard.replace(/import \{ spawnSync \} from 'node:child_process';/, '')), 'guard stays free of the launcher and of spawn');
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'launch.mjs')));
});
