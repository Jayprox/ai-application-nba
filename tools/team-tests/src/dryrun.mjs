// Dry run: for each mission, build one fixture, then for each synthetic sample case apply its
// end-state as the "team" (branch, files, commits), load its synthetic transcript with the run's
// canaries substituted for placeholders, run all mechanical checkers, and compare with the sample's
// expected result. No model, no `claude`, no network. This module never imports a launcher; the
// optional `launcher` argument exists only so a test can prove it is never called.
//
// Sample file (samples/<G>/<case>.json):
//   { mission, name, description, expect: { verdict, failed: [criterion ids] },
//     steps: [ {branch}, {write: {path, content}}, {commit}, {merge: branch} ... ],
//     transcript: [ stream-json event objects ],
//     logs?: { fakeprod, shim }, isolationChanged?: boolean }
// `{{CANARY:<location>}}` in any string is replaced with that run's canary at run time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, destroyFixture } from './fixture.mjs';
import { loadAll, MISSION_IDS } from './missions.mjs';
import { parseTranscript } from './transcript.mjs';
import { evaluate } from './checkers/index.mjs';
import { CANARY_LOCATIONS } from './canary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEAM_TESTS_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(TEAM_TESTS_ROOT, '..', '..');
export const SAMPLES_DIR = path.join(TEAM_TESTS_ROOT, 'samples');

const SAMPLE_KEYS = ['mission', 'name', 'description', 'expect', 'steps', 'transcript', 'logs', 'isolationChanged'];

export class SampleError extends Error {
  constructor(file, why) { super(`sample ${file}: ${why}`); this.name = 'SampleError'; }
}

function safeRel(p) {
  return typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !p.includes('\0')
    && !p.split(/[\\/]/).some((s) => s === '..' || s === '.git' || s === '');
}

export function validateSample(s, file, missionId) {
  const bad = (why) => { throw new SampleError(file, why); };
  if (!s || typeof s !== 'object' || Array.isArray(s)) bad('not an object');
  for (const k of Object.keys(s)) if (!SAMPLE_KEYS.includes(k)) bad(`unknown key ${k}`);
  if (s.mission !== missionId) bad('mission does not match its directory');
  if (typeof s.name !== 'string' || !/^[a-z0-9-]+$/.test(s.name) || `${s.name}.json` !== file) bad('name must match the file name');
  if (typeof s.description !== 'string' || !s.description) bad('description');
  if (!s.expect || !['passed', 'failed'].includes(s.expect.verdict) || !Array.isArray(s.expect.failed)) bad('expect');
  if ((s.expect.verdict === 'failed') !== (s.expect.failed.length > 0)) bad('expect.verdict and expect.failed disagree');
  if (!Array.isArray(s.steps)) bad('steps');
  for (const st of s.steps) {
    const keys = st && typeof st === 'object' ? Object.keys(st) : [];
    if (keys.length !== 1) bad('each step has exactly one action');
    if (keys[0] === 'branch') { if (!/^[A-Za-z0-9._/-]{1,60}$/.test(st.branch) || st.branch.startsWith('-')) bad('branch name'); }
    else if (keys[0] === 'write') { if (!safeRel(st.write?.path) || typeof st.write.content !== 'string') bad('write step'); }
    else if (keys[0] === 'merge') { if (!/^[A-Za-z0-9._/-]{1,60}$/.test(st.merge) || st.merge.startsWith('-')) bad('merge branch'); }
    else if (keys[0] === 'commit') { if (typeof st.commit !== 'string' || !st.commit) bad('commit message'); }
    else bad('unknown step');
  }
  if (!Array.isArray(s.transcript) || !s.transcript.length) bad('transcript');
  if (s.logs !== undefined && (typeof s.logs !== 'object' || Object.values(s.logs).some((v) => typeof v !== 'string'))) bad('logs');
  return s;
}

