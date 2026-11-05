# QA review: M8 PR B (golden-mission harness + approver K-CLAUDE rule)

Reviewer: QA Engineer (independent). No source file was edited. No real `claude` process was started (stub spawners and string-only rule probes), no network beyond GitHub reads, no secrets read.

## 1. Scope reviewed

- PR #11 https://github.com/Jayprox/ai-application-nba/pull/11, branch `feat/m8b-team-tests`, head `df900e64606a8f357b7816fe13351c14d0999ec4` (`gh pr view 11`: headRefOid matches, OPEN, MERGEABLE).
- Diff vs `main`: 110 files. Outside `tools/team-tests/`: `docs/STATUS.md`, `docs/architecture.md`, `package.json` (test glob only), and 4 files under `tools/approver/` (`policy/policy.sample.json`, `src/rules/bash.mjs`, `test/bash-rules.test.mjs`, `test/fixtures/requests.json`). No change to `CLAUDE.md`, `.claude/`, `.github/`, `policy.md`.
- Inputs: requirements Story 2 AC1-AC7 and 4.2-4.4; plan 3.1-3.10, 4-5, 7.1; STATUS Approvals (PR B scope (a), `--help`/`--version`) and "Coordinator notes - PR B" (B8 spec) plus recorded deviations.
- QA-owned artefacts (committed by Coordinator): `docs/reviews/M8/qa-prB-cases/guard-negative.test.mjs`, `docs/reviews/M8/qa-prB-cases/k-claude.test.mjs`. Nothing was added under `tools/`.

## 2. Traceability

| Criterion | Tests (existing = Dev, QA = mine) | Result |
|---|---|---|
| AC1 fixture in scratch outside repo/work tree, removed afterwards | `fixture.test.mjs` "fixture is outside the repo and any work tree, and is removed afterwards (AC1)"; "no settings, hooks or approver files are copied"; dry run leaves no `team-tests-*` dir (checked after my runs: 0 left) | PASS |
| AC2 G2: fakeprod log empty, no canary, else failed | dry run samples `G2/fail-fakeprod`, `fail-canary-leak`, `fail-env-read`, `fail-network`, `fail-dev-started` all "failed as expected"; `G2/pass` passes; canary checker positive controls in `checkers.test.mjs` | PASS |
| AC3 G3 stops at Gate 1 with questions, no stories/plan/branch | `G3/pass`, `fail-stories`, `fail-plan-written`, `fail-ran-past-pa`, `fail-no-handoff` | PASS |
| AC4 every 4.2 criterion as M or H | `missions.test.mjs` "Story 2 AC4: every 4.2 criterion is present exactly once as M or H"; I counted 25 criteria in 4.2 by hand (G1 6, G2 6, G3 4, G4 4, G5 3, G6 1, G7 1) and the test list matches | PASS |
| AC5 per-criterion passes/N, regressions per 4.4 | `report.test.mjs` one test per rule: safety regression, flaky safety as rates, mechanical down by 2, flaky mechanical, new unplanned question (G1 and G5), missing G3 question, cost warning +25%, no-warning cases, fail-closed on differing sets | PASS |
| AC6 unit tests pass without agent, model or network | `dryrun.test.mjs` "AC6 ... throwing launcher stub", static scans (no network module, no `claude` spawn, launcher only dynamically imported after guard). My grep of `src/` and `bin/`: no `node:http/https/net/tls/dgram/dns`, no `fetch(`, no `shell: true`, no `exec(` | PASS |
| AC7 refusal unless owner approval file exists and estimate shown | Dev `guard.test.mjs` (24) and `launch.test.mjs` (50); QA `guard-negative.test.mjs` (see section 3): missing approval file, mismatched run set, `CI=1`, 7th session, plus tampered estimate, symlink, group-writable, expired, `approvedBy`, unknown field, scratch location, repo location | PASS (see Findings 2-4, 7: guard is procedural, as plan 3.9 states) |
| 4.2-4.4 criteria, cross-cutting checks, comparison method | `checkers*.test.mjs`, `report.test.mjs`, samples | PASS |
| Plan 3.10 B1-B7 definitions of done | B1 `safe-rm.test.mjs`; B2 `fixture/env/canary/shims` tests (child env allowlist with polluted parent env); B3 `missions/owner` tests; B4 checkers; B5 dry run; B6 report; B7 `guard/launch` (argument arrays, no bypass flags, init-guard kill cases, usage parser, ledger crash) | PASS |
| B8 spec (K-CLAUDE) | `bash-rules.test.mjs` (+7 tests), corpus ask-37..40, QA `k-claude.test.mjs` | PASS (see Findings 5-6) |

Not testable by QA: any real `claude` behaviour. The 14 UNCONFIRMED items in plan 5.6 (flag combinations, init fields, `-p` with stdin, usage field names) can only be settled by pilot session 1. The dry run and unit tests use synthetic transcripts, so they cannot show real parsing works.

## 3. CI and automated test summary

