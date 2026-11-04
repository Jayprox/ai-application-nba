// Allow rules (Appendix A, narrowed per requirements section 3). A command is allowed only when it
// matches one rule exactly: strict flag lists, literal arguments, every path resolved and inside the repo.
// Returns a rule id or null. null never means deny; the caller treats it as "not allowed".
import fs from 'node:fs';
import path from 'node:path';
import { realResolve, classifyPath, isInside } from '../paths.mjs';
import { parseFlags, hasFlag, flagValue } from './flags.mjs';

const REV_RE = /^[A-Za-z0-9._\/@^~{}+-]+(?:\.\.\.?[A-Za-z0-9._\/@^~{}+-]+)?$/;
const REV_PATH_RE = /^([A-Za-z0-9._\/@^~{}+-]*):(.+)$/;
const SED_SAFE = /^(?:\d+|\$)?(?:,(?:\d+|\$))?p$|^\/[A-Za-z0-9 _.-]+\/p$/;
const TEST_FILE = /^(?:worker\/)?test\/[A-Za-z0-9._-]+\.test\.(?:js|mjs)$/;
const PR_NUM = /^\d{1,7}$/;

const FIND_NOARG = new Set(['-print', '-print0', '-prune', '-empty', '-not', '!', '-o', '-a', '-and', '-or', '(', ')', '-depth', '-mount', '-xdev']);
const FIND_ONEARG = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-ctime', '-size', '-newer', '-perm']);

const ok = (id) => id;

// One path argument: literal, resolves (in every candidate cwd) to an existing path inside the repo
// that is not protected, a .env file, a secret path or secret-looking (A1, A11).
export function pathOk(word, S, c, { mustExist = true, dirOnly = false } = {}) {
  if (word.dynamic || word.glob || word.text === '' || word.text.startsWith('~')) return false;
  for (const cwd of c.cwds) {
    const r = realResolve(word.text, cwd);
    if (!r.ok || (mustExist && !r.exists)) return false;
    if (!isInside(r.real, S.pc.repoRoot)) return false;
    const k = classifyPath(r.real, S.pc);
    if (k.protected || k.envfile || k.secret || k.secretish) return false;
    if (dirOnly) { try { if (!fs.statSync(r.real).isDirectory()) return false; } catch { return false; } }
  }
  return true;
}

const allPaths = (words, S, c, opt) => words.every((w) => pathOk(w, S, c, opt));
const stdinOk = (c) => c.pipeIndex > 0;
const words1 = (c) => c.words.slice(1);

function nothingElse(c) {
  return !c.assigns.length && !c.heredocs.length && !c.herestring;
}

export function harmlessRedirects(c) {
  return c.redirs.every((r) => {
    const t = r.target.text;
    if (r.target.dynamic || r.target.glob) return false;
    if (r.op === '>&' && r.fd === '2' && t === '1') return true;
    if (r.op === '>' && (r.fd === null || r.fd === '1' || r.fd === '2') && t === '/dev/null') return true;
    return false;
  });
}

// ---- find (A9) ----
export function findInfo(c) {
  const w = words1(c);
  let i = 0; const paths = [];
  while (i < w.length && !(w[i].text.startsWith('-') || w[i].text === '!' || w[i].text === '(')) { paths.push(w[i]); i++; }
  const preds = [];
  for (; i < w.length; i++) {
    const t = w[i].text;
    if (w[i].dynamic || w[i].glob) return { readOnly: false, paths, preds };
    if (FIND_NOARG.has(t)) { preds.push(t); continue; }
    if (FIND_ONEARG.has(t)) {
      if (i + 1 >= w.length) return { readOnly: false, paths, preds };
      preds.push([t, w[i + 1]]); i++; continue;
    }
    return { readOnly: false, paths, preds };
  }
  return { readOnly: true, paths, preds };
}

