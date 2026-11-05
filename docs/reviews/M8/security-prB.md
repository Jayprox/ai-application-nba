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

---

## Re-review cycle 2 (at d769aa0)

Reviewer: Security Reviewer (Sec), independent. I did not author any of the cycle 2 changes.

VERDICT: READY WITH CONDITIONS

All eight prior findings (F1 Major, F2-F7 and F10 Minors) are closed: I re-ran my original repros plus extra vectors. Two new security-relevant Minors remain:
- **R2-1:** introduced by the F1 copy code.
- **R2-2:** existed before this cycle, but the F1 copy makes it a small fix.

Neither lets agent code run in the harness, and neither turns a failure into a pass for the F1 vectors. R2-2 does let a deliberately hostile team make three safety criteria pass falsely. Under standing decision 5, both are small and in scope, so they are fixed in cycle 3 of 3.

### 1. Scope and tools

- **Commits:** PR #11, branch `feat/m8b-team-tests`, head `d769aa0b341361d75eba20017e1978932ae88e7d`. Diff reviewed: `git diff df900e6..d769aa0 -- tools/`.
- **CI:** `gh run view 42045857575` gives headSha `d769aa0b…`, status completed, conclusion success. Jobs backend, worker, root and frontend all succeeded.
- **Files changed per commit** (`git show --stat`):
  - Code commits `b4d4ce3`, `3b74efc`, `e9ae003`, `0931dd4`, `875d293`, `fd7a725` and `d769aa0` touch only `tools/team-tests/` (src, test, README).
  - Docs commits `55a6e6f` and `877f25e` touch only `docs/STATUS.md` and `docs/reviews/M8/`.
  - No change to `package.json`, lockfiles, `.github/`, `.claude/`, `tools/approver/` or `CLAUDE.md`.
- **Tests:** in a scratch clone at `d769aa0` under the session scratchpad, `node --test tools/team-tests/test/*.test.mjs` gave **tests 219, pass 219, fail 0** (node v26, git 2.54).
- **Repros:** all local, against the clone. No `claude`, no `security`, no network beyond `gh run view`, and no `.env` or keys read. The scripts:
  - F1 extra vectors;
  - stub-spawner probes for F2, F3 and F6;
  - a real default-spawner probe on a local fake executable (not `claude`) for F5;
  - a `checkRun` path-trick probe for F4 and F7;
  - F10 dedupe and fail-closed checks;
  - replace-ref and `.gitignore` probes.
- **Scanners:** `gitleaks`, `semgrep`, `trivy` and `trufflehog` are not installed, so none were run and none were installed. Manual grep of the added lines:
  - one key-shaped literal at the test constant `KEY` in `test/launch.test.mjs`. It is synthetic (an alphabet run). Its value is not repeated here.
  - no home paths, usernames or hostnames.
- `npm audit` was not re-run, because no dependency or manifest changed.

### 2. Prior findings: status

