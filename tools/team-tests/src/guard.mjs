// Refusal-to-run guard (plan 3.9, Story 2 AC7). `checkRun` runs BEFORE the launcher is imported and
// throws GuardRefusal on the first failed condition. Procedural, not tamper-proof (plan 3.9): the
// approval file must be written by the owner outside any repo and outside scratch space.
// This module imports nothing that can spawn `claude`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GuardRefusal } from './refusal.mjs';
import { isInsideGitWorkTree, isWithin } from './paths.mjs';
import { MAX_SESSIONS, estimateSha256, totalSessions } from './estimate.mjs';
import { readLedger, checkLedger, remainingSlots } from './ledger.mjs';
import { MISSION_IDS } from './missions.mjs';

export { MAX_SESSIONS };
export const APPROVAL_KEYS = Object.freeze(['approvalId', 'approvedBy', 'approvedOn', 'expires', 'runSet', 'maxSessions', 'maxUsdPerSession', 'maxUsdTotal', 'coordinatorModel', 'configRef', 'estimateSha256', 'resultsDir']);
const ID = /^[A-Za-z0-9._-]{1,40}$/;
const MODEL = /^[A-Za-z0-9._:-]{1,64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_APPROVAL_BYTES = 65536;

const refuse = (code, why) => { throw new GuardRefusal(code, why); };

/** Directories that count as scratch space: the OS temp dir and the usual temp roots, resolved. */
export function scratchRoots() {
  const out = new Set();
  for (const p of [os.tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']) {
    try { out.add(fs.realpathSync(p)); } catch { /* absent on this OS */ }
  }
  return [...out];
}

/** A directory that the guard accepts for the results dir or as the approval file's parent. */
function checkDir(dir, what, { roots, uid }) {
  let st;
  try { st = fs.lstatSync(dir); } catch { refuse(`${what}-missing`, `${what} directory does not exist`); }
  if (st.isSymbolicLink()) refuse(`${what}-symlink`, `${what} directory is a symlink`);
  if (!st.isDirectory()) refuse(`${what}-type`, `${what} path is not a directory`);
  if (fs.realpathSync(dir) !== dir) refuse(`${what}-symlink`, `${what} path crosses a symlink`);
  if (roots.some((r) => isWithin(r, dir))) refuse(`${what}-scratch`, `${what} is inside scratch space`);
  if (isInsideGitWorkTree(dir)) refuse(`${what}-worktree`, `${what} is inside a git work tree`);
  if (uid !== null && st.uid !== uid) refuse(`${what}-owner`, `${what} directory is not owned by the current user`);
  if ((st.mode & 0o022) !== 0) refuse(`${what}-writable`, `${what} directory is group or world writable`);
}

function absolute(p, what) {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || !path.isAbsolute(p)) refuse(`${what}-path`, `${what} must be an absolute path`);
  if (path.resolve(p) !== p) refuse(`${what}-path`, `${what} must be a normalised absolute path`);
  return p;
}

function checkApprovalFile(file, ctx) {
  absolute(file, 'approval');
  let st;
  try { st = fs.lstatSync(file); } catch { refuse('approval-missing', 'approval file not found'); }
  if (st.isSymbolicLink()) refuse('approval-symlink', 'approval file is a symlink');
  if (!st.isFile()) refuse('approval-type', 'approval path is not a regular file');
  if (st.nlink > 1) refuse('approval-hardlink', 'approval file has more than one hard link');
  if (fs.realpathSync(file) !== file) refuse('approval-symlink', 'approval path crosses a symlink');
  if (ctx.uid !== null && st.uid !== ctx.uid) refuse('approval-owner', 'approval file is not owned by the current user');
  if ((st.mode & 0o022) !== 0) refuse('approval-writable', 'approval file is group or world writable');
  if (st.size > MAX_APPROVAL_BYTES) refuse('approval-size', 'approval file too large');
  const dir = path.dirname(file);
  if (ctx.roots.some((r) => isWithin(r, dir))) refuse('approval-scratch', 'approval file is inside scratch space');
  if (isInsideGitWorkTree(dir)) refuse('approval-worktree', 'approval file is inside a git work tree');
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refuse('approval-json', 'approval file is not valid JSON'); }
  return obj;
}

const isPosNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function validateApproval(a, now) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) refuse('approval-shape', 'approval is not an object');
  for (const k of Object.keys(a)) if (!APPROVAL_KEYS.includes(k)) refuse('approval-shape', 'approval has an unknown field');
  for (const k of APPROVAL_KEYS) if (!(k in a)) refuse('approval-shape', `approval is missing ${k}`);
  if (typeof a.approvalId !== 'string' || !ID.test(a.approvalId)) refuse('approval-shape', 'bad approvalId');
  if (a.approvedBy !== 'owner') refuse('approval-shape', 'approvedBy must be "owner"');
  const on = Date.parse(a.approvedOn);
  const exp = Date.parse(a.expires);
  if (typeof a.approvedOn !== 'string' || typeof a.expires !== 'string' || Number.isNaN(on) || Number.isNaN(exp)) refuse('approval-shape', 'bad date');
  if (on > now.getTime() + 60_000 || exp <= on) refuse('approval-shape', 'approvedOn is in the future or expires is not after it');
  if (exp <= now.getTime()) refuse('approval-expired', 'approval has expired');
  if (!Array.isArray(a.runSet) || a.runSet.length === 0 || a.runSet.length > 7) refuse('approval-shape', 'bad runSet');
  for (const r of a.runSet) {
    const keys = r && typeof r === 'object' ? Object.keys(r).sort().join() : '';
    if (keys !== 'mission,repeats' || !MISSION_IDS.includes(r.mission) || !Number.isInteger(r.repeats) || r.repeats < 1 || r.repeats > 99) refuse('approval-shape', 'bad runSet entry');
  }
  if (!Number.isInteger(a.maxSessions) || a.maxSessions < 1) refuse('approval-shape', 'bad maxSessions');
  if (a.maxSessions > MAX_SESSIONS) refuse('max-sessions-cap', `maxSessions exceeds the hard cap of ${MAX_SESSIONS} in code`);
  if (!isPosNum(a.maxUsdPerSession) || !isPosNum(a.maxUsdTotal) || a.maxUsdPerSession > a.maxUsdTotal) refuse('approval-shape', 'bad cost caps');
  if (typeof a.coordinatorModel !== 'string' || !MODEL.test(a.coordinatorModel)) refuse('approval-shape', 'bad coordinatorModel');
  if (typeof a.configRef !== 'string' || !REF.test(a.configRef)) refuse('approval-shape', 'bad configRef');
  if (typeof a.estimateSha256 !== 'string' || !SHA256.test(a.estimateSha256)) refuse('approval-shape', 'bad estimateSha256');
  if (typeof a.resultsDir !== 'string') refuse('approval-shape', 'bad resultsDir');
  return a;
}

export function resolveRefSha(repoRoot, ref) {
  if (!REF.test(ref)) return null;
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  const sha = r.stdout.trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const sameRunSet = (a, b) => a.length === b.length && a.every((x, i) => x.mission === b[i].mission && x.repeats === b[i].repeats);

/**
 * Checks every condition of plan 3.9. Returns { approval, resultsDir, createResultsDir, configSha,
 * ledger, todo, consumed }. Writes nothing. `opts.roots`, `opts.uid`, `opts.resolveRef` exist so
 * tests can run outside the real scratch roots; the CLI never sets them.
 */
export function checkRun({ approvalPath, runSet, env = process.env, now = new Date(), repoRoot, ...opts }) {
  const ctx = {
    roots: opts.roots ?? scratchRoots(),
    uid: opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null),
  };
  if (env.CI !== undefined) refuse('ci', 'real runs never run in CI (CI is set)');
  if (approvalPath === undefined || approvalPath === null || approvalPath === '') refuse('approval-missing', '--approval <file> is required');
  const approval = validateApproval(checkApprovalFile(approvalPath, ctx), now);

  if (!Array.isArray(runSet) || runSet.length === 0) refuse('run-set', 'no run set requested');
  if (!sameRunSet(runSet, approval.runSet)) refuse('run-set-mismatch', 'the requested run set differs from the approved run set');
  const n = totalSessions(approval.runSet);
  if (n > MAX_SESSIONS) refuse('max-sessions-cap', `run set has ${n} sessions; hard cap is ${MAX_SESSIONS}`);
  if (n > approval.maxSessions) refuse('max-sessions', `run set has ${n} sessions; approval maxSessions is ${approval.maxSessions}`);

  const want = estimateSha256({ runSet: approval.runSet, maxSessions: approval.maxSessions, maxUsdPerSession: approval.maxUsdPerSession, maxUsdTotal: approval.maxUsdTotal });
  if (want !== approval.estimateSha256) refuse('estimate-mismatch', 'estimateSha256 does not match the estimate for this run set and these caps');

  const configSha = (opts.resolveRef ?? resolveRefSha)(repoRoot, approval.configRef);
  if (!configSha) refuse('config-ref', 'configRef does not resolve to a commit');

  const dir = absolute(approval.resultsDir, 'results');
  let exists = true;
  try { fs.lstatSync(dir); } catch { exists = false; }
  if (exists) checkDir(dir, 'results', ctx);
  else checkDir(path.dirname(dir), 'results-parent', ctx);
  if (approvalPath === path.join(dir, path.basename(approvalPath))) refuse('results-path', 'results dir must not hold the approval file');

  const ledger = exists ? readLedger(dir, approval.approvalId) : { version: 1, approvalId: approval.approvalId, sessions: [] };
  const { consumed, todo } = remainingSlots(ledger, approval.runSet);
  checkLedger(ledger, approval, todo.length > 0 ? todo.length : 0);
  return { approval, resultsDir: dir, createResultsDir: !exists, configSha, ledger, consumed, todo };
}
