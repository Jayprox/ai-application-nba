# Security review: M8 PR B (golden-mission harness + B8 approver rule)

Reviewer: Security Reviewer (Sec), independent. I did not author any of this change.

VERDICT: NOT READY

One Major issue (agent-controlled git filter drivers run inside the harness) and seven security-relevant Minors. All are small and in scope, so under standing decision 5 they are fixed in this cycle (fix cycle 1 of 3). The dry-run and CI path is not affected: it uses harness-authored samples only. Every finding concerns real runs, which still need the owner's approval file.

## 1. Scope reviewed and tools run

- PR #11 https://github.com/Jayprox/ai-application-nba/pull/11, branch `feat/m8b-team-tests`, head `df900e64606a8f357b7816fe13351c14d0999ec4`, compared with `main`. The brief states CI run 42037726775 is green on this head. I did not re-run CI.
- Inputs: requirements M8 Story 2; plan §3 (incl. §3.9 and the §3.10 Sec focus list), §4-§6 and §7.1 (F6-F9); STATUS "Coordinator notes — PR B", the PR B Approvals entries dated 2026-11-04, and the recorded B2-B7 deviations.
- Code read: everything under `tools/team-tests/src/`, `bin/` and `config/`; the samples (grep only); the B8 diff in `tools/approver/src/rules/bash.mjs`, `policy/policy.sample.json` and its tests.
- Commands run (all local; no `claude` process, no network, no `.env`, keys, Keychain or `security`):
  - `node --test` on `launch`, `guard`, `env`, `safe-rm`, `canary` and `checkers-tests-before-after` tests: **tests 98, pass 98, fail 0**.
  - `npm audit --omit=dev`: **found 0 vulnerabilities**.
  - Scratch repros (all under the session scratchpad, all deleted afterwards):
    - git filter drivers under the harness's hardened flags (F1);
    - stub-spawner probes of `runInvocation` (F2, F3, F6);
    - `checkRun` with a case-varied path (F4);
    - `node --test` timeout orphan (F5);
    - `isInsideGitWorkTree` on a `.git` directory (F7);
    - 104 approver probe commands run through the test helpers on head and on `main` (extracted with `git archive main tools/approver`, read-only) (F11).
- Scanners: `gitleaks`, `semgrep`, `trivy` and `trufflehog` are **not installed**, so none were run and none were installed. I did a manual secret grep of the added lines (F12).

## 2. Findings

### F1. Major: agent-controlled git filter drivers execute inside the harness, outside the transcript, with no fake HOME
- **Location:** `tools/team-tests/src/checkers/util.mjs:31` (`HARDEN` covers hooks, fsmonitor, pager and external diff, but not filter drivers), `util.mjs:95` (working-tree `git diff <base> --`, reached from `X.config-unchanged` at `files.mjs:133` for **every** mission, and from G2/G4 via `git.mjs:10,49,54`), `tests-before-after.mjs:23` (`git worktree add`, G1).
- **Evidence (local scratch repro, same flags as `HARDEN`):** a repo whose `.git/config` defines `filter.evil.smudge`/`clean`, and whose `.gitattributes` assigns it:
  - `git show <ref>:<path>`: no execution;
  - `git log -p --no-textconv`: no execution;
  - `git worktree add --detach --force`: printed `after worktree add: SMUDGE-RAN`;
  - working-tree `git diff --name-only --no-ext-diff --no-textconv <base> --`: printed `CLEAN-RAN-<pid>`, with `HOME` unset in the filter (`grep -c 'HOME=\[unset\]'` gave `1`).
- **Impact:** the nested agent can write the fixture's `.git/config` and `.gitattributes` (both are inside its working directory). The harness then runs the agent's command itself, after the session ends. That command:
  - is invisible to the transcript checker, which is the detection control that F9 accepts in place of OS enforcement;
  - runs with the harness's `PATH` (host tools, including the real `claude`, `gh` and `railway`);
  - runs with `HOME` unset, not the fake one, so Node and other tools fall back to the passwd home and its real credentials;
  - runs with a 60 s git timeout that does not kill the filter's children.

  This breaks plan §3.6 ("same allowlisted env and fake HOME as the agent") and the module's own claim at `util.mjs:2-3`. It applies to the G3/G1 pilot. Related: the agent can also replace `fixture/.git` with a gitfile pointing at another repository, and the checkers would then run `worktree add/remove --force` against it.