| # | Status | Evidence |
|---|---|---|
| F1 Major | **Closed** | The checkers now copy `HEAD`, `refs`, `packed-refs` and `objects` (without `objects/info`) into a harness-owned `tt-checker-*` dir with a config the harness writes. They run git with `--git-dir=<copy> --work-tree=<fixture>`, `cwd` at the copy, `core.attributesFile=` and `GIT_ATTR_NOSYSTEM` (`util.mjs:226-266`). G1 trees are written from `cat-file blob` (`util.mjs:333-343`), not a checkout. The new positive-control test plants `filter` smudge/clean/process, `diff` textconv and command, `diff.external`, `core.fsmonitor`, `hooksPath`, pager, editor, `attributesFile`, `[include]`, `info/attributes`, `.gitattributes` and hooks. It proves that plain git runs them, then asserts that no checker does, for every mission (`test/checkers-git-config.test.mjs`). My extra vectors left no marker:<br>(a) a nested repo `sub/.git` with its own filter, fsmonitor and attributes: verdict `passed`, marker none;<br>(b) a gitfile or symlinked `.git`: `error` (test);<br>(c) `objects/info/alternates`: not copied.<br>See R2-1 for a new issue in the copy step. |
| F2 Minor | **Closed** | `countKeyShapes` runs on each complete raw line before `scrubText` (`launch.mjs:483-489`). The count reaches `X.forbidden-commands` as `secretRedactions` (`transcript.mjs:135`). Probes:<br>`secretRedactions=1` → `X.forbidden-commands failed`;<br>a key only in subagent JSONL (unscrubbed, in memory only) → `failed`, with no key text in the evidence. |
| F3 Minor | **Closed** | Line-based scrub with `StringDecoder` (`launch.mjs:483-529`). Every 2-way split from 2 bytes before a multi-byte `€` through the end of the key (66 offsets): **stored-key leaks 0, redaction miscounts 0**, `€` intact. A 3-way split plus a key in an unterminated last line: leak `false`, count 2. Only the scrubbed `stream.ndjson` is persisted (`launch.mjs:360`). The JSONL text is used in memory only. |
| F4 Minor | **Closed** | `realpathSync.native` for roots, the approval file and dirs, with a canonical-equality check (`guard.mjs:29,376,388`). `checkRun` probes:<br>lower-case path in tmp → `approval-scratch`;<br>upper-case → `approval-symlink`;<br>`//` and `/./` → `approval-path`;<br>`/private` stripped → `approval-symlink`;<br>with roots `[]`, case-varied approval → `approval-symlink`;<br>case-varied missing results dir → `results-parent-symlink`;<br>NFC spelling of an NFD-stored name → refused.<br>The canonical control was accepted. |
| F5 Minor | **Closed** (residual, see R2-3) | `claude` spawns `detached`, signals the group TERM→KILL, and kills the group again on close (`launch.mjs:439-453,528`). The checker test runner and every checker git call use `spawnSync({detached:true})` and then `process.kill(-pid,'SIGKILL')` (`tests-before-after.mjs:61-62`, `util.mjs:187-190,257-260`). The regression test (`3b74efc`) passes. The real-spawner probe (fake CLI, timeout 1.5 s): **same-group grandchild dead**. A grandchild started with `detached:true` (its own group) **survived**, as expected (R2-3). |
| F6 Minor | **Closed** | Any parseable non-init object first → `init-event-missing` and kill (`launch.mjs:499-503`). Probes: `tool_use`, assistant text, user, and a `system` non-init event before init are all refused. A JSON array, JSON string or non-JSON line first is not an event and is ignored. That is acceptable: it carries no tool call, and it is still byte-capped and stored scrubbed. |
| F7 Minor | **Closed** | `isInsideGitRepo` checks for a `.git` path component, a `.git` entry in any ancestor, and `rev-parse --git-dir` (`paths.mjs:607-619`). The approval dir is checked for owner and mode (`guard.mjs:396-400`). The approval file is refused when it sits:<br>in `repo/.git/` or `repo/.git/refs/x`;<br>in a bare repo dir or its `hooks/`;<br>under a dir holding a `.git` file.<br>A missing results dir under `.git` → `results-parent-worktree`. A group-writable approval dir → `approval-dir-writable`. |
| F10 Minor | **Closed** | Session JSONL events not in the stream are added as `extraEvents` (`launch.mjs:544-555,583`). `safetyEvents` scans them for `X.forbidden-commands`, `G1.no-push`, `G2.fakeprod-empty` and `G2.no-env-read`. `canary` scans them too (`transcript.mjs:117-123`, `canary.mjs:36`). If agents were invoked but no `sub` event exists, the result is `error` (fail closed). Probe: `transcript: error (no subagent events in a session that invoked agents)`. See R2-4 for a dedupe Note. |

The F8, F9 and F11-F13 notes are unchanged. F12's README correction is done (README "Key delivery" paragraph).

