// Combines the per-tool rule sets; the strictest part wins. Filled in by the Bash and file rule tasks.
export function prefilter() {
  return { decision: 'ask', rule_id: 'K-DEFAULT', undecided: true, reason: 'Not matched by any rule.' };
}
