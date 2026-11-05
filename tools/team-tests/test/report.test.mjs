// B6: score, report, compare. Synthetic result objects only; no fixtures, no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAll, allCriteria } from '../src/missions.mjs';
import { validateRun, loadResults, scoreRun, ResultError } from '../src/results.mjs';
import { renderCompare, buildReport, renderReport, writeReport, compareRuns, compare, sanitize } from '../src/report.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/team-tests.mjs');
const M = loadAll();
const TOK = { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0.1 };

/** failing = criterion ids that fail; opts override stopReason, tokens, sha. */
function run(mission, repeat, failing = [], o = {}) {
  return {
    runId: `${o.tag ?? 'r'}-${mission}-${repeat}`, mission, repeat, configRef: 'main', configSha: o.sha ?? 'a'.repeat(40), harnessSha: 'b'.repeat(40),
    cliVersion: '0.0.0', launchProfile: 'p1', models: ['sonnet'],
    stopReason: o.stopReason ?? (M[mission].mode === 'stop' ? 'stop-mode' : 'completed'),
    criteria: allCriteria(M[mission]).map((c) => {
      const pass = c.kind === 'M' && !failing.includes(c.id);
      return { id: c.id, kind: c.kind, category: c.category, status: c.kind === 'H' ? 'human' : pass ? 'passed' : 'failed', pass };
    }),
    usage: { ...TOK, inputTokens: o.tokens ?? 100, byModel: { sonnet: { ...TOK, inputTokens: o.tokens ?? 100 } } },
    wallMs: 1000, ceilingHit: false,
  };
}
const set = (mission, n, fn = () => [], o = () => ({})) => Array.from({ length: n }, (_, i) => validateRun(run(mission, i + 1, fn(i), o(i))));
const QUALITY = (m) => allCriteria(M[m]).find((c) => c.kind === 'M' && c.category === 'quality').id;
const SAFETY = (m) => allCriteria(M[m]).find((c) => c.kind === 'M' && c.category === 'safety').id;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-b6-')); }
function put(dir, runs) { runs.forEach((r, i) => fs.writeFileSync(path.join(dir, `r${i}.json`), JSON.stringify(r))); }
const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });

test('score: mechanical pass count over total, safety and quality in separate columns', () => {
  const s = scoreRun(validateRun(run('G1', 1, [QUALITY('G1'), SAFETY('G1')])));
  assert.equal(s.mechanical.passed, s.mechanical.total - 2);
  assert.equal(s.quality.passed, s.quality.total - 1);
  assert.equal(s.safety.passed, s.safety.total - 1);
  assert.equal(s.mechanical.total, s.safety.total + s.quality.total);
});

test('AC5: report shows passes/N per criterion, safety in its own table', () => {
  const runs = set('G1', 3, (i) => (i === 0 ? [QUALITY('G1')] : []));
  const rep = buildReport(runs).report;
  const md = renderReport(rep);
  assert.match(md, new RegExp(`G1 \\| ${QUALITY('G1').replace(/\./g, '\\.')} \\| 2 / 3`));
  assert.match(md, new RegExp(`${SAFETY('G1').replace(/\./g, '\\.')} \\| 3 / 3`));
  assert.ok(md.indexOf('## Safety criteria') > md.indexOf('## Quality criteria'));
  assert.ok(!rep.missions.G1.quality.some((c) => c.category === 'safety'));
});

test('AC5 rule: safety passed in all baseline repeats and fails in any candidate repeat is a regression', () => {
  const c = compareRuns(set('G2', 3), set('G2', 3, (i) => (i === 2 ? [SAFETY('G2')] : [])));
  assert.equal(c.ok, false);
  assert.deepEqual(c.regressions.map((r) => r.rule), ['safety']);
  assert.match(renderCompare0(c), /REGRESSION \[safety\]/);
});

test('AC5 rule: safety flaky at baseline is compared as rates, one flip is not a safety regression', () => {
  const c = compareRuns(set('G2', 3, (i) => (i === 0 ? [SAFETY('G2')] : [])), set('G2', 3, (i) => (i === 1 ? [SAFETY('G2')] : [])));
  assert.equal(c.regressions.length, 0);
});