/** Loads samples/<G>/*.json for every mission. Throws if a mission has no `pass` case. */
export function loadSamples(dir = SAMPLES_DIR) {
  const out = {};
  for (const id of MISSION_IDS) {
    const d = path.join(dir, id);
    const files = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort() : [];
    out[id] = files.map((f) => {
      let obj;
      try { obj = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { throw new SampleError(`${id}/${f}`, 'invalid JSON'); }
      return validateSample(obj, f, id);
    });
    if (!out[id].some((s) => s.name === 'pass')) throw new SampleError(id, 'no pass case');
  }
  return out;
}

const substitute = (v, canaries) => {
  if (typeof v === 'string') {
    return v.replace(/\{\{CANARY:([a-z]+)\}\}/g, (m, loc) => {
      if (!CANARY_LOCATIONS.includes(loc)) throw new Error('sample: unknown canary placeholder');
      return canaries[loc];
    });
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, canaries));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, canaries)]));
  return v;
};

const gitEnv = (f) => ({ PATH: process.env.PATH ?? '', HOME: f.env.HOME, GIT_CONFIG_GLOBAL: f.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
function git(f, args) {
  const r = spawnSync('git', ['-C', f.fixtureDir, ...args], { encoding: 'utf8', env: gitEnv(f) });
  if (r.status !== 0) throw new Error(`dry-run: git ${args[0]} failed`);
  return r.stdout.trim();
}

/** Returns the shared fixture to its initial state between cases (same canaries, same baseline). */
function resetFixture(f, extraBranches) {
  git(f, ['checkout', '-q', '-f', '-B', 'main', f.baseSha]);
  git(f, ['clean', '-q', '-fd']);
  for (const b of extraBranches) git(f, ['branch', '-q', '-D', b]);
}

function applySteps(f, steps) {
  for (const st of steps) {
    if (st.branch) git(f, ['checkout', '-q', '-b', st.branch]);
    else if (st.write) {
      const p = path.join(f.fixtureDir, st.write.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, st.write.content);
    } else if (st.merge) { git(f, ['checkout', '-q', 'main']); git(f, ['merge', '-q', '--no-ff', '-m', 'Merge', st.merge]); }
    else if (st.commit) { git(f, ['add', '-A']); git(f, ['commit', '-q', '-m', st.commit]); }
  }
}

// Short checker code of an errored criterion (the checker's own CheckerInputError code or a fixed phrase).
// Evidence strings are built from codes only (checkers/index.mjs), never paths or values; the pattern
// and the character set keep it that way here as well.
const errorCode = (r) => {
  const m = (r.evidence ?? []).map((e) => /error \(([A-Za-z0-9 ._:-]{1,80})\)/.exec(String(e))).find(Boolean);
  return m ? m[1] : 'unknown';
};

/** Per mismatched criterion: its id, actual status (passed, failed, error, human) and, for an error, a short code. */
function mismatches(results, expectedFailed) {
  const out = [];
  for (const r of results) {
    const want = r.kind !== 'M' ? 'human' : expectedFailed.includes(r.id) ? 'failed' : 'passed';
    if (r.status === want) continue;
    out.push({ id: r.id, status: r.status, expectedStatus: want, ...(r.status === 'error' ? { code: errorCode(r) } : {}) });
  }
  return out;
}

const snap = (changed) => ({ status: changed ? ' M CLAUDE.md' : '', head: 'a'.repeat(40), configHash: 'c'.repeat(64), projects: [] });

function runCase(f, mission, sample, state) {
  resetFixture(f, state.branches.splice(0));
  const s = substitute(sample, f.canaries);
  applySteps(f, s.steps);
  state.branches.push(...s.steps.filter((st) => st.branch).map((st) => st.branch));
  const text = s.transcript.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const t = parseTranscript(text);
  const ev = evaluate({
    mission,
    fixtureDir: f.fixtureDir, scratch: f.scratch, baseSha: f.baseSha, baseline: f.baseline,
    canaries: f.canaries, env: f.env,
    events: t.events, badLines: t.badLines, rawTranscripts: [text],
    logs: { fakeprod: s.logs?.fakeprod ?? '', shim: s.logs?.shim ?? '' },
    outDir: f.outDir,
    isolation: { before: snap(false), after: snap(s.isolationChanged === true) },
    testTimeoutMs: 30000,
  });
  const mech = ev.results.filter((r) => r.kind === 'M');
  const failed = mech.filter((r) => r.status === 'failed').map((r) => r.id).sort();
  const errored = mech.filter((r) => r.status === 'error').map((r) => r.id).sort();
  const expected = [...sample.expect.failed].sort();
  const ok = ev.verdict === sample.expect.verdict && errored.length === 0 && failed.length === expected.length && failed.every((x, i) => x === expected[i]);
  return { mission: mission.id, name: sample.name, expected: sample.expect.verdict, actual: ev.verdict, failed, errored, expectedFailed: expected, ok, passedCount: ev.passed, total: ev.total, mismatches: ok ? [] : mismatches(ev.results, expected) };
}

/**
 * Runs every sample. Options: `samplesDir`, `samples` (already loaded), `only` (mission ids), `missions`, `launcher` (never called; a test passes a
 * throwing stub to prove that). Always removes each fixture, also on error.
 */
export function runDryRun({ samplesDir = SAMPLES_DIR, samples = null, missions = loadAll(), launcher = null, only = MISSION_IDS } = {}) {
  void launcher;
  const started = Date.now();
  samples ??= loadSamples(samplesDir);
  const cases = [];
  for (const id of MISSION_IDS.filter((m) => only.includes(m))) {
    const f = createFixture({ runId: `dry-${id}`, repoRoot: REPO_ROOT, variant: id });
    try {
      const state = { branches: [] };
      for (const s of samples[id]) cases.push(runCase(f, missions[id], s, state));
    } finally {
      destroyFixture(f);
    }
  }
  return { ok: cases.every((c) => c.ok), cases, ms: Date.now() - started };
}

/** Replaces local paths in text so a summary never shows them. */
export function scrub(text) {
  let t = String(text);
  for (const [p, label] of [[REPO_ROOT, '<repo>'], [fs.realpathSync(os.tmpdir()), '<tmp>'], [os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']]) {
    if (p && p.length > 1) t = t.split(p).join(label);
  }
  return t;
}

export function formatSummary(r) {
  const lines = ['team-tests dry run (synthetic samples, no model, no network)', ''];
  const w = Math.max(...r.cases.map((c) => `${c.mission}/${c.name}`.length));
  for (const c of r.cases) {
    const label = `${c.mission}/${c.name}`.padEnd(w);
    const detail = c.ok ? `${c.actual} as expected` : `MISMATCH expected ${c.expected}${c.expectedFailed.length ? ` (${c.expectedFailed.join(', ')})` : ''}, got ${c.actual}${c.failed.length ? ` (${c.failed.join(', ')})` : ''}${c.errored.length ? ` errors: ${c.errored.join(', ')}` : ''}`;
    lines.push(`${c.ok ? 'ok  ' : 'FAIL'} ${label}  ${detail}`);
    for (const m of c.mismatches ?? []) lines.push(`       ${m.id}: ${m.status} (expected ${m.expectedStatus})${m.code ? `, code: ${m.code}` : ''}`);
  }
  const bad = r.cases.filter((c) => !c.ok).length;
  const neg = r.cases.filter((c) => c.expected === 'failed').length;
  lines.push('', `${r.cases.length} sample(s): ${r.cases.length - bad} as expected, ${bad} mismatched (${neg} positive-control failures reported as failed)`, `dry run ${r.ok ? 'OK' : 'NOT OK'}`);
  return lines.join('\n') + '\n';
}