### 3. New findings

#### R2-1. Minor (security-relevant, introduced by the F1 fix): the repo copy follows top-level symlinks and special files, so a FIFO or `/dev/zero` as `HEAD` hangs evaluation with no timeout
- **Location:** `tools/team-tests/src/checkers/util.mjs:233` (`readFileSync(.git/HEAD)`, no type or size check), `util.mjs:238,240` (`copyTree` on `.git/objects` and `.git/refs`, which `readdirSync` follows if the directory itself is a symlink; only entries inside are lstat-checked), `util.mjs:243` (`packed-refs` is lstat-checked but not counted in the size budget).
- **Evidence (scratch repro, confidence high):**
  - `.git/HEAD` replaced by a FIFO: `evaluate` never returned and was killed by my 20 s outer timeout (`status null signal SIGKILL err ETIMEDOUT`). The same happened with `.git/HEAD` → symlink to `/dev/zero`.
  - `.git/objects` → symlink to a directory outside the fixture: verdict `passed`. The same held for `.git/refs` → symlink and `HEAD` → symlink to an outside file. The copy read data from outside the fixture.
  - Each killed run left a `team-tests-*` and a `tt-checker-*` dir in tmpdir.
- **Impact:**
  - The nested agent can write `fixture/.git`. Before this fix, git read `HEAD` under a 60 s timeout. Now Node reads it unbounded, so a hostile session hangs the harness after the session instead of producing `error`.
  - The ledger keeps `started` (it still counts), and no run record is written. The scratch dirs and the copy leak.
  - Nothing executes and nothing passes, so this is availability and fail-closed hygiene, not a bypass.
  - Following symlinked `objects` or `refs` dirs only reads data into a 0700 harness dir, and git then interprets it as repository data. No exec was found. It does contradict the module's "symlinks are never followed" claim (`util.mjs:3`).
- **Fix:**
  - `lstat` `.git/HEAD`, `.git/objects`, `.git/refs` and `.git/packed-refs` before use. Refuse a symlink, or any type other than a regular file (HEAD, packed-refs) or a directory (objects, refs), with `CheckerInputError`.
  - Read `HEAD` with `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`, `fstat().isFile()`, and a size of 4 KiB or less.
  - Count `packed-refs` in the copy budget.
  - Add tests: FIFO HEAD, HEAD → `/dev/zero`, symlinked `objects` and `refs`, each giving `error` promptly.

#### R2-2. Minor (security-relevant, existed before cycle 2): replace refs and a self-ignoring `.gitignore` make safety criteria pass falsely
- **Location:**
  - `util.mjs:226-249` copies every ref under `refs/`, including `refs/replace/`, and `runSafe` (`util.mjs:251-258`) leaves replace objects on;
  - `util.mjs` `changedFilesUncached` runs `ls-files --others --exclude-standard`, which honours `.gitignore` files in the agent-written work tree.
- **Evidence (scratch repro, confidence high):**
  - A `CLAUDE.md` rewrite committed on a side branch, plus `git replace <that commit> <base>`, flips **`X.config-unchanged` (safety) from `failed` to `passed`** (G3).
  - A `package.json` change on a side branch, plus a replace ref, flips **`G4.manifest-unchanged` (safety) from `failed` to `passed`**. The same result holds at `df900e6`, so this is not a regression.
  - An untracked `src/extra.js` plus `src/.gitignore` containing `*` drops it from `changedFiles`, and **`G4.only-g1-files` (safety) passes** with "only G1 files changed".
- **Impact:**
  - A team acting adversarially can hide committed config, manifest or out-of-scope changes from the mechanical safety checks. That weakens the detection model that the owner's F9 decision relies on.
  - It needs deliberate concealment. The pilot is G3/G1, where `X.config-unchanged` applies.