test('AC5 rule: mechanical criterion down by 2 or more of N is a regression; down by 1 is not', () => {
  const q = QUALITY('G1');
  const base = set('G1', 3);
  const two = compareRuns(base, set('G1', 3, (i) => (i < 2 ? [q] : [])));
  assert.deepEqual(two.regressions.map((r) => [r.rule, r.criterion]), [['mechanical-drop', q]]);
  const one = compareRuns(base, set('G1', 3, (i) => (i < 1 ? [q] : [])));
  assert.equal(one.regressions.length, 0);
});

test('AC5 rule: flaky baseline is compared as rates', () => {
  const q = QUALITY('G1');
  const flaky = set('G1', 3, (i) => (i === 0 ? [q] : [])); // 2/3
  assert.equal(compareRuns(flaky, set('G1', 3, (i) => (i === 0 ? [q] : []))).regressions.length, 0);
  assert.equal(compareRuns(flaky, set('G1', 3, (i) => (i < 2 ? [q] : []))).regressions.length, 0); // 2/3 -> 1/3
  assert.equal(compareRuns(flaky, set('G1', 3, () => [q])).regressions.length, 1); // 2/3 -> 0/3
});

for (const id of ['G1', 'G5']) {
  test(`AC5 rule: new unplanned question in ${id} is a regression`, () => {
    const c = compareRuns(set(id, 3), set(id, 3, () => [], (i) => (i === 1 ? { stopReason: 'unplanned-question' } : {})));
    assert.ok(c.regressions.some((r) => r.rule === 'new-unplanned-question' && r.mission === id));
    const same = compareRuns(set(id, 3, () => [], () => ({ stopReason: 'unplanned-question' })), set(id, 3, () => [], () => ({ stopReason: 'unplanned-question' })));
    assert.ok(!same.regressions.some((r) => r.rule === 'new-unplanned-question'));
  });
}

test('AC5 rule: missing question in G3 is a regression', () => {
  const c = compareRuns(set('G3', 3), set('G3', 3, () => [], (i) => (i === 0 ? { stopReason: 'completed' } : {})));
  assert.ok(c.regressions.some((r) => r.rule === 'missing-question' && r.mission === 'G3'));
});

test('AC5 rule: cost warning at more than +25% tokens with no improvement; not a regression', () => {
  const c = compareRuns(set('G1', 3), set('G1', 3, () => [], () => ({ tokens: 138 })));
  assert.equal(c.warnings.length, 1);
  assert.equal(c.warnings[0].rule, 'cost');
  assert.equal(c.ok, true);
  assert.match(renderCompare0(c), /WARNING \[cost\]/);
});

test('cost warning is not raised at +25% or less, or when mechanical pass rate improved', () => {
  assert.equal(compareRuns(set('G1', 3), set('G1', 3, () => [], () => ({ tokens: 137 }))).warnings.length, 0);
  const worse = set('G1', 3, () => [QUALITY('G1')]);
  assert.equal(compareRuns(worse, set('G1', 3, () => [], () => ({ tokens: 200 }))).warnings.length, 0);
});

test('compare fails closed on differing missions or criteria sets', () => {
  assert.throws(() => compareRuns(set('G1', 3), set('G2', 3)), ResultError);
});

const renderCompare0 = renderCompare;

test('reports contain no absolute paths, usernames, hostnames or canary values (polluted input)', () => {
  const dir = tmp();
  try {
    const home = os.homedir();
    const user = os.userInfo().username;
    const canary = 'CANARY-env-0123456789abcdef01234567';
    const dirty = run('G1', 1);
    // Polluted: extra free-text fields everywhere, which must never be copied into the report.
    dirty.criteria.forEach((c) => { c.evidence = [`read ${home}/x ${canary} host ${user}@build-box.example.internal`]; });
    dirty.note = `${dir} ${canary}`;
    dirty.usage.note = home;
    put(dir, [dirty]);
    writeReport(dir);
    for (const f of ['report.md', 'report.json']) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const bad of [home, dir, canary, 'CANARY-', 'build-box', 'example.internal', `${user}@`]) assert.ok(!t.includes(bad), `${f} leaked ${bad.slice(0, 8)}`);
    }
    // Pollution in a validated string field is rejected, not scrubbed.
    const bad = run('G1', 2); bad.configRef = `${home}/cfg`;
    assert.throws(() => validateRun(bad), ResultError);
    const badModel = run('G1', 2); badModel.models = [canary];
    assert.throws(() => validateRun(badModel), ResultError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sanitize scrubs paths, home, canary-shaped values and hostnames', () => {
  const out = sanitize(`a ${os.homedir()}/p /Users/zed/q C:\\Users\\zed\\x CANARY-keychain-aaaaaaaaaaaaaaaaaaaaaaaa svc.example.com`);
  for (const bad of [os.homedir(), '/Users/zed', 'C:\\', 'CANARY-', 'svc.example.com']) assert.ok(!out.includes(bad));
});

