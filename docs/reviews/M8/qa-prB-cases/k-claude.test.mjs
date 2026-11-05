// QA-owned probes for approver rule K-CLAUDE (M8 B8). Judges command STRINGS only; nothing is executed.
//   node --test docs/reviews/M8/qa-prB-cases/k-claude.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const T = fileURLToPath(new URL('../../../../tools/approver/test/helpers.mjs', import.meta.url));
const { makeEnv, seedRepo, cleanup, bash, SAMPLE_POLICY } = await import(T);
const env = seedRepo(makeEnv({ branch: 'feat/test' }));
test.after(() => cleanup(env));
const j = (c) => bash(env, c);

// [command, decision, rule]. rule null = only the decision is asserted.
const ASK = [
  'claude', 'claude -p hi', 'claude --help --version', 'claude --help foo', 'claude -h', 'claude -v', 'claude --version -p x',
  '/usr/local/bin/claude -p x', './claude -p x', '~/.local/bin/claude -p x', 'CLAUDE -p x', '"claude" -p x', "'claude' -p x", '\\claude -p x', 'cl""aude -p x',
  'FOO=1 claude --help', 'env claude -p x', 'env FOO=1 claude --help', 'nohup claude -p x', 'time claude -p x', 'command claude -p x', 'exec claude -p x',
  'xargs claude -p', 'sh -c "claude -p x"', 'bash -c "claude --help; claude -p x"', 'zsh -c "claude -p x"', 'eval "claude -p x"',
  'x=claude; $x -p y', 'c=cla; $c"ude" -p y', '$(echo claude) -p x', '`echo claude` -p x', 'echo hi | claude -p x', 'echo hi | claude --help',
  'true && claude -p x', 'false || claude -p x', 'ls; claude -p x', '(claude -p x)', '{ claude -p x; }', 'if true; then claude -p x; fi', 'for i in 1; do claude -p x; done',
  'npx claude -p x', 'npx @anthropic-ai/claude-code -p x', 'npx @anthropic-ai/claude-code@latest --help', 'bunx @anthropic-ai/claude-code', 'pnpm dlx @anthropic-ai/claude-code',
  'yarn dlx @anthropic-ai/claude-code', 'npm exec claude -- -p x', 'npm exec @anthropic-ai/claude-code', 'pnpm exec claude -p x', 'bun x claude -p x', 'npx claude@latest -p x', 'npx --yes claude --help',
  'claude --help && claude -p x', 'claude --help; claude', 'claude --help > /dev/null', 'claude --help | cat', 'claude --version &',
  'timeout 5 claude -p x', 'nice claude -p x', 'ssh host claude', 'watch claude -p x', 'find . -exec claude -p x \;',
];
const ASK_RULE_K_CLAUDE_OR_STRONGER = (r) => r.decision === 'ask' || r.decision === 'deny';

test('every run form asks or denies, never allows', () => {
  const bad = [];
  for (const c of ASK) { const r = j(c); if (!ASK_RULE_K_CLAUDE_OR_STRONGER(r)) bad.push(`${c} -> ${r.decision}/${r.rule_id}`); }
  assert.deepEqual(bad, []);
});

test('K-CLAUDE is the rule id for the plain forms', () => {
  for (const c of ['claude -p x', '/usr/bin/claude -p x', 'claude -h', 'npx @anthropic-ai/claude-code -p x', 'pnpm dlx @anthropic-ai/claude-code', 'bash -c "claude -p x"'])
    assert.equal(j(c).rule_id, 'K-CLAUDE', c);
});

test('owner exemption: exactly --help and --version keep today result (not K-CLAUDE)', () => {
  for (const c of ['claude --help', 'claude --version', '/usr/local/bin/claude --help']) assert.notEqual(j(c).rule_id, 'K-CLAUDE', c);
});

test('claude as a plain argument is not a run', () => {
  for (const c of ['which claude', 'grep claude README.md', 'ls docs/claude', 'cat CLAUDE.md', 'echo claude', 'git log --grep claude', 'git commit -m "claude notes"', 'cd claude-dir'])
    assert.notEqual(j(c).rule_id, 'K-CLAUDE', c);
});

test('K-CLAUDE is ask, not undecided: sample policy decision for the rule', () => {
  assert.equal(SAMPLE_POLICY.rules['K-CLAUDE'].decision, 'ask');
  assert.deepEqual(SAMPLE_POLICY.bash.claude, ['claude']);
});