export function sedInfo(c) {
  const f = parseFlags(words1(c), { short: 'nEs' });
  if (!f.ok || !hasFlag(f.flags, '-n') || !f.pos.length) return { safe: false };
  const script = f.pos[0].text;
  return { safe: SED_SAFE.test(script), files: f.pos.slice(1) };
}

// ---- git ----
export function gitParts(words) {
  let i = 1; const globals = [];
  while (i < words.length) {
    const t = words[i].text;
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { globals.push(t, words[i + 1]?.text); i += 2; continue; }
    if (t.startsWith('-')) { globals.push(t); i++; continue; }
    break;
  }
  return { sub: words[i]?.text ?? null, globals, args: words.slice(i + 1) };
}

function revsAndPaths(args, S, c, { allowRevPath }) {
  const di = args.findIndex((a) => a.text === '--');
  const left = di >= 0 ? args.slice(0, di) : args;
  const right = di >= 0 ? args.slice(di + 1) : [];
  for (const a of left) {
    if (a.dynamic || a.glob) return false;
    let t = a.text;
    if (allowRevPath) {
      const m = REV_PATH_RE.exec(t);
      if (m) { if (m[1] && !REV_RE.test(m[1])) return false; if (!pathOk({ ...a, text: m[2] }, S, c, { mustExist: false })) return false; continue; }
    }
    if (t.startsWith('-') || !REV_RE.test(t)) return false;
  }
  return right.every((a) => pathOk(a, S, c, { mustExist: false }));
}

const LOG_LONG = {
  '--oneline': true, '--graph': true, '--decorate': 'optval', '--all': true, '--stat': 'optval', '--name-only': true, '--name-status': true,
  '--no-color': true, '--color': 'optval', '--abbrev-commit': true, '--no-merges': true, '--merges': true, '--first-parent': true,
  '--reverse': true, '--max-count': 'value', '--since': 'value', '--until': 'value', '--after': 'value', '--before': 'value',
  '--author': 'value', '--committer': 'value', '--grep': 'value', '--pretty': 'value', '--format': 'value', '--date': 'value',
  '--patch': true, '--no-patch': true, '--shortstat': true, '--numstat': true, '--follow': true, '--no-ext-diff': true, '--no-textconv': true,
  '--summary': true, '--abbrev': 'optval', '--date-order': true, '--topo-order': true, '--stat-width': 'value', '--no-pager': true,
};
const DIFF_LONG = {
  '--stat': 'optval', '--name-only': true, '--name-status': true, '--cached': true, '--staged': true, '--no-color': true, '--color': 'optval',
  '--shortstat': true, '--numstat': true, '--summary': true, '--check': true, '--patch': true, '--no-patch': true, '--minimal': true,
  '--word-diff': 'optval', '--abbrev': 'optval', '--full-index': true, '--exit-code': true, '--quiet': true, '--no-ext-diff': true,
  '--no-textconv': true, '--diff-filter': 'value', '--unified': 'value', '--ignore-all-space': true, '--ignore-space-change': true,
  '--no-renames': true, '--find-renames': 'optval', '--no-pager': true,
};