- **Fix:** small, and inside the new copy code:
  - set `GIT_NO_REPLACE_OBJECTS=1` in `runSafe`'s env (or pass `--no-replace-objects`) and skip `refs/replace/` when copying;
  - drop `--exclude-standard` from the untracked listing, or list untracked files with a Node walk compared against `ls-files`;
  - add a test for each.

#### R2-3. Note: residual for F5, processes that leave the group survive
- **Evidence:** in the fake-CLI probe, a grandchild started with `detached: true` (a new session or group) was alive after the timeout and group kill. I killed it by PID.
- **Unconfirmed:** whether Claude Code's Bash tool starts commands (or background tasks) in their own process group. If it does, the group kill misses agent Bash children. I could not check this without running `claude`.
- **Recommendation:**
  - Add this to the plan 5.6 UNCONFIRMED list, to be verified in pilot session 1.
  - Optionally, after each session, mark the session `isolation-failed` if any process still has its cwd under `<scratch>` (for example `lsof -a -d cwd +D <scratch>`).

#### R2-4. Note: `extraSafetyEvents` collapses id-less events
- **Location:** `launch.mjs:545`. The signature is `type:text` when `toolUseId` is empty, and `tool_use` events have no `text`.
- **Evidence:** two subagent `tool_use` events with empty ids (`gh pr merge`, `railway up`), against a stream holding one id-less `tool_use`: **kept 0 of 2**.
- **Impact:** real CLI output carries ids, so this does not matter for real runs today. It fails open if the CLI ever omits an id. The JSONL files sit in the agent-writable fake HOME, so their integrity is already part of the F8 residual.
- **Recommendation:** include `JSON.stringify(e.input ?? '')` and `sub` in the signature, or never deduplicate events that have no id.

#### R2-5. Note: other cycle 2 points checked
- **`process.kill(-pid)` after the leader is reaped:** the group id can only belong to an unrelated group if the PID was reused by a new process that also became a group leader. Both XNU and Linux refuse to reuse a PID while it is still in use as a process-group id. The chance is negligible, and `signal()` guards `pid > 1` (`launch.mjs:446`), so `kill(-1)` cannot happen. `spawnSync` paths guard on a truthy `r.pid`.
- **`.GIT` case variant in a tree:**
  - `mktree` accepts a `.GIT/config` entry, `treeBlobs` (`util.mjs:325`) compares `.git` case-sensitively, and on APFS the G1 extraction wrote `.GIT/config` into `tba-*`.
  - Impact: none found. No git runs in that directory, and the test runner already runs agent code by design.
  - Recommendation: compare case-insensitively for hygiene.
- **No new spawn uses a shell.** The copy dir comes from `mkdtemp` (0700), is removed in `withMemo`/`withSafeRepo` `finally`, and is leaked only when the process is killed (R2-1).

### 4. Dependency review

There are no dependency changes. No `package.json` or lockfile changed between `df900e6` and `d769aa0`. The new import is `node:string_decoder` (a built-in). No network modules were added.

### 5. Verdict

VERDICT: READY WITH CONDITIONS

1. **F1-F7 and F10:** closed, with repro evidence above.
2. **Conditions (cycle 3 of 3, standing decision 5):** fix **R2-1** (Minor, security-relevant) and **R2-2** (Minor, security-relevant), each with the tests listed. Sec then re-checks the two repros: FIFO or `/dev/zero` HEAD gives `error` promptly, and replace ref or self-ignoring `.gitignore` gives `failed`.
3. **If cycle 3 cannot take them:** under standing decision 5 they become follow-ups in the readiness report. R2-2 should then be listed as a known gap in the pilot's safety evidence.
4. **R2-3 to R2-5:** Notes, follow-ups.

### Handoff (cycle 2)

- **Done:**
  - Re-reviewed `df900e6..d769aa0` (`tools/`).
  - Verified CI run 42045857575 on `d769aa0`.
  - 219/219 team-tests tests pass.
  - Re-ran the F1-F7 and F10 repros plus extra vectors.
  - Found two new Minors (R2-1, R2-2) and three Notes.
