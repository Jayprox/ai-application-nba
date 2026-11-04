// Edit, Write, NotebookEdit (plan table 3.6). Contents (content, old_string, new_string, new_source) are
// never read here: only the path, the branch and the repo layout matter.
import { realResolve, isInside, buildPathCtx, classifyPath, matchGlobs, textSecret, expandHome, branchIsProtected } from '../paths.mjs';

const SPECS = {
  Write: { path: 'file_path', required: ['file_path', 'content'], strings: ['file_path', 'content'], optional: [] },
  Edit: { path: 'file_path', required: ['file_path', 'old_string', 'new_string'], strings: ['file_path', 'old_string', 'new_string'], optional: ['replace_all'] },
  NotebookEdit: { path: 'notebook_path', required: ['notebook_path', 'new_source'], strings: ['notebook_path', 'new_source', 'cell_id', 'edit_mode', 'cell_type'], optional: ['cell_id', 'edit_mode', 'cell_type'] },
};

const res = (decision, rule_id, policy, undecided = false) => ({ decision, rule_id, undecided, reason: policy.rules[rule_id]?.reason || rule_id });

export function fileRules({ tool, input, cwd, branch, ctx }) {
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
  if (k.secretish || matchGlobs(k.rel, policy.paths.ask_globs)) return res('ask', 'K-PATH', policy);
  if (branchIsProtected(branch, policy)) return res('ask', 'K-BRANCH', policy);
  return res('allow', 'L-EDIT', policy);
}
