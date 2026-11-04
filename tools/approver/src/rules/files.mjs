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

// Sec R1: git also accepts a directory as its git dir when it holds HEAD, objects/ and refs/ (no `.git` name needed), and then
// honours its `config` and `hooks/`. Simple rule: a file named HEAD or packed-refs is ask anywhere; `config` is ask when a HEAD or
// objects or refs sits next to it; anything under objects/, refs/ or hooks/ (and info/) whose parent holds a HEAD is ask.
// Plain source trees (src/config, docs/refs.md, lib/hooks/useX.js with no HEAD file beside them) stay ordinary edits.
function looksLikeGitDirFile(real) {
  const base = path.basename(real);
  if (base === 'HEAD' || base === 'packed-refs') return true;
  const has = (dir, name) => { try { fs.lstatSync(path.join(dir, name)); return true; } catch { return false; } };
  if (base === 'config' && ['HEAD', 'objects', 'refs'].some((n) => has(path.dirname(real), n))) return true;
  const segs = real.split('/');
  for (let i = segs.length - 2; i > 0; i--) {
    if (['objects', 'refs', 'hooks', 'info'].includes(segs[i]) && has(segs.slice(0, i).join('/') || '/', 'HEAD')) return true;
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