- CI run 42037726775 on `df900e6`: conclusion success; jobs root, frontend, backend, worker all success (`gh run view 42037726775 --json jobs`). Head SHA equals the PR head.
- Root `npm test` (run by me, timeout well above 300 s): `tests 483, pass 483, fail 0, cancelled 0, skipped 0`, `duration_ms 193622` (about 194 s). `docs/architecture.md` says "about 177 s"; same order, my machine was also running other work.
- Approver suite alone: `node --test 'tools/approver/test/*.test.mjs'`: 171 pass, 0 fail. Corpus test alone (`corpus.test.mjs`): 6 pass, 0 fail. No regression in existing approver behaviour: the only deleted line in the approver test diff is an import line that was extended (adds nothing removed from behaviour); corpus fixtures only gain ask-37..40.
- Dry run `node tools/team-tests/bin/team-tests.mjs`: exit 0, "28 sample(s): 28 as expected, 0 mismatched (21 positive-control failures reported as failed) / dry run OK", 35.08 s wall (8.62 s user), output contains no `/Users`, `/private` or `/var/` path.
- QA cases: `node --test docs/reviews/M8/qa-prB-cases/guard-negative.test.mjs`: 10 pass + 3 probe tests (print results, assert nothing). `k-claude.test.mjs`: 5 pass. Stub spawners and stub `importLauncher` only; each refusal test also asserts the launcher was not imported or the spawner was not called.
- Negative cases confirmed refused:
  - Missing approval file: `approval-missing` for undefined, empty, absent file; `approval-type` for a directory; `approval-path` for a relative path. CLI `run --run G3:3,G1:3` with no `--approval` exits 3 with a refusal message.
  - Mismatched run set: `run-set-mismatch` for fewer, more, reordered, other mission, extra repeat, extra mission, empty. Launcher not imported.
  - `CI` set (`1`, `true`, empty string, `0`, `false`): `ci` refusal, checked before the approval file is read. CLI with `CI=1` exits 3.
  - 7th session: approval with 7 sessions and `maxSessions 7` -> `max-sessions-cap`; 7-session run set under `maxSessions 6` -> `max-sessions-cap`; ledger holding 6 slots refuses a 7th (`max-sessions`); `launchAll` with a 7th todo slot stops with `max-sessions` and the stub spawner is called 0 times; a duplicate-entry run set cannot slip past the cap.
- Cleanup: QA test files delete their scratch dirs in `test.after`; after my runs there were 0 `qa-prB-*`, `team-tests-*` or `approver-t-*` dirs in the temp dir. My one probe script in the session scratchpad was removed.

## 4. B8 spec check against `tools/approver/`

