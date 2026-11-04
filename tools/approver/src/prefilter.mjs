// Combines the per-tool rule sets. The decision is final; the model never overrides it (Q8 b).
import { bashRules } from './rules/bash.mjs';

function checkPolicyShape(policy) {
  if (!policy.rules || !policy.bash || !policy.paths || !policy.branches) throw new Error('policy_incomplete');
}

export function prefilter({ tool, input, cwd, branch, ctx }) {
  checkPolicyShape(ctx.policy);
  if (tool === 'Bash') return bashRules({ input, cwd, branch, ctx });
  return { decision: 'ask', rule_id: 'K-DEFAULT', undecided: true, reason: 'Not matched by any rule.' };
}
