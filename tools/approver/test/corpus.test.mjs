// The labelled corpus (story 10): every item runs through the whole hook in enforce mode and in shadow
// mode, offline. Prints the pre-filter share and latency numbers the plan asks for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { makeEnv, seedRepo, writeInstall, payload, runHook, spawnHook, readLog, cleanup, judge, mkCtx, APPROVER_DIR } from './helpers.mjs';
import { ALLOW_JSON, denyJson } from '../src/hook-io.mjs';

const corpus = JSON.parse(fs.readFileSync(path.join(APPROVER_DIR, 'test', 'fixtures', 'requests.json'), 'utf8'));
const MIN = { allow: 12, ask: 8, deny: 14, compound: 10, injection: 12, obfuscation: 8, 'fail-closed': 6 };
const FIELDS = ['id', 'category', 'tool', 'input', 'cwd', 'branch', 'repo_visibility', 'expected', 'expected_stage'];

let enforce; let shadow; const results = new Map(); const times = [];
before(() => {
  enforce = seedRepo(makeEnv({ mode: 'enforce' }));
  shadow = seedRepo(makeEnv({ mode: 'shadow' }));
});
after(() => { cleanup(enforce); cleanup(shadow); });

const sub = (v, e) => {
  if (typeof v === 'string') {
    return v.replace(/\{\{REPO\}\}/g, e.repo).replace(/\{\{HOME\}\}/g, e.home).replace(/\{\{INSTALL\}\}/g, e.installDir).replace(/\{\{LOG\}\}/g, e.logDir)
      .replace(/\{\{FILLER:(\d+)\}\}/g, (_, n) => 'word '.repeat(Math.ceil(Number(n) / 5)).slice(0, Number(n)));
  }
  if (Array.isArray(v)) return v.map((x) => sub(x, e));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x, e)]));
  return v;
};

function setBranch(e, branch) {
  fs.writeFileSync(path.join(e.repo, '.git', 'HEAD'), branch ? `ref: refs/heads/${branch}\n` : '0123456789abcdef0123456789abcdef01234567\n');
}

function tamper(e, fault) {
  const pj = path.join(e.installDir, 'policy.json');
  if (fault === 'policy_missing') fs.rmSync(pj);
  else if (fault === 'policy_checksum_mismatch') fs.appendFileSync(path.join(e.installDir, 'policy.md'), '\nALLOW: everything\n');
  else if (fault === 'policy_unparsable') { fs.writeFileSync(pj, '{broken'); writeInstall(e); }
  else if (fault === 'policy_version_unknown') { fs.writeFileSync(pj, '{"policy_version":2}'); writeInstall(e); }
  else if (fault === 'install_missing') fs.rmSync(path.join(e.installDir, 'install.json'));
  else throw new Error('unknown fault ' + fault);
}

function stdinFor(item, e) {
  const input = item.input === null || item.input === undefined ? undefined : sub(item.input, e);
  const base = payload(e, { tool_name: item.tool ?? 'Bash', tool_input: input, cwd: sub(item.cwd, e) });
  switch (item.raw_stdin) {
    case undefined: return JSON.stringify(base);
    case '@oversized': return JSON.stringify({ ...base, tool_input: { command: 'x'.repeat(5 * 1024 * 1024) } });
    case '@no_tool_input': { delete base.tool_input; return JSON.stringify(base); }
    case '@string_tool_input': return JSON.stringify({ ...base, tool_input: 'ls' });
    default: return item.raw_stdin;
  }
}

