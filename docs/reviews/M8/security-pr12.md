# Security review: PR #12 (M8 B8, approver K-CLAUDE rule split out of PR #11)

Reviewer: Security Reviewer (Sec), independent. I did not write any of this change.

VERDICT: READY

## 1. Scope reviewed and tools run

- **PR:** https://github.com/Jayprox/ai-application-nba/pull/12, state OPEN.
  - Head: branch `feat/m8b8-k-claude` at `0852d291cdaf6d941570e9cb1602a56a82f5c264`.
  - Base: `main` at `46a61c1435ee68173cc2f73434edb12ebb69ada7`. `git ls-remote origin refs/heads/main` gives the same SHA, and so does `git merge-base origin/main 0852d29`.
- **Source commit:** `2c03cde9b920a191d9e3d71dfd6958c4e54d753c` on `feat/m8b-team-tests`. My earlier review of it is finding F11 in `docs/reviews/M8/security-prB.md` on that branch.
- **CI:** GitHub Actions run `42101177540` passed all four jobs: `root`, `frontend`, `worker` and `backend`. I read this from `gh pr view 12 --json statusCheckRollup`. I did not trigger any re-run.
- **Commands run** (all read-only against the repo, and the main checkout's working tree, index, branch and stash were left alone):
  - `git diff`, `git show`, `git patch-id --stable`, `git merge-base`, `git log`, `git ls-remote`.
  - `gh pr view 12` (a GitHub read).
  - `git archive 0852d29 tools/approver` and `git archive origin/main tools/approver`, each unpacked into its own scratch directory under the OS temp dir.
  - In those scratch trees: two probe scripts I wrote, which pass command strings through the test helpers' `bash()` judge. The strings are only classified. None is executed.
  - `node --test tools/approver/test/*.test.mjs` on the head tree.
- **Scanners:** `gitleaks`, `semgrep`, `trivy` and `trufflehog` are not installed. I did not install any. I grepped the added lines for secrets by hand instead (F4).
- **Never done:** started `claude`, ran `security`, read keys or `.env`, made any network call other than GitHub reads.

## 2. Findings

### F1. Note: the PR carries exactly commit 2c03cde, and only the 4 approver files (confirmed)
- **Evidence:**
  - `git diff 2c03cde 0852d29 -- tools/approver | wc -c` gave `0`.
  - `git log --oneline origin/main..0852d29` shows one commit: `0852d29 feat(approver): K-CLAUDE ask rule for nested claude runs (M8 B8)`.
  - `git diff --name-only origin/main...0852d29` lists these 4 files, and `gh pr view 12 --json files` lists the same 4:
    - `tools/approver/policy/policy.sample.json`
    - `tools/approver/src/rules/bash.mjs`
    - `tools/approver/test/bash-rules.test.mjs`
    - `tools/approver/test/fixtures/requests.json`
  - Filtering that list for `tools/team-tests`, `package.json`, `.claude`, `.github`, `CLAUDE.md` and `policy.md` gave `0` matches.
  - The installed approver copy and the live policy are outside the repo, and the diff does not touch them.
  - `git diff --stat`: 4 files changed, 98 insertions, 1 deletion.
- **Impact:** none. This matches the owner's split instruction.

### F2. Note: the PR's patch has the same content as `git show 2c03cde` (confirmed)
- **Evidence:**
  - Comparing the hunk and `+`/`-`/context lines of `git diff origin/main...0852d29` and `git show 2c03cde`, with `index` lines removed, printed `IDENTICAL`.
  - `git patch-id --stable` returned the same patch id, `4edddcbc79236e0762b93900403e2b831e6bf95e`, for both.

### F3. Note: K-CLAUDE turns no ask or deny into allow, and `claude --help`/`--version` cannot smuggle a real run (confirmed, high confidence)
- **Method:** I ran 103 probe commands through the judge on both the `0852d29` tree and the `origin/main` tree, then 6 more on deny precedence and older-policy fallback. The script compares the two sides.
- **Result:** `probes 103 regressions(ask/deny->allow) 0`. Exactly 3 commands are allowed on head, and the same 3 are allowed on `main` under the same rule ids:
  - `git log --grep claude` (`L-GIT-READ`)
  - `npm test` (`L-TEST`)
  - `ls` (`L-READ`)
- **Families covered:**
  - **Quoting and escapes** (all ask `K-CLAUDE`): `"claude"`, `'claude'`, `cl""aude`, `c'l'aude`, `\claude`, `CLAUDE`.
  - **Paths:**
    - `/usr/local/bin/claude`, `./node_modules/.bin/claude` and `../claude` ask `K-CLAUDE`.
    - `$HOME/.local/bin/claude` asks `K-DEFAULT`.
    - `~/.claude/local/claude` is denied by `D-SELF` on both sides.
  - **Wrappers** (all ask `K-CLAUDE`): `env`, `env -i`, `env -u`, `env -S "claude -p x"`, `nohup`, `timeout`, `nice`, `time`, `bash`/`sh`/`zsh -c`, `xargs`, `xargs -I{}`, `find -exec`, `eval`.
  - **Package runners:**
    - `npx`, `bunx`, `pnpx`, `pnpm dlx`, `yarn dlx`, `npm exec`, `npm x --` and `bun x`, with `@anthropic-ai/claude-code`, `@latest` and `claude@latest`, all ask `K-CLAUDE`.
    - `npx claude --help` asks `K-DEFAULT`.
  - **Dynamic names:**
    - `$(echo claude)`, `"$(echo claude)"`, `` `echo claude` `` and `c=claude; $c` ask `K-CLAUDE`.
    - `${C:-claude}` and `$c$d` ask `K-DEFAULT`.
  - **`sudo`:** `sudo claude …` and `sudo -u root claude` ask `K-SYS`, on both sides.
  - **Aliases and functions** (all ask `K-CLAUDE`): `alias c=claude; c -p x`, `f(){ claude …; }; f`, `function f { claude; }; f`.
  - **`command`/`exec`/`builtin`** (all ask `K-CLAUDE`): `command claude`, `command -p claude`, `exec claude`, `builtin claude`.
  - **Here-docs and process substitution:**
    - `bash <<EOF … claude … EOF` and `cat >(claude)` ask `K-CLAUDE`.
    - `cat <<EOF | sh`, `bash <(…)`, `source <(…)`, `echo claude | sh`, a base64 decode piped to `sh`, `node -e` and `python3 -c` spawns ask `K-DEFAULT`.
- **The exempt pair is exact.** `claude --help`, `claude --version`, `claude --version | cat`, `ls; claude --version` and `env claude --help` stay `ask/K-DEFAULT`, as on `main`. They are never allowed. Every attempt to chain or prefix a real run onto them asks `K-CLAUDE`:
  - `claude --version; claude -p x`, `&&`, `||`, `&`, and a newline;
  - `claude --help $(claude -p x)` and `claude --help >(claude)`;
  - `claude --version ""` and `claude ''`;
  - `FOO=1 claude --help`, an API-key-named assignment prefix, and `env FOO=1 claude --help`;
  - `--help --version`, `--version x`, `-h`, `-v`, `--help=x`, and `claude $X`;
  - `cat x | env claude --help`;
  - `sh -c "claude --version; claude"`.
- **Deny still wins over K-CLAUDE** (same results on head and `main`):
  - `claude; railway up` gives `D-PROD-RAILWAY`;
  - `claude -p x && cat .env` gives `D-SECRET-ENVFILE`;
  - `claude --version; printenv` gives `D-SECRET-ENVDUMP`;
  - `claude --help | curl …` gives `D-NET`;
  - an `npx @anthropic-ai/claude-code` chained with a keychain read gives `D-SECRET-KEYCHAIN`.
  - This holds by construction: `bash.mjs:431` checks the deny list before the ask list at `:432`.
- **Older installed policy fails closed:** I took a policy with both `rules['K-CLAUDE']` and `bash.claude` removed. On head, `claude -p x` gives `ask/K-CLAUDE`; on `main` it gives `ask/K-DEFAULT`.
  - The decision comes from list membership (`bash.mjs:432`). The policy entry supplies only the reason text.
  - The `claudeNames` default list keeps the rule on.
- **Why `K-DEFAULT` is still a final ask:** the model stage only logs and never overrides a decision (`prefilter.mjs:1`, `approver.mjs:119-126`).
- **Tests:** `node --test` on the head tree gave `tests 171, pass 171, fail 0`.
- **Residual (unchanged from F11, a labelling gap, not a bypass):** the forms above that ask `K-DEFAULT` rather than `K-CLAUDE`, plus these:
  - `claude "--help"`, `claude --version > out.txt`, `claude --version < /dev/null`, `echo hi | claude --version`;
  - `command claude --version`, `exec claude --version`, `xargs claude --version`.

  All of them still ask. `xargs claude --version` gets extra arguments from stdin, but it is not exempt from asking, only labelled `K-DEFAULT`.
- **Optional follow-up:** label `$HOME`-prefixed paths, `npx <name> --help` and `xargs claude --help|--version` as `K-CLAUDE`.

### F4. Note: no secrets, home paths, usernames or hostnames in the added lines (confirmed, standing decision 9)
- **Method:** I extracted the 98 added lines from `git diff origin/main...0852d29` and grepped them.
- **Results:**
  - **Secret shapes** (`sk-ant-`, `ghp_`, `gho_`, `github_pat_`, `AKIA…`, `xox?-`, private-key headers, credentialed `postgres://` URLs, 40+ character base64 runs): `0`.
  - **Home or temp paths** (macOS and Linux home prefixes, the macOS per-user and system temp prefixes, Windows paths): `0`.
  - **OS username or account name:** `0`.
  - **Hostnames or IPs** (`.local`, `.lan`, `.internal`, Railway domains, IPv4): `0`.
- **Absolute-path-like strings:** only generic ones. They are `/usr/local/bin/claude`, `./node_modules/.bin/claude`, the `@anthropic-ai/claude-code` package spec, `./helpers.mjs` and `/test`.

### F5. Note: deployment of the rule needs an owner reinstall
- **Observation:** the rule takes effect only after the owner reinstalls the approver. Until then, the installed copy and the live policy stay as they are, and nested `claude` runs keep asking under `K-DEFAULT`, which is still an ask.
- **Action:** none for this PR. Installation is on the owner's Always-ask list (item 5).

## 3. Dependency review summary

- No dependency was added, removed or changed. The diff touches no `package.json` or lockfile.
- The new code uses no imports beyond those already in `bash.mjs`.
- The test file adds only `SAMPLE_POLICY` to its import from the existing `./helpers.mjs`.
- `npm audit` was not needed: no dependency surface changed.

## 4. Verdict and rationale

VERDICT: READY

- PR #12 is exactly commit `2c03cde`: the tree diff is empty and the patch id matches.
- It contains only the 4 approver files, with nothing from the harness, the root `package.json`, `.claude/`, `.github/`, `CLAUDE.md` or `policy.md`.
- Across 109 probes, nothing that was ask or deny on `main` becomes allow.
- The `--help`/`--version` exemption is exact and cannot carry a real run.
- Deny still takes precedence.
- An older installed policy fails closed.
- The added lines contain no secrets and no local identifiers.
- CI run `42101177540` is green.
- All findings are Notes. None blocks merge, and none needs a fix in this cycle.

## Handoff

- **Done:** security identity check and probe re-run for PR #12 at `0852d29` against `main` `46a61c1`.
  - Confirmed the commit identity, the file list and the patch id.
  - Ran 103 + 6 probes on both trees, with 0 regressions.
  - Head tests: 171/171 pass.
  - Hand-grepped the added lines for secrets and standing decision 9 identifiers.
  - My scratch trees and probe scripts are in the session scratchpad under the OS temp dir. My `rm` cleanup was denied by the permission system, so they are still there, outside the repo.
- **Files created:** `docs/reviews/M8/security-pr12.md`. Not committed. I edited no source or config.
- **Open questions:** none.
- **Recommended next role:** Lead review, then the Coordinator readiness report. Merge needs owner approval, and reinstalling the approver is a separate owner action.