| Spec point | Evidence | Result |
|---|---|---|
| New rule `K-CLAUDE`, ask, not undecided | `policy.sample.json` `"K-CLAUDE": {"decision":"ask"}`; probe: `claude -p x` -> `ask K-CLAUDE` | OK |
| Program `claude`, basename, any path | `/usr/local/bin/claude`, `./claude`, `~/.local/bin/claude`, `CLAUDE`, quoted, backslashed, `cl""aude`, `cl\aude` all ask (K-CLAUDE) | OK |
| Behind parser-known wrappers | `env`, `nohup`, `time`, `command`, `exec`, `xargs`, `sh -c`, `bash -c`, `zsh -c`, `eval`, pipes, `&&`, `||`, `;`, subshell, braces, `if`/`for`, `$(which claude)`, here-string all ask; none allow | OK |
| Dynamic command name | `x=claude; $x -p y`, `c=cla; $c"ude"` ask | OK |
| `npx/bunx/pnpm dlx/yarn dlx` of the package | `npx @anthropic-ai/claude-code`, `@latest`, `bunx`, `pnpm dlx`, `yarn dlx`, plus `npm exec`, `pnpm exec`, `bun x`, `npx -y ... --version` all ask K-CLAUDE | OK (wider than spec, safer) |
| Exempt only exact `claude --help` / `claude --version` | `claude --help`, `claude --version`, `/usr/local/bin/claude --help`: rule is not K-CLAUDE (today's result `ask K-DEFAULT`). `--help --version`, `--help foo`, `--HELP`, `--help=1`, `FOO=1 claude --help`, `claude --help \| cat`, `claude --help && claude -p x`, `-h`, `-v` all ask K-CLAUDE | OK; the exemption is not an allow rule |
| `claude` as a plain argument unchanged | `which claude`, `grep claude README.md`, `cat CLAUDE.md`, `git commit -m "claude notes"` etc. not K-CLAUDE | OK |
| `["claude"]` fallback when installed policy lacks `bash.claude` | `claudeNames` in `bash.mjs`; Dev test "no-bash.claude fallback" | OK (read, plus Dev test) |
| `policy.md` untouched; scope limited to repo source, sample policy, tests | `git diff main...HEAD --stat -- tools/approver`: exactly the 4 listed files; no installed copy, live policy or log touched | OK |
| Runner set wider than spec; `-h`/`-v` ask; exempt pair not an allow rule | Recorded Deviations; all are the safer direction | Accepted |

## 5. STATUS deviations checked against the plan

- B1 `team-tests-` prefix required by `safe-rm`; B2 base app carries the planted bug in every variant; `CLAUDE_CONFIG_DIR` left out (plan 5.3 allowlist does not list it, so consistent); B3 `maxResumes` 2 for G4/G5/G7 (consistent with F6 "up to 2 resumes"); B4 `forbidden.json` created in B4, G5 variant added (plan gap, Coordinator-approved), G3 `stops-at-pa` stricter; B5 one JSON per sample (not patch+files), plan test (c) moved to B7 where it exists and passes; B6 "missing G3 question" defined as drop in stop-mode share; B7 init guard stricter than 5.5, keychain path login keychain only, prompt on stdin, `isolation-failed` recorded as `stopReason: error` + flag, estimate hash covers run set and three caps.
- All are inside the plan or err toward safer behaviour. None weakens a test or a guard condition. Two (prompt on stdin, init-guard strictness) depend on unconfirmed real CLI behaviour and are only provable at pilot session 1; both fail closed (a rejected flag or missing init field stops the pilot).
- B7a conforms to plan 5.4 (`apiKeyHelper` naming the keychain file; no key variable in the child env; harness never opens the file). I confirmed there is a test with polluted parent keys and grep finds no key variable in `src/` or `config/`.

## 6. Findings

No Blocker or Major.

1. **Minor - dry run slower than the plan target.** Plan 3.10 targets "dry run under 30 s". Measured 35.08 s wall on QA's machine (Coordinator measured 25.97 s earlier; CI cost is similar order). Not a correctness issue. Fix: none required; either relax the target in the plan or share fixtures between samples. Follow-up.
2. **Minor - approval file parent directory mode is not checked.** `checkApprovalFile` verifies the file (owner, not group/world writable, not symlink, not hard-linked, outside scratch and work trees) but not that its parent directory is non-writable by others. Probe: approval in a 0777 directory is accepted (`guard-negative.test.mjs`, "probe: world-writable approval parent"). This matches plan 3.9 item 1 as written (file mode only), and the guard is stated to be procedural, so it is not a spec miss. Fix: also refuse a group/world-writable parent dir (reuse `checkDir`'s mode test). Follow-up.
3. **Note - approval validity has no maximum.** `expires: 9999-01-01` is accepted. Fix (optional): cap validity (for example 7 days) in code. Follow-up.
4. **Note - ledger is procedural.** Deleting `ledger.json` makes all 6 slots available again (probe in the QA test file). Plan 3.9 documents the guard as not tamper-proof; the mitigation is that the owner creates the approval file and launches the run. No change required; keep F8 as written.
5. **Note - indirect Claude launches fall to `K-DEFAULT` (undecided ask).** `python3 -c "os.system('claude ...')"`, `node -e "...execSync('claude ...')"`, `cat <<EOF | sh` with `claude` in the heredoc body, a symlink to the binary under another name, `sh ./run.sh`, and a binary named `claude-code` return `ask K-DEFAULT`. They still ask, but in a future enforce mode the model stage may look at undecided asks. These are outside the B8 spec ("wrappers the parser already handles") and cannot be fully closed by a parser; the owner should know `K-CLAUDE` is a best-effort tripwire. Fix (optional): add a heredoc-body scan and `-c`/`-e` interpreter string scan, or add names to `bash.claude` in the installed policy.
6. **Note - `sudo claude` returns `K-SYS`, not `K-CLAUDE`** (already in STATUS). Still asks. Fix: optional test and rule ordering.
7. **Note - "cost estimate was shown" is provable only as a hash match.** AC7 is met as a procedural check: `estimateSha256` must equal the hash of the estimate text for this run set and these caps. The code cannot know the owner read it. Acceptable under plan 3.9.
8. **Note - pilot arithmetic with the owner caps.** With `maxUsdPerSession 5` and `maxUsdTotal 20`, a session reserved but not yet finished is counted at US$5 (`spentUsd`). In my 6-slot ledger test, the 5th reservation was refused with `max-usd-total` until I raised the total. With real finished costs below the cap the pilot proceeds, but the owner should expect early stop if sessions crash (crashed sessions are counted at the cap, by design).
9. **Note - committed synthetic paths.** `launch.test.mjs:89,358,367` use `/home/owner/Library/...` and `templates/variants/G7/scripts/backup.sh:3` uses `/home/fixture-user/...`. These are fake placeholders required by the tests and G7, not real paths. `grep` for the macOS home-path prefix and `<user>` in `tools/team-tests`, `docs/architecture.md`, `package.json` finds only the repo's own `Jayprox/ai-application-nba` links (allowed by standing decision 9) and the synthetic `/Users/zed` in `report.test.mjs` (a deliberate polluted input). No secrets or real hostnames found.
10. **Note - doc number drift.** `docs/architecture.md` line 899 says 483/483 "in about 177 s"; my run was about 194 s. Cosmetic.
11. **Note - nothing proves real `claude` compatibility.** Synthetic transcripts mean a green dry run does not show the parser handles real stream-json. The plan routes this to pilot session 1 with a stop rule; keep it.

## 7. Verdict

VERDICT: READY

All seven Story 2 acceptance criteria trace to passing tests, and I reproduced the Dev results independently: CI run 42037726775 is green on the PR head `df900e6`; root `npm test` is 483/483 in about 194 s; the dry run reports 28/28 as expected with exit 0; approver suite is 171/171 with no change to existing approver behaviour. My own negative cases confirm the guard refuses a missing approval file, a mismatched run set, `CI` set (any value) and a 7th session (by approval, by run-set cap and by ledger), with the launcher never imported and the stub spawner never called, and the B8 K-CLAUDE rule matches the spec and the owner-approved scope (repo source, sample policy and tests only). The remaining findings are Minors and Notes (dry run 35 s vs a 30 s target, approval-file parent mode and expiry cap unchecked, procedural ledger, indirect Claude launches asking through the undecided class) and belong in the readiness report as follow-ups. The one thing QA cannot certify is real `claude` behaviour; that is deliberately deferred to pilot session 1 and needs the owner's separate approval.

## Handoff

- Done: independent QA of PR #11 at `df900e6`: verified CI, ran root `npm test` and the dry run, wrote and ran QA-owned negative cases for the guard (missing approval, mismatched run set, `CI=1`, 7th session, plus 10 other bypass attempts) and for K-CLAUDE (about 100 command forms, string-only), traced AC1-AC7 and the B8 spec, and checked STATUS deviations against the plan.
- Files created: `docs/reviews/M8/qa-prB.md`, `docs/reviews/M8/qa-prB-cases/guard-negative.test.mjs`, `docs/reviews/M8/qa-prB-cases/k-claude.test.mjs`. No source file edited; no scratch dirs left; nothing committed or pushed.
- Open questions: none blocking. Owner may want to decide whether to adopt Findings 2 and 3 (approval parent dir mode, maximum expiry) before the pilot, and whether the dry-run 30 s target should be relaxed.
- Recommended next role: Lead review (T5b) in parallel with or after Sec (T4d); then Coordinator readiness report with Findings 1-11 as follow-ups.

---

## Re-review cycle 2 (at d769aa0)

Scope: branch `feat/m8b-team-tests`, code at `d769aa0` (the checkout is at `ff2afaa`, which differs from `d769aa0` only in `docs/STATUS.md`). CI run 42045857575: `gh run view` reports status completed, conclusion success, head SHA `d769aa0`. Diff reviewed: `git diff df900e6..d769aa0 -- tools/` (15 files, +668 / -56).

### Results
| Check | Result |
|---|---|
| Root `npm test` | 505 tests, 505 pass, 0 fail, 0 skipped, 0 todo. 213.3 s reported by node, 3 min 34 s wall. Earlier cycle was 483/483 in about 194 s; the +22 are the new cycle-2 tests. |
| Dry run (`node tools/team-tests/bin/team-tests.mjs`) | exit 0, "28 sample(s): 28 as expected, 0 mismatched (21 positive-control failures reported as failed)", 46.6 s wall. This is slower than the 35 s measured last cycle (see finding 1). |
| QA negative cases (`qa-prB-cases/`) | 18/18 pass, 0 skipped. Refusals still hold: missing approval, mismatched run set, `CI` set, 7th session by approval, run-set cap and ledger; launcher never imported; K-CLAUDE cases unchanged. |
| Minor 2 (approval parent dir mode) | CLOSED. My probe now prints `world-writable approval parent accepted: false`. `guard.mjs` has a new `approval-dir-owner` / `approval-dir-writable` check on the parent, and `guard.test.mjs` asserts refusal with code `approval-dir-writable` for modes 0770, 0707, 0777, 0720. |
| Other probes (unchanged by design) | far-future expiry still accepted; deleting `ledger.json` still resets the cap (todo 6). Both were already recorded as follow-ups. |
| Tests weakened, skipped or deleted | None. `git diff df900e6..d769aa0 -- 'tools/**/test/**'` has zero removed lines (additions only, 6 test files). The only `t.skip` calls are new and conditional on a case-sensitive filesystem; they did not fire here (0 skipped). On a case-sensitive CI runner those two case-insensitivity tests will skip, which is acceptable because they test a macOS-only behaviour. |

### Story 2 regression (AC1-AC7)
- AC1 (fixture outside repo, removed afterwards): `fixture.test.mjs` passes. New F1 code copies repo data into a `tt-checker-*` dir and removes it in `withMemo` and in the non-memo path. I saw no leak from my own runs. Note that other `team-tests-*` and `tt-checker-*` dirs were present in TMPDIR at the time I checked; they were created while other processes (not mine) were running tests, so I cannot attribute them. I deleted nothing that I did not create.
- AC2 / AC3 / AC4 / AC5: the checker suites pass, and the dry run still shows every pass sample as passed and every positive control as failed. The F1 change (git run against a harness-owned copy, no fixture config, filters or hooks) did not change any verdict across the 28 samples.
- AC6 (units run without an agent, model or network): `dryrun.test.mjs` and the static scans pass. The new code adds `process.kill(-pid)` and `spawn` of `git` only; no network module and no `claude` spawn.
- AC7 (guard): passes, and is stricter (canonical paths, `.git` locations, writable approval dir).
- Plan 5.5 init guard: now fail closed on any event before init (F6). Test "any event before init kills the child, even when a valid init follows" passes.

### The G3 stub test (Dev's disclosure)
The test is `runSession (G3, stop mode)` in `launch.test.mjs` (line 322). It was not edited. Its stub transcript has an agent call but writes no subagent session JSONL, so with F10 `safetyEvents` now throws "no subagent events in a session that invoked agents" and one G3 criterion evaluates to `error`. That is the intended fail-closed behaviour. The test does not assert any criterion or verdict. What it asserts is `stopReason` stop-mode, `usageOk`, `isolationFailed`, one spawn only, no `ANTHROPIC_*` in the child env, prompt text, strict B6 `loadResults` schema, cost, ledger finished, and fixture removal. All of those are plumbing and are unaffected by the error. So the test still tests what it was written for. Two caveats:
- It no longer exercises a G3 pass verdict through `runSession`. G3 verdicts are covered by `checkers.test.mjs` AC3 and by the dry run, which use fixtures that carry extra events.
- Nothing asserts, at `runSession` level, that this stub session ends up with an `error` criterion. The new test "Sec F2: runSession reports a printed key as a failed safety criterion" does exercise `runSession` evaluation, and `checkers-forbidden.test.mjs` covers the fail-closed throw at checker level, so coverage of the behaviour exists. See finding 2.

### Findings
1. **Minor - dry run is now 46.6 s wall on QA's machine** (was 35.1 s last cycle; plan 3.10 target is under 30 s). Cause is plausibly the per-evaluation repo copy (F1) plus other processes on the machine running tests at the same time, so the number is noisy. Not a correctness issue. Recommended fix: relax the plan target or reuse one safe copy per sample. Follow-up (carries over from Minor 1).
2. **Note - the G3 stop-mode stub test is blind to the F10 fail-closed outcome.** It passes while a criterion is `error`, so if F10 were later removed or relaxed this test would not notice, and a `runSession` happy path with subagent events is not tested end to end. Recommended fix: add one `runSession` test whose stub writes a subagent sidechain JSONL into the fake home and asserts G3 `verdict: passed`; and in the existing test assert the `error` status explicitly. Follow-up.
3. **Note - Minor 2 is closed; the other cycle 1 follow-ups remain open as stated**: expiry has no maximum, ledger is procedural (deleting `ledger.json` resets the cap), indirect Claude launches ask through the undecided class. Real `claude` behaviour is still untestable by QA and is deferred to pilot session 1 with separate owner approval.
4. **Note - two conditional skips are new** (case-insensitive path tests). They run on macOS and would skip on a case-sensitive CI runner. CI run 42045857575 is green either way. If the owner wants the case checks enforced in CI, they need a case-insensitive runner.

I found no Blocker or Major.

VERDICT: READY

Rationale: At `d769aa0` CI is green, root `npm test` is 505/505 with nothing skipped, the dry run is 28/28 as expected with exit 0, and my 18 negative cases pass. Minor 2 is closed, with a direct probe and a Dev test for each refused mode. The diff of the test directories contains no removed lines and no unconditional skips, so no test was weakened. Story 2 AC1-AC7 and the plan 5.5 init guard show no regression; the new F1 to F7 and F10 code tightens behaviour without changing any dry run verdict. The G3 stub test that now yields `error` still checks run plumbing, which it was written for, but it can no longer tell whether F10 stays fail closed; I recommend one added test as a follow-up, not a condition. The remaining Minors and Notes are follow-ups. QA still cannot certify real `claude` behaviour.

---

## Re-review cycle 3 (at b7f0d30)

Scope: branch `feat/m8b-team-tests`, code at `b7f0d30` (HEAD). CI run 42063967482: `gh run view` reports completed, success, head SHA `b7f0d30`. Diff reviewed: `git diff ed2f760..b7f0d30 -- tools/` (4 files, +198 / -6: `checkers/util.mjs`, `launch.mjs`, new `checkers-hardening.test.mjs`, `launch.test.mjs`).

### Results
| Check | Result |
|---|---|
| Root `npm test` | 518 tests, 518 pass, 0 fail, 0 skipped, 0 todo. 222.7 s reported by node, 3:44 wall. Cycle 2 was 505; the +13 are the new cycle 3 tests. |
| Dry run | exit 0, "28 sample(s): 28 as expected, 0 mismatched (21 positive-control failures reported as failed)", 43.3 s wall (46.6 s last cycle; plan target of 30 s still not met, see Minor carried over below). |
| QA cases (`qa-prB-cases/`) | 18/18 pass, 0 skipped, 3.3 s. |
| Tests weakened, skipped or deleted | None. `git diff ed2f760..b7f0d30 -- 'tools/**/test/**'` has 0 removed lines and no `skip` text; additions only (1 new file, 1 new test in `launch.test.mjs`). 0 skipped in the run. |
| Scratch leak | No `tt-checker-*` dirs left in `/private/tmp` after my runs; `git status` shows only the pre-existing `docs/STATUS.md` change. |

### Fix verification
- R2-1 (special files in fixture `.git`): `readSmallRegular` opens with `O_NOFOLLOW | O_NONBLOCK`, checks `isFile` and a 4096-byte cap; `topEntry` lstat-rejects symlinks and non-regular entries for `objects`, `refs`, `packed-refs`; `packed-refs` is now counted in the copy budget. New tests cover a FIFO HEAD, HEAD symlinked to `/dev/zero`, HEAD symlinked to a regular file, oversized HEAD, symlinked `objects` and `refs`, a sparse 600 MB `packed-refs`, and symlink/FIFO `packed-refs`. All pass and each asserts `error` within 15 s.
- R2-2 (replace refs, ignore rules): `GIT_NO_REPLACE_OBJECTS=1` plus the copy skips `refs/replace`; the tests plant a replace ref (loose and packed) and show `X.config-unchanged` and `G4.manifest-unchanged` still fail, with a control showing they pass on a clean run. `ls-files --others` no longer uses `--exclude-standard`; the tests hide a new file with a self-ignoring `src/.gitignore`, root `.gitignore`, `info/exclude` and `core.excludesFile`, and `G4.only-g1-files` still fails. All pass.
- R2-4 (id-less events collapsing): the signature now includes name and input; the new test keeps two different id-less tool_use events and drops the one duplicate of the stream. Passes.

### Story 2 regression (AC1-AC7) and G1-G7
- AC1 (fixture outside repo, removed afterwards): fixture suite passes, no leaked temp dirs.
- AC2 to AC5 (checkers, verdicts): checker suites pass; the dry run gives 28/28 expected, so G1 to G7 pass samples still pass and all 21 positive controls still fail. Dropping ignore rules did not produce a false failure on any pass sample, which confirms that excluding the harness's own top-level `.env` and `.fake-keychain` by exact name is sufficient for the fixtures the dry run builds. The `ls-files` test asserts those two names are not reported.
- AC6 (units run without an agent, model or network): `dryrun.test.mjs` and static scans pass; the diff adds no network module and no `claude` spawn.
- AC7 (guard): unchanged by this diff; guard suites and my 18 cases pass.
- An agent creating or editing files that a `.gitignore` would hide (new files under a self-ignoring dir, files in `info/exclude` or a global excludes file): now listed, so G4 scope checks fail correctly, shown by the new test.

### Findings
1. **Note - a top-level `.env` or `.fake-keychain` is now filtered by name, so an agent that creates or edits those two files is not reported by `changedFiles`.** This is by design (comment in `util.mjs`) and was already hidden before, since the fixture ignored them. Content leaks are handled by the canary checkers, but a pure edit with no canary content would not fail a scope criterion. Only the top-level names are dropped, so same-named files in subdirectories are still reported. No fix needed; follow-up if the owner wants scope checks on those two files.
2. **Minor (carried over) - dry run is 43.3 s wall against a plan target of 30 s.** Not a correctness issue. Follow-up: relax the target or reuse one safe copy per sample.
3. **Note (carried over) - the G3 stop-mode stub test does not assert the F10 `error` outcome**, and cycle 1 and 2 follow-ups remain open as already recorded (expiry has no maximum, ledger is procedural, indirect Claude launches ask through the undecided class, case-sensitivity skips on case-sensitive runners).
4. **Note - real `claude` behaviour is still not testable by QA** and is deferred to pilot session 1 under separate owner approval.

I found no Blocker or Major.

VERDICT: READY

Rationale: At `b7f0d30` CI is green, root `npm test` is 518/518 with nothing skipped, the dry run is 28/28 as expected with exit 0, and my 18 negative cases pass. Each of R2-1, R2-2 and R2-4 has direct tests that pass, including the error-within-15-s cases for special files, the replace-ref cases that still fail the manifest and config criteria, and the four ignore-file hiding methods that still fail G4 scope. The test directory diff has no removed lines and no skips, so nothing was weakened. Story 2 AC1-AC7 and G1-G7 show no regression; the only behavioural trade-off is the by-name exclusion of the harness's own `.env` and `.fake-keychain`, noted above. Remaining items are Minors and Notes for follow-up. QA still cannot certify real `claude` behaviour.

## Spot check cycle 4 (at e4d2f31)

Scope: PR #11, branch `feat/m8b-team-tests`, code at `e4d2f31` (checkout HEAD is `c7d70bb`; `git diff --stat e4d2f31 HEAD` is `docs/STATUS.md` only). All runs were in a scratch `git clone --local` checked out at `e4d2f31`; the main checkout was not touched. CI run 42081941404: `gh run view --json` gives attempt 2, success, headSha `e4d2f31`; all 4 jobs green. No CI re-run was triggered.

### Results

| Check | Result |
|---|---|
| Root `npm test`, scratch clone | 522 tests, 521 pass, **1 fail**, 0 skipped, 244.0 s (wall 4:05). Failure: `Sec F5: a timeout kills the whole process group` (`checkers-tests-before-after.test.mjs:168`, ENOENT on the grandchild pid file, 8.7 s). Not the AC6 test. See Finding 1. |
| Dry run x5, same clone | 5 of 5 `dry run OK`, 28/28 as expected, 45 s each (plan target 30 s, carried Note) |
| No test weakened | `git diff b7f0d30..e4d2f31 -- 'tools/**/test/**'` touches 2 files and only adds, except 3 changed lines that add failure messages. AC6: `assert.deepEqual(mismatched, [], formatSummary(r))` keeps the same empty-list assertion and adds a message; `assert.equal(r.ok, true)` and the case-count assertion are unchanged. No skip, `only`, retry, raised timeout or tolerance. The CLI test only adds stdout to its failure message. 4 new tests (R3-1 x2, git failure reason, `mismatches`), matching 518 to 522. |
| R3-1 regression | Two tests (`.env`, `.fake-keychain` committed with `add -f` on a side branch, non-canary content). Each has a control (planted untracked files alone give `passed` and are not listed), then asserts the file is listed and `G4.only-g1-files` is `failed`. Both passed in my full run. The fix filters the `ls-files --others` output only (`util.mjs` diff), as Lead Finding 2 asked. I did not re-run them against `b7f0d30`; the Dev reports they fail there. |
| Diagnostics, forced mismatch | In the scratch clone I edited `G2/fail-fakeprod.json` to expect `G2.no-network` instead of `G2.fakeprod-empty`. The dry run printed, per criterion, `G2.fakeprod-empty: failed (expected passed)` and `G2.no-network: passed (expected failed)`, each with up to 2 evidence lines, and exited non-zero. `dryrun.test.mjs` printed the same through the assert message (`G2/fail-fakeprod: G2.fakeprod-empty=failed, G2.no-network=passed`). No path in the output. |
| Dry-run test under load | 24 busy-loop node processes on a 10-core machine: `dryrun.test.mjs` 10/10 pass, 97.8 s. The AC6 failure did not recur. |

### Findings

1. **Major (not caused by cycle 4; test present since cycle 2) - the `Sec F5` grandchild test is load-sensitive and fails without a product defect.**
   - Repro: (a) full `npm test` in the scratch clone: 1 failure as above. (b) With 24 busy-loop `node` processes running, `node --test tools/team-tests/test/checkers-tests-before-after.test.mjs` failed 2 of 4 times, same test, 7.0 s and 7.1 s. The same file passed 3 of 3 with no load.
   - Cause (from reading `checkers-tests-before-after.test.mjs:147-175`): the checker timeout is `testTimeoutMs = 1500`, and the test child must start node, run `spawn` and write the pid file inside that window. Under CPU contention the timeout fires first, no pid file exists, and `readFileSync` throws ENOENT. Nothing leaks; the test cannot tell "slow start" from "broken".
   - Why it matters: a second intermittent failure in the same suite, which can fail CI with a misleading ENOENT. The Dev's 522/522 and the two green CI attempts do not rule it out. It may belong to the same family as the AC6 flake (checker child processes under contention), but I cannot confirm that.
   - Fix: in the test only, poll for the pid file for several seconds, or raise `testTimeoutMs` for it, and make the failure say "child never started". Keep the `dead === true` assertion. Because it edits a test to be more tolerant, treat it under always-ask 11 and get owner awareness.

2. **Minor - mismatch diagnostics omit an expected-failed id that matches no result.** `mismatches()` iterates `results`, so a sample whose `expect.failed` names a nonexistent criterion (I tried `G2.canary-never`) shows the case-level MISMATCH line and no criterion line. `validateSample` does not check ids against the mission. Low impact for the CI flake. Follow-up: validate ids in `validateSample`.

3. **Note - diagnostic coverage of the original AC6 flake.** If `G1/pass` or `G4/fail-cart` mismatches again, the log now shows criterion id, actual vs expected status, an error code (git spawn error, signal or status plus a fixed stderr category: `bad-object`, `index-lock`, `corrupt-object`, `other`, `empty`, and similar) and 2 evidence lines. That tells an `error` from a wrong `passed` or `failed`. Gaps: an exception that is not a `CheckerInputError` and has no short `code` reports only `checker raised an exception`, and `other` hides git's text by design. The root cause of the AC6 flake is still unknown and did not recur in 5 dry runs, 1 full run and 1 loaded test run. Lead Finding 1 parts (b) and (c) stay open.

4. **Note - dry run 45 s vs the 30 s target** (carried from Lead Note 5).

### Verdict

VERDICT: READY WITH CONDITIONS

Cycle 4 does what the brief says: no test was weakened, the R3-1 regression tests are sound, the new diagnostics show enough to diagnose a recurrence of the AC6 failure, and the dry run was stable (5 of 5, and the dry-run test passed under heavy load). My one full local run did not match the Dev's 522/522. It failed on a different, load-sensitive test (Finding 1), which I reproduced 2 of 4 times under CPU load. That test predates this cycle and CI is green on the head, so I do not block this cycle's diff on it. The condition: the Coordinator reports Finding 1 to the owner as a known flaky test, then either gets a fix in a separately authorized cycle or records a follow-up, and does not present 522/522 as stable. The original AC6 flake's root cause is still unknown; this cycle only made it diagnosable.

## Re-review cycle 5 (at 5efe404)

Scope: PR #11, branch `feat/m8b-team-tests`, code at `5efe404` (main checkout HEAD `51b310d` is docs on top; `git diff --stat 5efe404 HEAD -- tools/` is empty). CI run 42091010817: `gh run view --json` gives conclusion success, status completed, headSha `5efe404`. I did not trigger a re-run. All runs and all deliberate breakage were in a scratch `git clone` under the session temp dir; the main checkout's tree, index and stash were not touched. Code diff reviewed: `git diff e4d2f31..5efe404 -- tools/` (5 files, +202/-16: `canary.mjs`, `util.mjs`, new `checkers-cycle5.test.mjs`, and the two F5 test files).

### 1. F5 test diff (Spot check cycle 4 Finding 1)

The diff removes 4 test lines in total (plus 12 non-test source lines in `canary.mjs`/`util.mjs`, which are the C4 fixes, not in this check).

| Removed line | Status |
|---|---|
| `makeRun('G1', { ..., r.testTimeoutMs = 1500 })` (checker test) | Restructured: now `makeRun` inside a loop over `[1500, 3000, 6000]`. |
| `assert.throws(() => H(run), /timeout/)` | Still enforced. It is now the first statement in each loop attempt, inside a try that cleans up and rethrows on failure. A run that does not time out still fails the test. |
| `runInvocation({... timeoutMs: 800 ...})` (launcher test) | Restructured: loop over `[800, 1600, 3200, 6400]`, all other arguments identical. |
| `assert.equal(out.timedOut, true)` | Still enforced, inside every loop attempt, before the pid-file check. |

- "Whole process group is dead" assertion: byte-for-byte unchanged. The diff has no hunk touching `waitDead`, `assert.equal(dead, true, 'grandchild must be dead after the timeout')`, or the launcher's `alive()` loop and `assert.equal(alive(), false, ...)`. Both still wait 3 s for death.
- Bound: checker test timeouts sum to 1.5 + 3 + 6 = 10.5 s; launcher test 0.8 + 1.6 + 3.2 + 6.4 = 12 s (plus 100 ms kill grace per attempt). Both are inside 10 to 15 s. This is a retry on timeout rather than a poll, and the bound is on the timeout windows, not on total test wall time (see Finding 1).
- Failure message: both tests call `assert.fail('child never started / pid file not written within 10.5 s')` (12 s in the launcher test) when the last window ends with no pid file. I confirmed this by reading the code; I did not force that path, since the only way to do so is to edit the test.
- Retained semantic: a retry only happens when the pid file is missing after a timeout, so a child that started is checked on the first attempt exactly as before.

### 2. Broken kill (done by QA, not the Dev's own check)

Scratch clone at `5efe404`; one line changed per run, then `git checkout tools/` to restore. Command: `node --test --test-name-pattern='Sec F5' <both test files>`.

| Variant | Change | Result |
|---|---|---|
| Real code | none | 2 of 2 pass, 8 s wall (launcher 0.9 s, checker 6.7 s) |
| Broken checker | `tests-before-after.mjs:16` `process.kill(-r.pid, 'SIGKILL')` to `process.kill(r.pid, 'SIGKILL')` | checker F5 **FAILS** with `AssertionError: grandchild must be dead after the timeout` at 9.4 s; launcher F5 passes (it does not use that path). 10 s wall, no hang. |
| Broken launcher | `launch.mjs:170` `process.kill(-child.pid, sig)` to `process.kill(child.pid, sig)` | launcher F5 **FAILS** with the same assertion message at 3.8 s; checker F5 passes. 7 s wall, no hang. |

Each test is sensitive to exactly its own code path and fails fast, inside its bound. The two broken runs leaked one grandchild each, as expected (the product kill was disabled); I confirmed and killed both afterwards. Under load, real code (clone restored, `git status` clean), 20 busy-loop `node` processes on a 10-core machine, 5 repeats of both tests: 5 of 5 runs 2/2 pass. Wall times 8 s, 8 s, 19 s, 18 s, 19 s. Per-test durations in the slow runs: checker F5 16.6 s and 17.0 s, launcher F5 0.8 s to 2.5 s. I did not run the broken variants under load.

### 3. Full run

| Check | Result |
|---|---|
| Root `npm test`, scratch clone at `5efe404` | 532 tests, 532 pass, 0 fail, 0 skipped, duration 252.0 s (wall 4:13.7). The previous cycle's F5 failure did not recur. |
| Dry run | `dry run OK`, 28 samples, 28 as expected, 0 mismatched (21 positive controls reported as failed), exit 0, 49.2 s |
| `checkers-cycle5.test.mjs` on `5efe404` | 10 of 10 pass |
| Same file against `e4d2f31` `tools/team-tests/src` (scratch, restored afterwards) | 8 fail, 2 pass. Failing: both C4-1, all C4-2 G7 and G4 large-file and symlink cases, the side-branch `git show` failure, and both C4-3 read-tree cases. The two passing ones are the controls ("symlink outside the scanned prefixes does not trip G7", "clean samples still pass"). So each new test discriminates old from new. |
| Count reconciliation | 522 (cycle 4) + 10 new tests = 532. |
| Weakening check | `git diff e4d2f31..5efe404 -- tools/ \| grep '^-'` shows 16 removed lines: 12 source lines (C4 fixes in `util.mjs`/`canary.mjs`) and the 4 F5 test lines accounted for above. No removed assertion elsewhere. A grep of the added lines for `skip`, `todo`, `only(` finds none. No timeout was raised outside the two F5 tests. |

### Findings

1. **Note - the F5 bound applies to the timeout windows, not the test's total time.** Under 2x CPU load the checker F5 test took 16.6 s and 17.0 s end to end (up to 10.5 s of windows, plus git fixture setup per attempt and the 3 s death wait). Under no load it already took 6.6 s, which suggests it often needs the second or third window on this machine. It passed every time, so this is not a defect. If a CI step or runner imposes a per-test limit below about 20 s, note it. The 10 to 15 s requirement is met for the pid-file wait.
2. **Note - the "child never started" failure path was verified by reading, not by running.** Forcing it needs a test edit. It is a plain `assert.fail` with a clear message after the last window, and the earlier iterations clean up their fixtures (`cleanup()` before the next attempt).
3. **Note (carried) - cycle 4 Notes remain open:** mismatch diagnostics omit a nonexistent expected-failed id (Minor 2 there), the dry run is 49 s against the 30 s plan target, and the AC6 flake root cause is still unknown (it did not recur here, in 1 full run and 1 dry run).

No Blocker, Major or new Minor.

### Owner F5 conditions (STATUS Approvals, 2026-11-05)

- Upper bound of 10 to 15 s on the wait: MET (10.5 s checker, 12 s launcher).
- Fails clearly if the child never starts: MET by code reading (explicit `assert.fail` message), not by a forced run.
- "Whole process group is dead" assertion still fails when the kill is deliberately broken: MET. Shown by QA in the scratch clone for both code paths, each failing with `grandchild must be dead after the timeout` and without a hang.
- Assertion itself unchanged: MET, no diff hunk touches it.

VERDICT: READY

Rationale: At `5efe404` CI is green, root `npm test` is 532/532 with nothing skipped, and the dry run is 28/28 as expected with exit 0. The F5 change keeps every removed assertion (`timeout` throw and `timedOut === true` now run on each attempt), leaves the dead-group assertion untouched, bounds the wait at 10.5 s and 12 s, and fails with a clear message if the child never starts. Deliberately breaking the group kill in either the checker or the launcher makes the matching F5 test fail quickly, and with real code both pass 5 of 5 under heavy CPU load. The 8 behavioural cycle 5 tests fail on `e4d2f31` code and pass now, and no other test was weakened. Remaining items are Notes. QA still cannot certify real `claude` behaviour.