function gitAllow(c, S) {
  const { sub, globals, args } = gitParts(c.words);
  if (sub === null) return null;
  // only --no-pager is a harmless global option (-c, -C, --git-dir, --exec-path... are not)
  if (globals.some((g) => g !== '--no-pager')) return null;
  const f = (spec, a = args) => parseFlags(a, spec);
  const split = (a) => { const di = a.findIndex((x) => x.text === '--'); return di >= 0 ? [a.slice(0, di), a.slice(di)] : [a, []]; };
  switch (sub) {
    case 'status': {
      const r = f({ short: 'sbzvuno', long: { '--short': true, '--branch': true, '--porcelain': 'optval', '--ignored': 'optval', '--untracked-files': 'optval', '--no-renames': true, '--long': true } });
      return r.ok && r.pos.every((p) => pathOk(p, S, c, { mustExist: false })) ? ok('L-GIT-READ') : null;
    }
    case 'diff': {
      const [left, right] = split(args);
      const r = f({ short: 'pwbMCz', shortVal: 'U', long: DIFF_LONG, numeric: false }, left);
      if (!r.ok) return null;
      const rest = right.slice(1);
      return revsAndPaths([...r.pos, ...(right.length ? [{ text: '--', dynamic: false, glob: false }, ...rest] : [])], S, c, { allowRevPath: false }) ? ok('L-GIT-READ') : null;
    }
    case 'log': case 'show': {
      const [left, right] = split(args);
      const r = f({ short: 'p', shortVal: 'n', long: LOG_LONG, numeric: true }, left);
      if (!r.ok) return null;
      const rest = right.slice(1);
      return revsAndPaths([...r.pos, ...(right.length ? [{ text: '--', dynamic: false, glob: false }, ...rest] : [])], S, c, { allowRevPath: sub === 'show' }) ? ok('L-GIT-READ') : null;
    }
    case 'branch': {
      const r = f({ short: 'arv', long: { '--list': true, '--show-current': true, '--all': true, '--remotes': true, '--verbose': true } });
      if (!r.ok) return null;
      if (r.pos.length && !hasFlag(r.flags, '--list')) return null; // `git branch NAME` creates a branch
      return ok('L-GIT-BRANCH');
    }
    case 'add': {
      const r = f({ long: {} });
      const files = r.pos;
      return r.ok && files.length && r.flags.every((x) => x.name === '--') && allPaths(files, S, c) ? ok('L-GIT-ADD') : null;
    }
    case 'commit': {
      const r = f({ short: 'aqv', shortVal: 'm', long: { '--message': 'value', '--all': true, '--quiet': true, '--allow-empty': true } });
      if (!r.ok || r.pos.length) return null; // --amend, --no-verify, -n, -F, paths: not in the spec, so not allowed (A5)
      const msgs = r.flags.filter((x) => x.name === '-m' || x.name === '--message');
      return msgs.length && msgs.every((m) => m.value && m.value.length) ? ok('L-GIT-COMMIT') : null;
    }
    case 'checkout': case 'switch': {
      const flag = sub === 'checkout' ? '-b' : '-c';
      if (args.length !== 2 || args[0].text !== flag || args.some((a) => a.dynamic || a.glob)) return null;
      return branchNameOk(args[1].text, S) ? ok('L-GIT-NEWBRANCH') : null;
    }
    case 'push': {
      let a = args;
      if (a.length && (a[0].text === '-u' || a[0].text === '--set-upstream')) a = a.slice(1); // owner decision F9
      if (a.length !== 2 || a.some((x) => x.dynamic || x.glob)) return null;
      return a[0].text === 'origin' && branchNameOk(a[1].text, S) ? ok('L-GIT-PUSH') : null;
    }
    default: return null;
  }
}

export function branchNameOk(name, S) {
  const re = new RegExp(S.ctx.policy.branches.new_branch_regex);
  return re.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('/.');
}

// ---- gh ----
function ghAllow(c, S) {
  const w = words1(c);
  if (w.some((x) => x.dynamic || x.glob)) return null;
  if (w[0]?.text !== 'pr') return null;
  const sub = w[1]?.text; const rest = w.slice(2);
  switch (sub) {
    case 'create': {
      const r = parseFlags(rest, { short: 'd', shortVal: 'tbBH', long: { '--title': 'value', '--body': 'value', '--base': 'value', '--head': 'value', '--draft': true, '--fill': true } });
      return r.ok && !r.pos.length ? ok('L-GH') : null;
    }
    case 'view': case 'checks': case 'diff': {
      const spec = sub === 'view' ? { long: { '--comments': true } } : sub === 'checks' ? { long: { '--watch': true, '--required': true } } : { long: { '--name-only': true, '--patch': true } };
      const r = parseFlags(rest, spec);
      return r.ok && r.pos.length === 1 && PR_NUM.test(r.pos[0].text) ? ok('L-GH') : null;
    }
    case 'comment': {
      if (S.ctx.repoVisibility !== 'private') return null; // Q10: ask if the repo is public or unknown
      const r = parseFlags(rest, { shortVal: 'b', long: { '--body': 'value' } });
      const body = r.ok ? (flagValue(r.flags, '-b') ?? flagValue(r.flags, '--body')) : null;
      return r.ok && r.pos.length === 1 && PR_NUM.test(r.pos[0].text) && body ? ok('L-GH') : null;
    }
    default: return null;
  }
}