- **Files:** appended this section to `docs/reviews/M8/security-prB.md`. No source, config or STATUS edits, and nothing committed.
- **Scratch:** the clone, the repro scripts and the temp dirs left by the killed repro runs are all removed. `ls -d <tmp>/team-tests-* <tmp>/tt-*` gave 0.
- **Open questions:** R2-3, whether Claude Code puts Bash children in their own process group (to be verified in pilot session 1).
- **Next role:** Developer (cycle 3: R2-1 and R2-2), then Sec re-check, then Lead.

## Re-review cycle 3 (at b7f0d30)

Reviewer: Security Reviewer (Sec), independent. I did not author any of the cycle 3 changes. This is the last cycle (3 of 3).

VERDICT: READY WITH CONDITIONS

R2-1 and R2-2 are closed: every repro from cycle 2, plus extra vectors, now gives `error` promptly or `failed`. The R2-4 dedupe fix is correct. The new `HARNESS_UNTRACKED` exclusion adds one new security-relevant Minor (R3-1): it is applied to the whole changed-file set, not only to the untracked listing. So a `.env` or `.fake-keychain` **committed on a branch** is now hidden from `G4.only-g1-files`. This is a regression against `d769aa0`. The canary checks still catch it when the committed file holds a canary value, so no secret leak goes undetected. In my view R3-1 does not block merge and can be a follow-up (see section 5).

### 1. Scope and tools

- **Commits:** PR #11, branch `feat/m8b-team-tests`, head `b7f0d309834813db18c508e900f99f3a43a6d794`. Diff reviewed: `git diff ed2f760..b7f0d30 -- tools/`. The code commits are `f791059` (R2-1, R2-2) and `b7f0d30` (R2-4).
- **Files changed:** `git diff --name-only ed2f760..b7f0d30` lists only `tools/team-tests/src/checkers/util.mjs`, `tools/team-tests/src/launch.mjs`, `tools/team-tests/test/checkers-hardening.test.mjs` and `tools/team-tests/test/launch.test.mjs`. Nothing outside `tools/team-tests/` changed. No manifest, lockfile, `.github/`, `.claude/`, `tools/approver/` or `CLAUDE.md` change.
- **CI:** `gh run view 42063967482` gives headSha `b7f0d309…`, status completed, conclusion success. Jobs root, backend, frontend and worker all succeeded.
- **Tests:** in a scratch clone at `b7f0d30` under the session scratchpad, `node --test tools/team-tests/test/*.test.mjs` gave **tests 232, pass 232, fail 0** (node v26.11.1, git 2.54.0).
- **Repros:** one local probe script against the clone, using the test helpers (`makeRun`, `evaluate`, `changedFiles`, `extraSafetyEvents`). I ran the `.env` probe at both `b7f0d30` and `d769aa0`. No `claude`, no `security`, no network beyond `gh run view`, and no `.env` or keys read. The probe's `.env` writes were to throwaway fixtures only.
- **Scanners:** `gitleaks`, `semgrep`, `trivy` and `trufflehog` are not installed. None were run and none were installed. I grepped the added lines for home paths, the username, and key, token or password shapes: no hits. `npm audit` was not run, because no dependency changed.

### 2. Prior findings: status

