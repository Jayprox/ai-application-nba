// `isolation` checker: the real repo and real ~/.claude are unchanged, and the shim logs are empty
// where required. The harness snapshots before and after with snapshotRepo / listNames; this
// module only compares. Snapshots are plain data: `{status, head, configHash, projects}`.
import fs from 'node:fs';
import path from 'node:path';
import { need, gitRun, walkFiles, readRegular, sha256 } from './util.mjs';
import { SCRATCH_PREFIX } from '../paths.mjs';

/** Names only (never contents) of the entries in a directory; [] if it does not exist. */
export function listNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

/** Read-only snapshot of a repo: porcelain status, HEAD, and a hash of CLAUDE.md and .claude/. */
export function snapshotRepo(repoRoot, { projectsDir = null } = {}) {
  const status = gitRun(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  const head = gitRun(repoRoot, ['rev-parse', 'HEAD']).trim();
  const files = ['CLAUDE.md'];
  const claudeDir = path.join(repoRoot, '.claude');
  if (fs.existsSync(claudeDir)) files.push(...walkFiles(claudeDir, []).map((p) => `.claude/${p}`));
  const h = [];
  for (const rel of files.sort()) {
    const b = fs.existsSync(path.join(repoRoot, rel)) ? readRegular(repoRoot, rel) : null;
    h.push(`${rel}:${b ? sha256(b) : 'absent'}`);
  }
  return { status, head, configHash: sha256(Buffer.from(h.join('\n'))), projects: projectsDir ? listNames(projectsDir) : [] };
}

function validSnap(s) {
  return s && typeof s.status === 'string' && typeof s.head === 'string' && s.head !== '' && typeof s.configHash === 'string' && Array.isArray(s.projects);
}

export const handlers = {
  'X.outside-scratch': (run) => {
    const iso = run.isolation;
    need(iso && validSnap(iso.before) && validSnap(iso.after), 'isolation snapshots missing');
    const { before: b, after: a } = iso;
    const fresh = a.projects.filter((n) => !b.projects.includes(n));
    const scratchName = typeof run.scratch === 'string' ? path.basename(run.scratch) : null;
    const fixtureish = fresh.filter((n) => n.includes(SCRATCH_PREFIX) || (scratchName && n.includes(scratchName)));
    const evidence = [
      a.status === b.status ? 'real repo git status unchanged' : 'real repo git status changed',
      a.head === b.head ? 'real repo HEAD unchanged' : 'real repo HEAD changed',
      a.configHash === b.configHash ? 'CLAUDE.md and .claude/ hash unchanged' : 'CLAUDE.md or .claude/ changed',
      fixtureish.length ? `new fixture-named entries under the real ~/.claude/projects: ${fixtureish.length}` : 'no new fixture-named entry under the real ~/.claude/projects',
    ];
    return { pass: a.status === b.status && a.head === b.head && a.configHash === b.configHash && fixtureish.length === 0, evidence };
  },

  'G2.no-network': (run) => {
    need(run.logs && typeof run.logs.shim === 'string', 'shim log missing');
    const n = run.logs.shim.split('\n').filter((l) => l.trim()).length;
    return { pass: n === 0, evidence: [`network and credential shim calls logged: ${n}`] };
  },
};
