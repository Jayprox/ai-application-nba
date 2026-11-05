// Runs every mechanical checker named by a mission's criteria over a run record.
//
// run = {
//   mission,                 // validated mission (src/missions.mjs)
//   fixtureDir, scratch,     // absolute paths of the fixture repo and its scratch root
//   baseSha, baseline,       // initial commit SHA and the fixture file-hash baseline (fixture.mjs)
//   canaries, env,           // per-run canaries and the B2 child env
//   events, badLines,        // normalised transcript (src/transcript.mjs)
//   rawTranscripts,          // optional raw transcript texts (also scanned for canaries)
//   logs: { fakeprod, shim },// log file contents ('' when empty; null/missing = fail closed)
//   outDir,                  // optional out/ directory, scanned for canaries
//   isolation: { before, after },  // snapshots from isolation.snapshotRepo
//   planted, testTimeoutMs   // optional overrides
// }
//
// Each criterion result: { id, kind, category, status: 'passed'|'failed'|'error'|'human', pass, evidence, ... }.
// `pass` is true only for status 'passed'. A checker that throws (missing or unparseable input,
// git failure, timeout) yields 'error', never 'passed'. Evidence has no canary values and no
// absolute paths. Denied attempts and executed calls are listed separately under `executed`/`denied`.
import { withMemo } from './util.mjs';
import { allCriteria } from '../missions.mjs';
import { handlers as git } from './git.mjs';
import { handlers as files } from './files.mjs';
import { handlers as transcript } from './transcript.mjs';
import { handlers as canary } from './canary.mjs';
import { handlers as isolation } from './isolation.mjs';
import { handlers as testsBeforeAfter } from './tests-before-after.mjs';

export const CHECKERS = Object.freeze({ git, files, transcript, canary, isolation, 'tests-before-after': testsBeforeAfter });

function runOne(checkerId, criterionId, run) {
  const fn = CHECKERS[checkerId]?.[criterionId];
  if (typeof fn !== 'function') return { status: 'error', evidence: [`${checkerId}: no handler for ${criterionId}`] };
  try {
    const r = fn(run);
    if (!r || typeof r.pass !== 'boolean' || !Array.isArray(r.evidence)) return { status: 'error', evidence: [`${checkerId}: malformed result`] };
    return { status: r.pass === true ? 'passed' : 'failed', evidence: r.evidence, extra: r.extra };
  } catch (err) {
    // Only the error class and the checker's own short code are reported: messages could carry paths.
    const code = err?.name === 'CheckerInputError' ? err.message : 'checker raised an exception';
    return { status: 'error', evidence: [`${checkerId}: error (${code})`] };
  }
}

export function evaluateCriterion(c, run) {
  const base = { id: c.id, kind: c.kind, category: c.category };
  if (c.kind !== 'M') return { ...base, status: 'human', pass: false, evidence: ['read by the owner'] };
  const parts = c.checkers.map((id) => ({ id, ...runOne(id, c.id, run) }));
  const status = parts.some((p) => p.status === 'error') ? 'error' : parts.every((p) => p.status === 'passed') ? 'passed' : 'failed';
  const executed = parts.flatMap((p) => p.extra?.executed ?? []);
  const denied = parts.flatMap((p) => p.extra?.denied ?? []);
  const out = { ...base, status, pass: status === 'passed', checkers: c.checkers, evidence: parts.flatMap((p) => p.evidence.map((e) => `[${p.id}] ${e}`)) };
  if (executed.length || denied.length || c.id === 'X.forbidden-commands') { out.executed = executed; out.denied = denied; }
  return out;
}

/** Evaluates all mechanical criteria for the mission (its own plus cross-cutting). */
export function evaluate(run) {
  const results = withMemo(() => allCriteria(run.mission).map((c) => evaluateCriterion(c, run)));
  const mech = results.filter((r) => r.kind === 'M');
  const verdict = mech.some((r) => r.status === 'error') ? 'error' : mech.every((r) => r.status === 'passed') ? 'passed' : 'failed';
  const forb = results.find((r) => r.id === 'X.forbidden-commands');
  return {
    mission: run.mission.id,
    verdict, // 'passed' only if every mechanical criterion passed
    passed: mech.filter((r) => r.pass).length,
    total: mech.length,
    executed: forb?.executed ?? [],
    denied: forb?.denied ?? [],
    results,
  };
}
