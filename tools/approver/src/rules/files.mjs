// Edit, Write, NotebookEdit (plan table 3.6). Contents (content, old_string, new_string, new_source) are
// never read here: only the path, the branch and the repo layout matter.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeText } from '../shell/normalize.mjs';
import { realResolve, isInside, buildPathCtx, classifyPath, matchGlobs, textSecret, expandHome, branchIsProtected } from '../paths.mjs';

const SPECS = {
  Write: { path: 'file_path', required: ['file_path', 'content'], strings: ['file_path', 'content'], optional: [] },
  Edit: { path: 'file_path', required: ['file_path', 'old_string', 'new_string'], strings: ['file_path', 'old_string', 'new_string'], optional: ['replace_all'] },
  NotebookEdit: { path: 'notebook_path', required: ['notebook_path', 'new_source'], strings: ['notebook_path', 'new_source', 'cell_id', 'edit_mode', 'cell_type'], optional: ['cell_id', 'edit_mode', 'cell_type'] },
};

const res = (decision, rule_id, policy, undecided = false) => ({ decision, rule_id, undecided, reason: policy.rules[rule_id]?.reason || rule_id });

// Sec R1/C2-1: git also accepts a directory as its git dir when it holds HEAD, objects/ and refs/ (no `.git` name needed), and then
// honours its `config` and `hooks/`. APFS is case-insensitive, so every name is compared lower-cased. The rule must not depend on write
// order, so it is symmetric: the "marker" names are head, packed-refs, config, objects, refs, hooks. Writing head or packed-refs is ask
// anywhere. Writing config, or anything under objects/refs/hooks/info, is ask when the directory it belongs to already holds ANY OTHER
// marker. One marker alone (lib/config, lib/hooks/useX.js, docs/refs/a.md) stays an ordinary edit; a second one, in any order, asks.
const GIT_MARKERS = new Set(['head', 'packed-refs', 'config', 'objects', 'refs', 'hooks']);
const GIT_SUBDIRS = new Set(['objects', 'refs', 'hooks', 'info']);
function markersIn(dir) {
  try { return fs.readdirSync(dir).map((n) => n.toLowerCase()).filter((n) => GIT_MARKERS.has(n)); } catch { return []; }
}
function looksLikeGitDirFile(real) {
  const base = path.basename(real).toLowerCase();
  if (base === 'head' || base === 'packed-refs') return true;
  if (base === 'config' && markersIn(path.dirname(real)).some((m) => m !== 'config')) return true;
  const segs = real.split('/');
  for (let i = segs.length - 2; i > 0; i--) {
    const seg = segs[i].toLowerCase();
    if (!GIT_SUBDIRS.has(seg)) continue;
    const dir = segs.slice(0, i).join('/') || '/';
    if (markersIn(dir).some((m) => m !== seg)) return true;
  }
  return false;
}

export function fileRules({ tool, input, cwd, branch, ctx, folded = false }) {
  const policy = ctx.policy;
  const spec = SPECS[tool];
  const shape = () => res('ask', 'K-SHAPE', policy);
  if (!spec) return shape();
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) return shape();
  for (const k of spec.required) if (!(k in input)) return shape();
  for (const k of spec.strings) if (k in input && typeof input[k] !== 'string') return shape();
  if ('replace_all' in input && typeof input.replace_all !== 'boolean') return shape();
  const target = input[spec.path];
  if (target === '' || target.includes('\0')) return shape();

  // Sec 4: APFS folds case with Unicode rules (U+017F, U+FB01 ...), so a non-ASCII path can alias an ask-listed or
  // protected one. Judge the folded form: a deny there stays deny, everything else is ask, never allow.
  if (!folded && /[^\x00-\x7f]/.test(target)) {
    const f = fileRules({ tool, input: { ...input, [spec.path]: normalizeText(target).text }, cwd, branch, ctx, folded: true });
    return f.decision === 'deny' ? f : res('ask', 'K-UNICODE', policy);
  }
  // `~user/...` is not expanded by the approver: anything but `~` or `~/` is ask
  if (/^~[^/]/.test(target)) return res('ask', 'K-OUTSIDE', policy);

  const pc = buildPathCtx(ctx);
  const cw = realResolve(cwd);
  if (!cw.ok) return shape();
  const expanded = expandHome(target, pc.home) ?? target;
  const r = realResolve(expanded, cw.real);
  if (!r.ok) {
    // cannot resolve: ask, but deny if the text itself names something protected or secret
    const ts = textSecret(expanded);
    const L = expanded.toLowerCase();
    if (pc.markers.some((m) => L.includes(m))) return res('deny', 'D-SELF', policy);
    if (ts.envfile) return res('deny', 'D-SECRET-ENVFILE', policy);
    if (ts.secret) return res('deny', 'D-SECRET-PATH', policy);
    return shape();
  }
  const k = classifyPath(r.real, pc);
  // Order matters (A10): the deny on protected paths always wins over the edit allow.
  if (k.protected) return res('deny', 'D-SELF', policy);
  if (k.envfile) return res('deny', 'D-SECRET-ENVFILE', policy);
  if (k.secret) return res('deny', 'D-SECRET-PATH', policy);
  if (!isInside(r.real, pc.repoRoot)) return res('ask', 'K-OUTSIDE', policy);
  if (matchGlobs(k.rel, policy.paths.approver_src_globs)) return res('ask', 'K-SELF-SRC', policy);
  if (looksLikeGitDirFile(r.real)) return res('ask', 'K-PATH', policy);
  if (k.secretish || matchGlobs(k.rel, policy.paths.ask_globs)) return res('ask', 'K-PATH', policy);
  if (branchIsProtected(branch, policy)) return res('ask', 'K-BRANCH', policy);
  return res('allow', 'L-EDIT', policy);
}