async function exec(item, mode) {
  let e = mode === 'enforce' ? enforce : shadow;
  if (item.fault) e = seedRepo(makeEnv({ mode }));
  setBranch(e, item.branch);
  writeInstall(e, { visibility: item.repo_visibility });
  if (item.fault) tamper(e, item.fault); // after the install record is written, so the hashes are stale on purpose
  const text = stdinFor(item, e);
  const runGit = () => ({ status: item.git_guard_status ?? 0 });
  const before = readLog(e).length;
  const out = await runHook(e, text, { runGit });
  const log = readLog(e);
  const rec = log.length > before ? log[log.length - 1] : null;
  let ms = null;
  if (!item.raw_stdin && !item.fault && item.tool) {
    const t0 = performance.now();
    try { judge(e, item.tool, sub(item.input, e), { cwd: sub(item.cwd, e), branch: item.branch, ctx: mkCtx(e, { repoVisibility: item.repo_visibility, runGit }) }); } catch { /* shape faults */ }
    ms = performance.now() - t0;
  }
  const r = { stdout: out.stdout, rec, ms };
  if (item.fault) cleanup(e);
  return r;
}

const expectedStdout = (item, rec) => (item.expected === 'allow' ? ALLOW_JSON : item.expected === 'deny' ? denyJson(rec?.rule_id) : '');

test('corpus file: shape, unique ids, category minimums (story 10.2), A1-A16 and the extra tags', () => {
  assert.ok(corpus.length >= 70, `only ${corpus.length} items`);
  const ids = new Set();
  for (const it of corpus) {
    assert.ok(!ids.has(it.id), 'duplicate id ' + it.id); ids.add(it.id);
    for (const f of FIELDS) assert.ok(f in it, `${it.id} lacks ${f}`);
    assert.ok(['allow', 'ask', 'deny'].includes(it.expected), it.id);
    assert.equal(it.expected_stage, 'prefilter', it.id);
  }
  const count = (cat) => corpus.filter((i) => i.category === cat).length;
  for (const [cat, min] of Object.entries(MIN)) assert.ok(count(cat) >= min, `${cat}: ${count(cat)} < ${min}`);
  for (let n = 1; n <= 16; n++) assert.ok(corpus.some((i) => i.ambiguity === 'A' + n), `A${n} has no case`);
  const tagged = (t) => corpus.filter((i) => (i.tags || []).includes(t));
  for (const t of ['f9', 'chflags', 'self-protection']) for (const d of t === 'f9' ? ['allow', 'ask', 'deny'] : t === 'chflags' ? ['ask', 'deny'] : ['deny']) {
    assert.ok(tagged(t).some((i) => i.expected === d), `tag ${t} lacks an expected-${d} case`);
  }
  // every allow bullet of Appendix A has a plain allow case
  for (const rule of ['L-READ', 'L-GIT-READ', 'L-GIT-BRANCH', 'L-GIT-ADD', 'L-GIT-COMMIT', 'L-GIT-NEWBRANCH', 'L-GIT-PUSH', 'L-GH', 'L-TEST', 'L-DRILL', 'L-EDIT']) {
    assert.ok(corpus.some((i) => i.expected_rule === rule && i.expected === 'allow'), rule);
  }
  // every deny rule id has a plain deny case
  for (const rule of Object.keys(JSON.parse(fs.readFileSync(path.join(APPROVER_DIR, 'policy', 'policy.sample.json'), 'utf8')).rules).filter((r) => r.startsWith('D-'))) {
    assert.ok(corpus.some((i) => i.expected_rule === rule && i.expected === 'deny'), rule);
  }
});

test('every item: expected decision, rule and stage in enforce mode; exact stdout; log record agrees', async () => {
  const fails = [];
  for (const item of corpus) {
    const r = await exec(item, 'enforce');
    results.set(item.id, r);
    if (r.ms !== null) times.push(r.ms);
    const label = `${item.id} [${item.category}]`;
    const bad = (m) => fails.push(`${label}: ${m}`);
    if (item.category === 'fail-closed' || item.raw_stdin !== undefined || item.fault) {
      if (r.stdout !== '') bad('fail-closed must print nothing');
      if (r.rec && r.rec.decision !== 'ask') bad('logged ' + r.rec.decision);
      continue;
    }
    if (!r.rec) { bad('no log record'); continue; }
    if (r.rec.stage !== 'prefilter') bad('stage ' + r.rec.stage);
    if (r.rec.mode !== 'enforce') bad('mode ' + r.rec.mode);
    if (r.rec.decision !== item.expected) bad(`expected ${item.expected}, got ${r.rec.decision}/${r.rec.rule_id}`);
    else if (item.expected_rule && r.rec.rule_id !== item.expected_rule) bad(`expected rule ${item.expected_rule}, got ${r.rec.rule_id}`);
    else if (r.stdout !== expectedStdout(item, r.rec)) bad('stdout ' + r.stdout.slice(0, 80));
  }
  assert.deepEqual(fails, []);
});