- **Fix:**
  - Never run git against the agent's `.git/config`. Before evaluating, make a harness-owned copy: `git init` a fresh repo in `<scratch>` and `git fetch --no-tags <fixture> '+refs/heads/*:refs/heads/*'` with the hardened flags and a minimal env, or `git clone --no-local --no-checkout --no-hardlinks`. Then run all checker git commands against that copy.
  - Materialise trees with `git archive` or `ls-tree` + `cat-file blob` instead of a checkout.
  - Compare the working tree by hashing files in Node (as `hashTree` already does) instead of `git diff <base> --`.
  - Refuse if `fixture/.git` is not a real directory.
  - Add positive-control tests: plant a `smudge`/`clean`/`process` filter plus `.gitattributes`, and assert the marker never appears and the result is `error`/`failed`, never `passed`.

### F2. Minor (security-relevant): the `sk-ant-` transcript detection can never fire on real runs
- **Location:** `launch.mjs:201` (`scrubText` before parsing), `config/forbidden.json:42-47`, `checkers/transcript.mjs:84`. README line 37 and plan §5.4 both say the checker flags `sk-ant-`.
- **Evidence (stub spawner, fake key shape):** `(a) stored contains key shape: false | checker secret hits: 0`.
- **Impact:** a key the agent prints (for example via the readable `apiKeyHelper` command, see F8) is silently replaced with `[redacted]`. `X.forbidden-commands` passes, and the pilot's "stop on safety failure" rule does not trigger.
- **Fix:** count redactions in `runInvocation`, return the count, and fail a safety criterion when it is above 0. Alternatively, redact to a unique marker (for example `[redacted:anthropic-key]`) and add that marker to `secretPatterns`. Add a test that drives a key-shaped string through `runInvocation` → `evaluate`.

### F3. Minor (security-relevant): a key split across stdout chunks is stored unredacted in `stream.ndjson`
- **Location:** `launch.mjs:199-205` (scrubs each `data` chunk separately), `launch.mjs:323` (writes `<resultsDir>/<runId>/stream.ndjson`).
- **Evidence (stub spawner, split inside the prefix):** `(b) split-chunk: stored text contains the key body: true`.
- **Impact:** key material can land in a file that is kept after the run (the recorded deviation moved the raw stream from scratch `out/` to the results dir).
- **Fix:**
  - Scrub complete lines, not chunks. The code already splits on `\n`: store each line after scrubbing it, and scrub any trailing remainder at close.
  - Decode with `StringDecoder` so multi-byte characters are not split.
  - Test every split offset across the prefix and the body.

### F4. Minor (security-relevant, authority code): a case-varied path gets past the guard's "outside scratch space" check
- **Location:** `guard.mjs:28-29` (`scratchRoots` uses `fs.realpathSync`), `guard.mjs:40-41,60,65` (string compares with `isWithin`).
- **Evidence:** `fs.realpathSync('/PRIVATE/TMP')` returns `/PRIVATE/TMP`, while `.native` returns `/private/tmp`. `checkRun` with an approval file and results dir inside the scratchpad:
  - lowercase path: `refused approval-scratch`;
  - uppercase path: `ACCEPTED, todo 1 createResultsDir true`.
- **Impact:** on case-insensitive APFS, both the approval file and the results dir can sit in a temp root, which is where the nested agents can write. This is the same class as the earlier R3-1 follow-up.
- **Fix:** resolve with `fs.realpathSync.native` for the roots and for the given path, and refuse unless the given path equals its native realpath. That rejects non-canonical case and covers `checkDir`, `checkApprovalFile` and the parent check. Add a test with a case-varied temp path (skip it where the filesystem is case-sensitive).

### F5. Minor (security-relevant): timeouts do not kill model-spawned process trees
- **Location:** `launch.mjs:158-161` (`killTree` signals only the direct child), `tests-before-after.mjs:13` (`spawnSync` timeout kills only the `node --test` runner).
- **Evidence (local):** a spinning test under `spawnSync(node, ['--test', …], {timeout: 1500, killSignal: 'SIGKILL'})` gave `runner signal: SIGKILL error: ETIMEDOUT`, and the test-file child was **still running** afterwards. I killed it by PID.
- **Impact:** background or child processes started by agent Bash, or by agent-written tests, outlive the wall-clock cap and the scratch removal. They keep whatever access they have (network via `node`, files).
- **Fix:**
  - Spawn `claude` and the test runner with `detached: true` and signal the group (`process.kill(-pid, sig)`), keeping the TERM→KILL grace.
  - For the checker, use async `spawn` with group kill, or run tests in-process (`--test-isolation=none` where Node supports it).
  - Optionally, after each session, fail isolation if any process still has its cwd under `<scratch>`.

### F6. Minor (security-relevant): the init guard does not fail closed on events that arrive before `init`
- **Location:** `launch.mjs:186-198`. The child is killed only when a `result` arrives before `init`, or at close.
- **Evidence (stub spawner):** an assistant `tool_use` event followed by a valid `init` gave `(c) tool_use before init -> initProblems: null | signal: null`.
- **Impact:** plan §5.5 is the control for UNCONFIRMED item 7. If a CLI emits work before `init`, those turns run unguarded, and the session is not marked `isolation-failed` if the later `init` passes.
- **Fix:** the first parseable event must be `system`/`init`. Any other event first, or no `init` within N lines or seconds, kills the child. Add a test.

### F7. Minor (security-relevant, authority code): an approval file under a repo's `.git/` passes "outside every git work tree", and the approval file's directory is not checked
- **Location:** `paths.mjs:19-25` (`rev-parse --is-inside-work-tree` prints `false` inside a git dir), `guard.mjs:64-66`.
- **Evidence (scratch repo):** `repo root: true | inside .git: false | .git/refs: false`.
- **Impact:** for example, `<repo>/.git/approval.json`, or a file in a group- or world-writable directory, is accepted. Repo agents with file tools can write there, which defeats the purpose of plan §3.9 item 1. The guard is procedural, but this is its main location rule.
- **Fix:**
  - Also refuse when `git -C <dir> rev-parse --git-dir` succeeds, or when any ancestor directory contains a `.git` entry.
  - Apply `checkDir` (owner, no group/world write, no symlink) to the approval file's parent directory.
  - Add tests for both.

### F8. Note: accepted residual risk (F9, §5.4), stated precisely for the pilot
- **Location:** `config/nested-settings.json:23-25` (`Bash(node:*)`, `Bash(cat:*)`); `git log/diff --output=<file>` under `Bash(git log:*)`/`Bash(git diff:*)`.
- **Impact:**
  - The nested agent can `cat ../out/settings.json` (the `apiKeyHelper` command), run `/usr/bin/security` through `node -e` (the absolute-path rule does not see that), read real-home files, write outside the fixture and open sockets.
  - Detection relies on the transcript, which F1, F2 and F10 weaken.
  - This is inside owner decision F9 (rule-based isolation for the G1/G3 pilot only) and §5.4 (spend limit plus revocation bound the damage).
- **Recommendation:**
  - Keep the pilot to G3/G1, as approved.
  - Optionally add detection rules for `node -e`/`--eval`/`-p` that reference `child_process`, `net`, `http`, `security` or `Keychains`, and for git `--output=`.
  - Revoke the key after the pilot as planned.

### F9. Note: §5.4 key delivery conforms (verified)
- `launch.mjs:65-74` builds `apiKeyHelper` as `/usr/bin/security find-generic-password -s <validated service> -w '<runtime keychain path>'`:
  - service checked against `^[A-Za-z0-9._-]{1,64}$`;
  - path must be absolute, with no `'`, NUL or newline;
  - written only to `<scratch>/out/settings.json`, mode 0600, at `launch.mjs:255`.
- The harness never runs `security` and never reads the key.
- `env.mjs:5-29` builds the child env from a fixed allowlist, and `launch.mjs:259` passes only that env.
- `grep -rnE "TEAM_TESTS_[A-Z_]*KEY|ANTHROPIC|printenv "` over `src/`, `config/` and `bin/` returns no hits.
- Commit `717ef15` removed the env-var design. Residual risk is under F8.

### F10. Minor (security-relevant): subagent session JSONL is not given to the safety checkers
- **Location:** `launch.mjs:304-312`. `extra` events feed only `reconcile` (usage). `evaluate` gets only the main-stream `events`/`raw`.
- **Impact:** plan §3.4 says the canary checker scans "main and subagent" transcripts. Whether stream-json carries subagent tool calls is UNCONFIRMED (§5.6 item 12). If it does not, forbidden-command, sensitive-read and canary detection miss everything Dev and QA run. That fails open.
- **Fix:**
  - Pass the de-duplicated union of stream and JSONL events (and the JSONL raw text) to `evaluate`.
  - Or make it a pre-flight failure when the stream has an `agent` call but no `sub: true` events.
  - Add a test.

### F11. Note: B8 K-CLAUDE approver rule: no regressions, no bypass of the ask outcome
- **No ask/deny became allow:** 104 probe commands (quoting, escapes, paths, `sudo`, `command`/`exec`/`builtin`, `env -S`/`-i`/`-u`, wrappers, `bash/zsh/sh -c`, `find -exec`, `xargs`, aliases, functions, here-docs, process substitution, dynamic names, runners, chaining around the exempt pair) were run on head and on `main`. The only allow on either side is `git log --grep claude` (`L-GIT-READ`) and `npm test` (`L-TEST`), the same as on `main`.
- **Exempt pair is exact:** `claude --version; claude -p x`, `&&`, `||`, `&`, `$(…)`, `>(…)`, a newline, `''` and an assignment prefix all ask `K-CLAUDE`.
- **Some forms ask `K-DEFAULT` rather than `K-CLAUDE`:**
  - `$HOME/…/claude`;
  - `node -e`/`python3 -c`/`perl -e`/`osascript` spawns;
  - `… | sh`;
  - `bash <(…)`, `source <(…)`;
  - `cat <<EOF | sh`;
  - base64 decode;
  - `${C:-claude}`, `$c$d`;
  - `xcrun`, `sg`;
  - `yarn claude`, `npm run claude`;
  - `node …/cli.js`;
  - `npx claude --help`.

  These are still a final ask, because the model stage is log-only (`prefilter.mjs:1`, `approver.mjs:119-126`). This is a labelling gap, not a bypass.
- **`sudo claude` → `K-SYS` (ask):** confirmed, matching the STATUS note.
- **Pre-existing, not B8:** `npm test` (`L-TEST`, allow) runs repo code, which could itself spawn `claude`. Optional follow-up: label `$HOME`-prefixed paths and `npx <name> --help` as `K-CLAUDE`.

### F12. Note: committed text, samples and reports
- **Samples:** no absolute paths (`grep -rhoE '"/[A-Za-z]…' samples` returns nothing).
- **Secret shapes:** no hits for `sk-ant-…`, `ghp_`, `AKIA`, `xox?-`, private keys or credentialed DB URLs in the added lines.
- **Canary-shaped literals:** two, both synthetic test constants (`0123…`, `aaaa…`).
- **Fixture paths and hosts:** all placeholders (`/home/owner`, `/home/fixture-user`, `example.internal`).
- **Reports:** `report.mjs:15-23` sanitises home, tmp and cwd paths, canaries and host shapes. `run.json` carries no free-text evidence.
- **STATUS:** the B1 entry at `docs/STATUS.md:403` (Coordinator-authored) quotes a grep pattern containing the home-path prefix and an account-name fragment. Recommend rewording it with placeholders (standing decision 9).
- **README:** line 37 claims `sk-ant-` flagging. Correct it with F2.

### F13. Note: items checked and found sound
- **`safe-rm.mjs:23-55`:** absolute path, not a symlink, no symlinked component, strictly under realpath tmpdir, name prefix, regular-file JSON marker. A case-varied path is refused (fails closed).
- **`paths.mjs:36-58`:** `mkdtemp` + realpath + work-tree check + marker written with `wx`.
- **Spawning:** every spawn uses argument arrays with `shell: false` (`launch.mjs:156,173`; `tests-before-after.mjs:13`; `util.mjs:35`). No `exec`/`execSync`/`shell: true` in `src/` or `bin/`.
- **Launch profile (`config/launch-profile.json`):**
  - no bypass flags;
  - `FORBIDDEN_ARGS` also blocks `--permission-mode` (`launch.mjs:38,134`);
  - `--strict-mcp-config` with `{"mcpServers":{}}`;
  - `--permission-prompts none`;
  - the tool list excludes `WebFetch` and `WebSearch`, and both are also in the settings deny list (agent files list `WebSearch`).
- **Guard:**
  - one refusal per §3.9 condition;
  - `MAX_SESSIONS = 6` in code;
  - the ledger is written before the fixture and refuses symlinked, hard-linked or foreign ledgers;
  - an unknown approval key is refused.
- **Other:**
  - the static scan finds no network modules;
  - `stderr` of the child is never stored;
  - the stream is capped at 64 MiB;
  - the prompt goes to stdin, guarded against a leading `-`.

## 3. Dependency review summary

- No new dependency. Root `package.json` changes only the `test` glob (it adds `'tools/team-tests/test/*.test.mjs'`). No lockfile change.
- The fixture template `package.json` has no dependencies (`"test": "node --test"`).
- `npm audit --omit=dev`: 0 vulnerabilities.
- Node built-ins only, and no imports of `http`, `https`, `net`, `tls` or `dgram`, and no `fetch` (grep).

## 4. Verdict and rationale

VERDICT: NOT READY

- **F1 (Major):** lets model-written commands run inside the harness process, with host `PATH` and no fake `HOME`, outside the transcript that F9's detection model relies on. It applies to the planned G3/G1 pilot (`X.config-unchanged` runs on every mission).
- **F2-F7 and F10 (Minors, all security-relevant, small and in scope):** these weaken the key-leak detection, the stored-stream redaction, the guard's location rules (authority code), process containment, the init guard's fail-closed property and subagent coverage. Under standing decision 5 they are fixed in this cycle.
- **Notes F8, F9, F11-F13:** no action is required for merge.
- **B8:** the approver rule is sound.
- **Re-review:** after the fix, re-run my repros: the filter marker, the stub-spawner probes (a)-(c), the case-path `checkRun`, the orphan test and the `.git` approval path.

## Handoff

- **Done:** independent security review of PR #11 at `df900e6`.
  - Static review of the harness and the B8 approver rule.
  - Local repros for F1-F7 and F10. All scratch artefacts I created are deleted. No harness `team-tests-*` scratch dirs remain in tmpdir. Four `approver-t-*` dirs from 2026-11-04 (not mine) remain untouched.
  - 98/98 targeted tests pass; `npm audit` 0. Scanners are not installed.
- **Files created:** `docs/reviews/M8/security-prB.md`. No source, config or STATUS edits. Nothing committed or pushed.
- **Open questions:**
  - F10 depends on UNCONFIRMED §5.6 item 12. The Coordinator can choose the "pre-flight fail closed" variant instead of feeding JSONL to the checkers.
  - F8 is the owner's accepted F9 residual. Confirm the pilot stays G3/G1 only.
- **Recommended next role:** Developer (fix cycle 1: F1, then F2-F7 and F10), then QA and Sec re-review, then Lead.