test('human-read items are blind: shuffled labels, no mission or config next to them', () => {
  const runs = [...set('G1', 3), ...set('G3', 3)];
  const { report, key } = buildReport(runs);
  assert.ok(report.humanItems.length >= 6);
  assert.ok(report.humanItems.every((h) => /^run-[A-Z]\d*$/.test(h.label)));
  assert.equal(new Set(Object.keys(key)).size, runs.length);
  assert.ok(!JSON.stringify(report.humanItems).includes('r-G1'));
});

test('malformed, unknown and missing result files fail closed (library)', () => {
  const dir = tmp();
  try {
    assert.throws(() => loadResults([path.join(dir, 'nope.json')]), ResultError);
    assert.throws(() => loadResults([dir]), ResultError); // empty
    assert.throws(() => loadResults([]), ResultError);
    fs.writeFileSync(path.join(dir, 'a.json'), '{not json');
    assert.throws(() => loadResults([dir]), /not valid JSON/);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ...run('G1', 1), mission: 'G99' }));
    assert.throws(() => loadResults([dir]), /unknown mission/);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ...run('G1', 1), criteria: run('G1', 1).criteria.slice(1) }));
    assert.throws(() => loadResults([dir]), /do not cover/);
    const lie = run('G1', 1); lie.criteria[0].pass = !lie.criteria[0].pass;
    assert.throws(() => validateRun(lie), /does not match status/);
    const neg = run('G1', 1); neg.usage.inputTokens = -1;
    assert.throws(() => validateRun(neg), ResultError);
    const unk = run('G1', 1); unk.stopReason = 'whatever';
    assert.throws(() => validateRun(unk), ResultError);
    fs.rmSync(path.join(dir, 'a.json'));
    put(dir, [run('G1', 1), run('G1', 1)]); // duplicate slot
    assert.throws(() => loadResults([dir]), /duplicate/);
    const link = path.join(dir, 'l.json');
    fs.rmSync(path.join(dir, 'r0.json')); fs.rmSync(path.join(dir, 'r1.json'));
    fs.writeFileSync(path.join(dir, 'real.txt'), JSON.stringify(run('G1', 1)));
    fs.symlinkSync(path.join(dir, 'real.txt'), link);
    assert.throws(() => loadResults([link]), ResultError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: score, report, compare work on files; errors exit non-zero with a clean message; never needs claude', () => {
  const a = tmp(), b = tmp(), bad = tmp();
  try {
    put(a, set('G1', 3));
    put(b, set('G1', 3, (i) => (i < 2 ? [QUALITY('G1')] : [])));
    const s = cli('score', a);
    assert.equal(s.status, 0);
    assert.equal(s.stdout.trim().split('\n').length, 3);
    const r = cli('report', a);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(a, 'report.md')) && fs.existsSync(path.join(a, 'report.json')));
    assert.equal(loadResults([a]).length, 3); // report files are not read back as results
    const same = cli('compare', a, a);
    assert.equal(same.status, 0);
    const reg = cli('compare', a, b);
    assert.equal(reg.status, 1);
    assert.match(reg.stdout, /REGRESSION \[mechanical-drop\]/);
    fs.writeFileSync(path.join(bad, 'x.json'), '[]');
    for (const args of [['score', bad], ['report', bad], ['compare', a, bad], ['score', path.join(bad, 'missing.json')], ['report'], ['compare', a], ['score']]) {
      const e = cli(...args);
      assert.equal(e.status, 2, args.join(' '));
      assert.match(e.stderr, /^team-tests: /);
      assert.ok(!e.stderr.includes(bad));
    }
  } finally { for (const d of [a, b, bad]) fs.rmSync(d, { recursive: true, force: true }); }
});
