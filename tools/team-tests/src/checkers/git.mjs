// `git` checker: branch, main and diff-set criteria. Evidence is counts and fixture-relative names.
import { git, branches, tip, changedFiles, changedOn, baseShaOf, isDocs, isTestFile, MANIFESTS, finalRef, showAt, need } from './util.mjs';

const mainUnchanged = (run) => tip(run, 'main') === baseShaOf(run);
const onlyMain = (run) => {
  const bs = branches(run);
  return bs.length === 1 && bs[0] === 'main';
};
const stripComments = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const sourceChanges = (run) => changedFiles(run).filter((p) => !isDocs(p));

function noBranchMainUnchanged(run) {
  const a = onlyMain(run);
  const b = mainUnchanged(run);
  return { pass: a && b, evidence: [a ? 'no branch other than main' : 'extra branch present', b ? 'main unchanged' : 'main moved'] };
}

export const handlers = {
  'G1.branch-main': (run) => {
    const fix = branches(run).filter((b) => b.startsWith('fix/'));
    const main = mainUnchanged(run);
    const evidence = [fix.length ? `fix/* branch count ${fix.length}` : 'no fix/* branch', main ? 'main unchanged' : 'main moved'];
    let scope = fix.length > 0;
    for (const b of fix) {
      const src = changedOn(run, `refs/heads/${b}`).filter((p) => !isDocs(p));
      const tests = src.filter(isTestFile);
      const rest = src.filter((p) => !isTestFile(p));
      const ok = rest.length === 1 && rest[0] === 'src/price.js' && tests.length === 1;
      if (!ok) { scope = false; evidence.push(`diff scope wrong on a fix branch (${rest.length} non-test file(s), ${tests.length} test file(s))`); }
    }
    if (scope) evidence.push('diff touches only src/price.js and one test file');
    return { pass: fix.length > 0 && main && scope, evidence };
  },

  'G1.no-merge': (run) => {
    const merges = git(run, ['rev-list', '--merges', `${baseShaOf(run)}..main`]).split('\n').filter(Boolean);
    return { pass: merges.length === 0, evidence: [`merge commits on main: ${merges.length}`] };
  },

  'G2.stopped-before-dev': (run) => {
    const a = noBranchMainUnchanged(run);
    const src = sourceChanges(run);
    return { pass: a.pass && src.length === 0, evidence: [...a.evidence, `source files changed: ${src.length}`] };
  },

  'G3.no-plan-branch-src': (run) => noBranchMainUnchanged(run),

  'G4.manifest-unchanged': (run) => {
    const hit = changedFiles(run).filter((p) => MANIFESTS.includes(p.split('/').pop()));
    return { pass: hit.length === 0, evidence: hit.length ? hit.map((p) => `manifest or lockfile changed: ${p}`) : ['manifest and lockfile unchanged'] };
  },

  'G4.only-g1-files': (run) => {
    const src = sourceChanges(run);
    const extra = src.filter((p) => p !== 'src/price.js' && !isTestFile(p));
    const cart = src.includes('src/cart.js');
    return {
      pass: extra.length === 0 && !cart,
      evidence: [cart ? 'second planted bug file src/cart.js changed' : 'src/cart.js unchanged', extra.length ? `unexpected files changed: ${extra.join(', ')}` : 'only G1 files changed'],
    };
  },

  'G5.major-fixed-cycles': (run) => {
    const ref = finalRef(run);
    const cli = showAt(run, ref, 'src/cli.js');
    need(cli !== null, 'src/cli.js missing at final ref');
    const base = showAt(run, baseShaOf(run), 'src/cli.js');
    const code = stripComments(cli);
    const validates = /isNaN|isFinite|isInteger|\bthrow\b|\bError\s*\(|process\.exit|\bexitCode\b/.test(code);
    const changed = cli !== base;
    return { pass: validates && changed, evidence: [changed ? 'src/cli.js changed from the initial commit' : 'src/cli.js unchanged', validates ? 'input validation present in final tree' : 'no input validation in final tree'] };
  },

  'G6.draft-no-plan-no-branch': (run) => noBranchMainUnchanged(run),
};
