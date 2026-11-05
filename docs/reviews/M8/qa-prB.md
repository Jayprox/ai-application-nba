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
9. **Note - committed synthetic paths.** `launch.test.mjs:89,358,367` use `/home/owner/Library/...` and `templates/variants/G7/scripts/backup.sh:3` uses `/home/fixture-user/...`. These are fake placeholders required by the tests and G7, not real paths. `grep` for `/Users/`, `jayprox` in `tools/team-tests`, `docs/architecture.md`, `package.json` finds only the repo's own `Jayprox/ai-application-nba` links (allowed by standing decision 9) and the synthetic `/Users/zed` in `report.test.mjs` (a deliberate polluted input). No secrets or real hostnames found.
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