// ---- tests, lint, drills (A7, A8, A12) ----
function testGuard(c, S) {
  if (c.cwds.length !== 1) return false;
  const root = S.pc.repoRoot; const dir = c.cwds[0];
  let prefix = '';
  if (dir !== root) {
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || rel.includes('/') || !fs.existsSync(path.join(dir, 'package.json'))) return false;
    prefix = rel + '/';
  }
  const specs = ['package.json', 'package-lock.json', 'vite.config.*', 'vitest.config.*'].map((f) => prefix + f);
  // Compared against origin/main, not HEAD: the agent may commit freely (flag F5).
  const r = S.ctx.runGit(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', 'refs/remotes/origin/main', '--', ...specs], { cwd: root, timeoutMs: 1500 });
  return !!r && r.status === 0;
}

const atRoot = (c, S) => c.cwds.length === 1 && c.cwds[0] === S.pc.repoRoot;

function npmAllow(c, S) {
  const w = words1(c).map((x) => x.text);
  if (w.length === 1 && w[0] === 'test') return testGuard(c, S) ? ok('L-TEST') : null;
  if (w.length === 2 && w[0] === 'run' && w[1] === 'lint') return testGuard(c, S) ? ok('L-TEST') : null;
  if (w.length === 2 && w[0] === 'run' && w[1] === 'db:backup:drill') return atRoot(c, S) ? ok('L-DRILL') : null;
  return null;
}

// cd: judged here; the walker in bash.mjs updates the working-directory set.
export function cdTarget(c, S) {
  const w = words1(c);
  if (w.length !== 1 || c.depth > 0 || c.nested || c.pipeIndex > 0 || c.nextOp === '|' || c.background) return null;
  if (!pathOk(w[0], S, c, { dirOnly: true })) return null;
  return w[0];
}