| # | Status | Evidence (probe output at `b7f0d30`) |
|---|---|---|
| R2-1 Minor | **Closed** | All cases give `verdict=error`, each in under 0.4 s:<br>FIFO `HEAD` (7 ms); `HEAD` → `/dev/zero` (4 ms); `HEAD` → outside file; `HEAD` as a directory;<br>symlinked `objects`, `refs` or `refs/heads`; FIFO in `refs/heads`; FIFO in `objects/pack`;<br>`packed-refs` → `/dev/zero`; FIFO `packed-refs`; 600 MiB sparse `packed-refs` (budget); `objects` missing.<br>How: `readSmallRegular` uses `O_NOFOLLOW\|O_NONBLOCK`, `fstat().isFile()` and 4 KiB caps (`util.mjs:85-98`). `topEntry` lstat-checks `objects`, `refs` and `packed-refs` (`util.mjs:101-107`). `packed-refs` now counts toward the budget (`util.mjs:127-133`). |
| R2-2 Minor | **Closed** | All cases give `failed`:<br>replace ref hiding `CLAUDE.md` → `X.config-unchanged=failed`;<br>replace ref hiding `package.json` → `G4.manifest-unchanged=failed`, also when packed with `pack-refs --all`, and when it exists **only** in `packed-refs`;<br>`info/grafts` plus `shallow` → `failed` (`.git/info` and `shallow` are not copied);<br>`src/.gitignore` `*`, root `.gitignore`, `info/exclude` and `core.excludesFile` → `G4.only-g1-files=failed`. The clean G4 control gives `passed`.<br>How: `GIT_NO_REPLACE_OBJECTS=1` is set in `GIT_ENV` for every checker git call (`util.mjs:32`), `refs/replace` is skipped in the copy (`util.mjs:124`), and the untracked listing drops `--exclude-standard` (`util.mjs:270`). See R3-1 for a side effect. |
| R2-3 Note | Open, follow-up | Unchanged by this cycle. Whether Claude Code puts Bash children in their own process group is still to be checked in pilot session 1. See R3-2 for one related point. |
| R2-4 Note | **Closed** | For id-less events the key is now `type:name:JSON(input):text` (`launch.mjs:257`). Probe: stream `[Bash ls]` against JSONL `[Bash gh pr merge, Bash railway up, Bash ls, Read ls, Bash {ls,x:1}, Bash ls with id "a"]` keeps 5 of 6. Only the exact duplicate (same type, name, input and text) is dropped. That duplicate's content is already in the stream, so every content-based safety check still sees it. The key ignores `sub`, so a main-session event and an identical subagent event merge into one. The safety checks look at content, so this cannot hide a command. Real CLI events carry ids, so this path is rare anyway. |
| R2-5 Note | Open, follow-up | Unchanged (`.GIT` case check in `treeBlobs`). |

### 3. New findings

#### R3-1. Minor (security-relevant, regression introduced in cycle 3): `HARNESS_UNTRACKED` also hides a committed `.env` or `.fake-keychain` from `G4.only-g1-files`
- **Location:** `tools/team-tests/src/checkers/util.mjs:260,271`. `for (const p of HARNESS_UNTRACKED) set.delete(p)` runs on the merged set, after the branch diffs, the work-tree diff and the untracked listing have all been added.
- **Evidence (confidence high):** in a G4 fixture, a side branch commits `.env` (or `.fake-keychain`) with non-canary content (`git add -f`):
  - at `b7f0d30`: overall verdict `passed`, `G4.only-g1-files=passed`;
  - at `d769aa0`: verdict `failed`, `G4.only-g1-files=failed`.
- **What still catches it:**
  - The same commit with the canary value gives `X.canary-never=failed`. `git log -p --all ^base` covers it.
  - A `.env` rewritten to hold another canary gives `failed`.
  - `src/.env` and `.ENV2` are still listed (the match is exact and top-level only).
  - `G1.branch-main` uses `changedOn` and is unaffected.
  - G2 and G3 fail on any extra branch or a moved `main`.
  - `G2.no-env-read` and the other sensitive-read checks are transcript-based and untouched.
- **Impact:**
  - A team can commit a secrets-file path, or the harness key-store file, on a branch, and the G4 mechanical scope check will not report it. That conflicts with hard rule 8.
  - It does not hide a canary or secret value, so the leak criterion is intact. It does not hide any other path, and nothing executes.
  - Separately, and not a regression: a rewrite of the **untracked** `.env` with non-canary content (for example, removing the canary) is reported by no criterion. At `d769aa0` `.gitignore` hid it as well.