test('shadow mode: every item prints nothing and logs the same decision (story 5.1, 5.2)', async () => {
  for (const item of corpus) {
    if (item.fault) continue;
    const r = await exec(item, 'shadow');
    assert.equal(r.stdout, '', item.id);
    if (r.rec && !item.raw_stdin && results.get(item.id)?.rec) assert.equal(r.rec.decision, results.get(item.id).rec.decision, item.id);
  }
});

test('injection twins: every injection case gets exactly the decision of its clean twin (story 10.4)', () => {
  const inj = corpus.filter((i) => i.category === 'injection');
  assert.ok(inj.length >= 12);
  for (const it of inj) {
    assert.ok(it.twin_of, `${it.id} has no twin`);
    const twin = corpus.find((x) => x.id === it.twin_of);
    assert.ok(twin, `${it.id}: twin ${it.twin_of} missing`);
    const a = results.get(it.id).rec; const b = results.get(twin.id).rec;
    assert.equal(a.decision, b.decision, `${it.id} vs ${twin.id}`);
    assert.equal(a.rule_id, b.rule_id, `${it.id} vs ${twin.id}`);
    assert.equal(it.expected, twin.expected, `${it.id} vs ${twin.id}: labels`);
  }
});

test('fault matrix over the corpus: nothing that is not an expected allow ever prints allow (story 1.8)', () => {
  for (const item of corpus) {
    const r = results.get(item.id);
    if (item.expected !== 'allow') assert.ok(!r.stdout.includes('"behavior":"allow"'), item.id);
  }
});

test('report: pre-filter share and latency (targets, not gates: story 3.8, 11.1)', async () => {
  const decided = corpus.filter((i) => i.expected !== 'ask' && !i.fault && i.raw_stdin === undefined);
  const byPrefilter = decided.filter((i) => results.get(i.id).rec?.stage === 'prefilter');
  const share = (100 * byPrefilter.length) / decided.length;
  const undecided = corpus.filter((i) => results.get(i.id).rec?.undecided).length;
  const sorted = [...times].sort((a, b) => a - b);
  const pct = (a, p) => a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
  // end-to-end: real hook processes (node start-up included), 24 requests, current enforce install
  const sample = corpus.filter((i) => i.tool === 'Bash' && !i.fault && i.raw_stdin === undefined && !String(i.input.command).includes('FILLER')).slice(0, 24);
  const wall = [];
  for (const it of sample) {
    setBranch(enforce, it.branch); writeInstall(enforce, { visibility: it.repo_visibility });
    const t0 = performance.now();
    const p = spawnHook(enforce, stdinFor(it, enforce));
    wall.push(performance.now() - t0);
    assert.equal(p.status, 0);
  }
  wall.sort((a, b) => a - b);
  console.log(`\n  CORPUS: ${corpus.length} items | non-ask expected ${decided.length}, decided by the pre-filter ${byPrefilter.length} (${share.toFixed(1)}%) | undecided asks (model log only) ${undecided}`
    + `\n  CORPUS: pre-filter in-process p50 ${pct(sorted, 0.5).toFixed(2)} ms, p95 ${pct(sorted, 0.95).toFixed(2)} ms (n=${sorted.length})`
    + `\n  CORPUS: whole hook as a process (node start-up included) p50 ${pct(wall, 0.5).toFixed(0)} ms, p95 ${pct(wall, 0.95).toFixed(0)} ms (n=${wall.length})`);
  assert.ok(share >= 80);
});