export function allowRule(c, S) {
  if (!c.name || c.opaque || c.complex || c.dynamicName || c.unknownInner) return null;
  if (c.depth > 0 || c.nested || c.background) return null;
  if (c.words.some((w) => w.dynamic || w.glob) || !nothingElse(c) || !harmlessRedirects(c)) return null;
  const n = c.name;
  const w = words1(c);
  // drill: exactly these words, repo root, nothing else (A12). zsh is a wrapper elsewhere, so this comes first.
  if (n === 'zsh') return w.length === 1 && w[0].text === 'scripts/weekly-drill.sh' && atRoot(c, S) ? ok('L-DRILL') : null;
  if (c.wrapper) return null;
  switch (n) {
    case 'cd': return cdTarget(c, S) ? ok('L-CD') : null;
    case 'ls': {
      const r = parseFlags(w, { short: '1AaCcdFfGghiklnoqRrSstUux', long: { '--all': true, '--almost-all': true, '--human-readable': true, '--color': 'optval', '--classify': true } });
      return r.ok && allPaths(r.pos, S, c) ? ok('L-READ') : null;
    }
    case 'cat': {
      const r = parseFlags(w, { short: 'nbsAEeTtvu' });
      return r.ok && r.pos.length && allPaths(r.pos, S, c) ? ok('L-READ') : null;
    }
    case 'head': case 'tail': {
      const r = parseFlags(w, { short: 'qv', shortVal: 'nc', numeric: true, long: { '--lines': 'value', '--bytes': 'value', '--quiet': true } });
      return r.ok && (r.pos.length ? allPaths(r.pos, S, c) : stdinOk(c)) ? ok('L-READ') : null;
    }
    case 'wc': {
      const r = parseFlags(w, { short: 'lwcmL' });
      return r.ok && (r.pos.length ? allPaths(r.pos, S, c) : stdinOk(c)) ? ok('L-READ') : null;
    }
    case 'grep': {
      const r = parseFlags(w, {
        short: 'EFGHILRainvwxcloqrsh', shortVal: 'ABCme',
        long: { '--color': 'optval', '--include': 'value', '--exclude': 'value', '--exclude-dir': 'value', '--line-number': true, '--ignore-case': true, '--recursive': true, '--no-filename': true, '--count': true, '--files-with-matches': true, '--fixed-strings': true, '--extended-regexp': true, '--word-regexp': true, '--invert-match': true, '--max-count': 'value', '--only-matching': true },
      });
      if (!r.ok) return null;
      const hasE = hasFlag(r.flags, '-e');
      const files = hasE ? r.pos : r.pos.slice(1);
      if (!hasE && !r.pos.length) return null;
      const recursive = hasFlag(r.flags, '-r') || hasFlag(r.flags, '-R') || hasFlag(r.flags, '--recursive');
      if (recursive) {
        // A14: recursive grep is allowed only when it provably skips .env* (and .git, which holds config)
        const ex = r.flags.filter((x) => x.name === '--exclude').map((x) => x.value);
        const exd = r.flags.filter((x) => x.name === '--exclude-dir').map((x) => x.value);
        if (!ex.includes('.env*') || !exd.includes('.git') || !files.length) return null;
      }
      return (files.length ? allPaths(files, S, c) : stdinOk(c) && !recursive) ? ok('L-READ') : null;
    }
    case 'rg': {
      const r = parseFlags(w, {
        short: 'nivwFlcSsoIH', shortVal: 'ABCemtT',
        long: { '--no-heading': true, '--heading': true, '--line-number': true, '--no-line-number': true, '--ignore-case': true, '--smart-case': true, '--fixed-strings': true, '--word-regexp': true, '--files-with-matches': true, '--count': true, '--only-matching': true, '--color': 'value', '--max-count': 'value', '--type': 'value', '--type-not': 'value', '--files': true, '--invert-match': true, '--context': 'value', '--after-context': 'value', '--before-context': 'value', '--with-filename': true, '--no-filename': true },
      });
      if (!r.ok) return null;
      const files = hasFlag(r.flags, '--files') || hasFlag(r.flags, '-e') ? r.pos : r.pos.slice(1);
      if (!hasFlag(r.flags, '--files') && !hasFlag(r.flags, '-e') && !r.pos.length) return null;
      return allPaths(files, S, c) ? ok('L-READ') : null;
    }
    case 'sed': {
      const s = sedInfo(c);
      if (!s.safe) return null;
      return (s.files.length ? allPaths(s.files, S, c) : stdinOk(c)) ? ok('L-READ') : null;
    }
    case 'find': {
      const f = findInfo(c);
      if (!f.readOnly) return null;
      for (const p of f.preds) if (Array.isArray(p) && p[0] === '-newer' && !pathOk(p[1], S, c)) return null;
      return allPaths(f.paths, S, c) ? ok('L-READ') : null;
    }
    case 'git': return gitAllow(c, S);
    case 'gh': return ghAllow(c, S);
    case 'npm': return npmAllow(c, S);
    case 'node': {
      if (w.length !== 2 || w[0].text !== '--test' || !TEST_FILE.test(w[1].text)) return null;
      return pathOk(w[1], S, c) ? ok('L-TEST') : null;
    }
    default: return null;
  }
}