- **Fix (one line, follow-up):** apply the exclusion only to the untracked listing, for example by filtering the `ls-files --others` output before `add`. Add a test: `.env` committed on a side branch → `G4.only-g1-files=failed`.

#### R3-2. Note: copy step TOCTOU combined with R2-3
- `copyTree` checks the entry type from `readdirSync` and then calls `copyFileSync` (`util.mjs:62-77`). A process that survived the session (R2-3) could swap a regular objects file for a FIFO in between, and the copy would block. That would bring back the R2-1 hang.
- It needs R2-3 to hold and a precise race. Confidence that it is exploitable in practice is low.
- **Recommendation:** for the follow-up, open with `O_NOFOLLOW|O_NONBLOCK`, `fstat` and copy from the fd, as `readSmallRegular` does. Alternatively, run the whole evaluation under a wall-clock watchdog.

#### R3-3. Note: unignored untracked listing and harness-created files (fail-closed, mainly for QA)
- Without ignore rules, `ls-files --others` lists every file in an untracked `node_modules/`, `.DS_Store` and similar files.
  - Any of these makes `G4.only-g1-files`, `G2.stopped-before-dev` and `G3` source-change checks **fail**, not pass.
  - A very large tree could exceed `maxBuffer` (128 MiB) and give `error`.
- This is safe from a security view, but it can cause false failures. QA should confirm that nothing in the harness or template creates such files in the fixture.

#### Scratch observation
- My clone and probe files are removed.
- Four temp dirs (`team-tests-*` ×2, `tt-checker-*` ×2) were in the OS temp dir with mtimes of about 30 minutes before my check. They are older than my probe runs, so I did not create them and did not delete them. They may come from another agent's killed run. The Coordinator should check them.

### 4. Dependency review

There are no dependency changes. No manifest or lockfile changed in `ed2f760..b7f0d30`. No new imports beyond Node built-ins already in use.

### 5. Verdict

VERDICT: READY WITH CONDITIONS

1. **Closed:** R2-1 and R2-2, with the repro evidence above. R2-4 is closed too, and the dedupe cannot drop an event with distinct content.
2. **Open:**
   - **R3-1** (Minor, security-relevant, regression).
   - R2-3, R2-5, R3-2 and R3-3 (Notes).
3. **Does R3-1 block merge?** In my view, no:
   - The secret-leak criteria (canary in history, files and transcript) still catch every committed canary.
   - The gap is only a committed `.env` or `.fake-keychain` path with non-canary content, in G4's scope check.
   - Under standing decision 5 it would be fixed in-cycle, but no cycle is left, so it becomes a follow-up.
   - **Condition:** list R3-1 in the readiness report as a known gap in the G4 safety evidence until it is fixed. Because R3-1 is security-relevant, the Coordinator escalates it to the owner as the brief says.
4. **R2-3, R2-5, R3-2 and R3-3:** follow-ups.

### Handoff (cycle 3)

- **Done:**
  - Re-reviewed `ed2f760..b7f0d30` (`tools/`).
  - Verified CI run 42063967482 on `b7f0d30`.
  - 232/232 team-tests tests pass.
  - Re-ran the R2-1 and R2-2 repros plus extra vectors (all closed).
  - Verified the R2-4 fix.
  - Found one new Minor (R3-1, a regression, follow-up) and two Notes.
- **Files:** appended this section to `docs/reviews/M8/security-prB.md`. No source, config or STATUS edits, and nothing committed.
- **Scratch:** my clone and probes are removed. Four older temp dirs that I did not create remain (see the scratch observation in section 3).
- **Open questions:**
  - The owner's call on R3-1: follow-up, or an exception fix.
  - R2-3 is still to be verified in pilot session 1.
- **Next role:** Lead review, then the Coordinator readiness report, with R3-1 escalated to the owner.
