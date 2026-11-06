# Lead review: M8 PR B (golden-mission harness and K-CLAUDE approver rule)

Reviewer: Engineering Lead (Review mode). PR #11 https://github.com/Jayprox/ai-application-nba/pull/11, branch `feat/m8b-team-tests`.
Last code commit `b7f0d30`; head `4cae028` (docs only: `git diff --name-only b7f0d30..HEAD` = `docs/STATUS.md`, `docs/reviews/M8/qa-prB.md`, `docs/reviews/M8/security-prB.md`).
Inputs: plan `docs/plans/M8-standing-decisions-and-team-tests.md` (§3, §4, §5, §7.1), requirements Story 2 AC1-AC7, STATUS "Coordinator notes — PR B" and the 2026-11-04 / 2026-11-05 Approvals entries, `docs/reviews/M8/qa-prB.md` (READY, cycle 3), `docs/reviews/M8/security-prB.md` (READY WITH CONDITIONS, cycle 3).

## Evidence gathered

| Check | Result |
|---|---|
| CI on `b7f0d30` | run 42063967482: headSha `b7f0d309…`, completed, success; jobs root, backend, frontend, worker all success (`gh run view 42063967482`). |
| CI on head `4cae028` | run 42066209938: headSha `4cae028d…`, completed, **failure**. Jobs worker, backend, frontend success; **root failed** at `npm test`: `tests 518 / pass 515 / fail 1`, `not ok 356 - AC6: the whole dry run passes with a throwing launcher stub` (`tools/team-tests/test/dryrun.test.mjs:69`), mismatched cases `['G1/pass', 'G4/fail-cart']` (`gh run view 42066209938 --log-failed`). |
| Did `main` move between the two runs? | No. Local and remote `main` = `46a61c1` (`gh api repos/.../commits/main`). CI checked out `refs/remotes/pull/11/merge`. The code under test is identical to the green run. |
| Local root `npm test` at `4cae028` | tests 518, pass 518, fail 0, skipped 0; 224.4 s. `git status --short` clean afterwards. |
| Local dry run, 3 iterations (scratch script calling `runDryRun` with a throwing launcher) | 28 cases, 0 mismatched each time (46.3 s, 44.7 s, 45.0 s). Not reproduced on macOS. |
| AC6 duration in CI | 4.8 s (42063967482), 3.2 s (42046713688), 4.6 s (42045857575) green; 3.1 s red (42066209938). CI is fast in both cases, so this is not a timeout. |
| Files outside `tools/team-tests/` (`git diff --name-only main...HEAD`) | `package.json` (test glob only), `docs/architecture.md` (§9.3 row + note), `docs/STATUS.md`, `docs/reviews/M8/*`, and 4 files under `tools/approver/`: `policy/policy.sample.json`, `src/rules/bash.mjs`, `test/bash-rules.test.mjs`, `test/fixtures/requests.json`. |
| `.claude/`, `.github/`, `CLAUDE.md` | `git diff --name-only main...HEAD -- .claude .github CLAUDE.md` = 0 files. |
| Dependencies | no lockfile change; `package.json` diff is the one `test` script line. |
| Standing decision 9, whole PR diff (added lines of `git diff main...HEAD`) | OS username: 0 hits. Machine hostname: 0 hits. macOS home-path prefix: 3 hits, all the synthetic `zed` user (`report.test.mjs` sanitiser input and its quote in `security-prB.md`). Other paths are placeholders (`/home/owner`, `/home/fixture-user`). URLs: only `127.0.0.1`, `localhost`, `example.invalid`, `svc.example.com` and this repo's own PR link. **Final tree is clean.** |
| SD9 in PR history | Per-commit count over `git rev-list main..HEAD`: `a9e5993` and `55a6e6f` each still contain one home-prefix/username-fragment hit (the two Coordinator errors recorded in STATUS). Later commits fix the files; the text stays in branch history. |

## Plan and Story 2 conformance

| AC | Verdict | Evidence |
|---|---|---|
| AC1 fixture outside repo, removed | Met | `src/paths.mjs` (`createScratch`, realpath, marker, work-tree refusal), `src/safe-rm.mjs`; `fixture.test.mjs`, `safe-rm.test.mjs` pass. |
| AC2 G2 fakeprod log empty and no canary, else failed | Met on samples | `samples/G2/fail-fakeprod` reported failed (`dryrun.test.mjs` asserts it); canary positive controls per location. |
| AC3 G3 stops at Gate 1 with questions | Met on samples | G3 stop mode (`missions/G3.json`), AC3 checker tests in `checkers.test.mjs`. |
| AC4 every §4.2 criterion M or H | Met | `missions.test.mjs` against the 25-item list. |
| AC5 per-criterion passes/N and §4.4 regressions | Met | `report.test.mjs` (17 tests, one per rule incl. cost warning). |
| AC6 unit tests without agent, model or network | Met in design, **flaky in CI** | Static scans and throwing launcher stub pass locally and in 3 green CI runs; fails on the head run (Finding 1). |
| AC7 refuse without owner approval file and shown estimate | Met | `src/runcmd.mjs` calls `checkRun` before the dynamic `import('./launch.mjs')`; `MAX_SESSIONS = 6` (`src/estimate.mjs:7`, enforced `src/guard.mjs:96,134`); `guard.test.mjs` plus QA's 18 cases (`docs/reviews/M8/qa-prB-cases/`). "Estimate shown" = `estimateSha256` match (plan §3.9 item 4). |

Plan §3.1 layout is followed (`score`/`compare` live in `src/report.mjs`, `canary.mjs` in `src/` and `src/checkers/`). §5.1 profile: `config/launch-profile.json` carries `-p --bare --restricted --strict-mcp-config --verbose`, `--setting-sources project`, `--permission-prompts none`, `--output-format stream-json`, empty MCP config, tools without `WebFetch`/`WebSearch`; `launch.mjs:125-132` adds `--tools`, `--settings`, `--agents`, `--mcp-config`, `--append-system-prompt`, `--model`, `--max-budget-usd`, `--session-id`/`--resume`; bypass flags only in `FORBIDDEN_ARGS` (`launch.mjs:39`). Spawn uses an argument array, `shell: false` (`launch.mjs:165`). Key delivery matches §5.4 / F7 (a) after the B7a correction (`717ef15`).

B8 (K-CLAUDE) matches the owner's PR B entry approval (2026-11-04, restated after the crash): `tools/approver/src/rules/bash.mjs` asks for any `claude` run except exact `claude --help` / `claude --version`; fallback list `['claude']` for an older policy; `policy.md` untouched; only the repo source, sample policy and tests changed. Sec F11 confirmed no ask/deny became allow (104 probes).

## Architecture and maintainability

Sound. One module spawns `claude` and is reachable only after the guard; checkers are pure functions over a run record, fail closed (`error`, never `passed`); git in checkers runs against a harness-owned copy (Sec F1 fix), which is the right boundary. Node built-ins only. Largest files are `src/launch.mjs` (398 lines) and `src/checkers/util.mjs` (335); acceptable. Tests are broad (232 team-tests tests). Weak spots are recorded below as follow-ups: the dry-run test hides which criterion mismatched (Finding 1), the README isolation section is stale (Note 7), and `docs/architecture.md` still says 483/483 tests (Note 7).

## Findings

1. **Major — nondeterministic failure of the AC6 dry-run test in CI on the PR head.**
   - Evidence: run 42066209938 on `4cae028` (code identical to green run 42063967482 on `b7f0d30`, `main` unchanged at `46a61c1`): `not ok 356 - AC6 ...`, mismatched `['G1/pass', 'G4/fail-cart']`, `dryrun.test.mjs:69`. Local: 518/518 and 3 clean dry runs, so not reproduced.
   - Why it matters: hard rule 7 needs green CI on the head before merge is recommended. More important, the dry run is the harness's own evidence that checker verdicts are right. A pass sample (`G1/pass`) and a positive control (`G4/fail-cart`) came out wrong once in 7 CI runs of passing code. The test asserts only the list of mismatched names, so the log does not show whether a criterion became `error`, `failed` or `passed`. If it was `passed` on `G4/fail-cart`, a safety-relevant scope check gave a false pass. Root cause is unknown. Candidates I could not confirm: a race in `tests-before-after` or the shared repo copy under the Linux runner's speed, or `process.kill(-pid)` after `spawnSync` hitting a reused PID in a parallel test file (`checkers/tests-before-after.mjs:16`).
   - Fix: (a) make `dryrun.test.mjs` print `failed`, `errored` and `actual` per mismatched case (ids only, no paths or values), so the next failure is diagnosable; (b) find and fix the cause; (c) green CI on the final head. This is a code change and 3/3 fix cycles are used, so under the review-loop limit and standing decision 5 the **Coordinator escalates to the owner**: either authorize a 4th cycle for this (and R3-1, below), or accept a green re-run plus a follow-up. A re-run of CI by itself is not a fix cycle, but it does not close the finding.

2. **Minor (security-relevant, Sec R3-1) — `HARNESS_UNTRACKED` hides a committed `.env` or `.fake-keychain` from `G4.only-g1-files`.**
   - Evidence: `tools/team-tests/src/checkers/util.mjs:260,271`. The delete runs on the merged set (branch diffs + work-tree diff + untracked listing), not only on the `ls-files --others` output. Sec repro: G4 verdict `passed` at `b7f0d30`, `failed` at `d769aa0`.
   - Judgement: the follow-up treatment under standing decision 5 is correct. It is a security Minor that would be fixed in-cycle, but no cycle is left, so it becomes a follow-up. It does **not** block merge or the pilot. The secret-leak criteria still catch any committed canary (`X.canary-never`). The pilot runs only G3 and G1. G1 uses `changedOn`, not `changedFiles` (`checkers/git.mjs`), and `X.config-unchanged` matches only config paths (`checkers/files.mjs:133`), so neither depends on the exclusion. G2 and G3 already fail on any extra branch.
   - Fix: filter the `ls-files --others` output before `add`, and add a test that `.env` committed on a side branch gives `G4.only-g1-files=failed`. It must be fixed before any G4 run counts as evidence. If the owner authorizes a 4th cycle for Finding 1, bundle this one-line fix into it.

3. **Minor — the pilot pre-flight list is not clear enough for the owner yet.**
   - Evidence: `tools/team-tests/README.md:39-41` is one dense sentence. It omits R2-3 (Bash children that leave the process group survive the timeout kill). It does not state what F10 means in practice: a session with agents but no readable subagent JSONL ends with a safety criterion `error`. `launch.mjs:372,395` then stops the pilot as `safety-failure`, which the owner could read as agent misbehaviour.
   - Fix: the Coordinator puts the numbered checklist below in the readiness report (no code change needed). A README rewrite is a follow-up.

4. **Note — SD9 leaks remain in branch history (`a9e5993`, `55a6e6f`).** The final tree is clean. A merge commit or a rebase merge would bring these commits into `main`'s history; a squash merge would not, though the PR branch on GitHub keeps them until it is deleted. The merge method and any branch deletion or history rewrite are owner decisions (always-ask 1 and 5). Recommendation: squash merge.

5. **Note — dry run is 43-46 s against the plan's 30 s target** (QA Minor, carried over; my runs 44.7-46.3 s). Follow-up: relax the target or reuse one safe copy per sample.

6. **Note — Sec R2-3, R2-5, R3-2, R3-3 and QA notes** (G3 stub test blind to the F10 `error` outcome, no maximum on approval expiry, ledger reset by deleting `ledger.json`, indirect `claude` launches get K-DEFAULT, `sudo claude` = K-SYS, conditional case-sensitivity skips on Linux CI, top-level `.env` edits without canary content not reported). All are follow-ups. None widens what can run without an ask.

7. **Note — stale docs.** `README.md` "Isolation model (so far)" covers only B1. `docs/architecture.md` §9.3 still says "483/483 pass in about 177 s" (now 518). README step 1 says "their own keychain", but the helper reads the **login** keychain only (STATUS B7 deviations). The owner must store the key there. Follow-up.

## Deviations (from STATUS) and whether they need owner sign-off

Routine, inside the approved requirements, and safer or neutral. Recording them is enough: the `team-tests-` prefix required by safe-rm; the planted bug in the base app; the npm wrapper; placeholder G7 values; `maxResumes` 2 for G4/G5/G7 (within the F6 session definition); never-answer matching on the whole text; the G5 variant added; `forbidden.json` created in B4; docs ignored in G1/G4 scope; the stricter G3 check; the G5 cycle regex; the `finalRef` rule; JSON samples; the no-`claude` proof by static scan; the G3 "missing question" rule; `blind-key.json`; the cost warning per mission; `isolation-failed` recorded as `error` + flag; the stricter init guard; the prompt on stdin; the estimate hash over run set + caps; raw stream in `resultsDir`; F10 fail closed; the K-CLAUDE runner set wider than the spec, with `-h`/`-v` still asking.

Owner awareness, not sign-off:
- `CLAUDE_CONFIG_DIR` is not set in the child env, although plan §5.2 lists it (UNCONFIRMED). The fake `HOME` and the isolation checker's real `~/.claude/projects` check remain. Pre-flight item 8 covers it.
- Login keychain only (Note 7).
- Pilot stop on `error` safety criteria (Finding 3).
- Two Coordinator errors, both corrected: the key-delivery brief, fixed before review in `717ef15`; and the username fragment in `55a6e6f`, redacted in `877f25e`, still in history (Note 4).

Needs an owner decision: **Finding 1** (4th cycle or accept a re-run plus a follow-up) and the **merge method** (Note 4). Nothing else changes product scope or architecture.

## Scope check

Inside the approved scope. `tools/approver/` changes are limited to the repo source, sample policy and tests, per the owner's 2026-11-04 PR B entry approval. The installed copy, live policy and log are untouched (not in the repo diff). No `.claude/`, `.github/` or `CLAUDE.md` change. No new dependency. No production, network or `claude` use: STATUS records that no real session ran, and my review started none.

## Pilot pre-flight checklist (for the readiness report)

Session 1 (G3) is the pre-flight. Any item below that fails stops the pilot with 1 of 6 sessions used (plan §4.1). A harness fix then goes through a reviewed PR, and the remaining 5 sessions run under the same approval and ledger.
1. `--bare` and `--restricted` are accepted together, and every profile flag is accepted.
2. The subagent tool is named `Agent` or `Task` (the init guard accepts both; `--tools` passes `Agent`).
3. The `--agents` file accepts `tools` and `model` keys.
4. `stream-json` with `-p` needs `--verbose` (it is passed).
5. `-p` reads the prompt from stdin (the harness sends it there).
6. `system/init` is the first event, its key set matches (any unknown key stops the session by design), `cwd` is reported as the fixture realpath, `apiKeySource` is `apiKeyHelper`, the model is the approved alias, only the fixture's agents are listed, and MCP is empty.
7. `apiKeyHelper` works under `--bare` and a fake `HOME` with the explicit login-keychain path. The key is stored in the **login** keychain.
8. Nothing is written under the real `~/.claude` (the fake `HOME`; `CLAUDE_CONFIG_DIR` is not set).
9. `result` event fields (`total_cost_usd`, `usage.*`, `modelUsage`, `num_turns`) are readable, including whether they cover subagents. Unreadable usage stops the pilot.
10. Whether `--max-budget-usd` counts subagent spend (the harness also checks the cumulative cost before each resume).
11. Location and format of subagent JSONL. If they are not found in a session that ran agents, a safety criterion becomes `error` and the pilot stops as `safety-failure` (F10). That is a harness or CLI-format problem, not necessarily agent misbehaviour.
12. R2-3: whether Bash children of the nested session leave the process group (a `setsid` descendant survives the timeout kill). After session 1, check that no stray process remains.
13. Claude Code Bash sandbox settings exist (needed before G2 and any full run, per F9; not needed for the G1/G3 pilot).
Not relevant under F7 (a): plan §5.6 items 9-10 (subscription login), and item 14 (unused flags).

## VERDICT: NOT READY

The content meets the plan and Story 2 AC1-AC7. Architecture and scope are sound, SD9 holds for the final tree, and R3-1 is correctly a follow-up. The verdict is NOT READY only because of Finding 1: the head CI run 42066209938 is red, on an unexplained nondeterministic mismatch in the harness's own verdict test, and fix cycles are exhausted. It becomes READY when the owner chooses one of these:
- (a) authorize a 4th cycle: diagnostics in `dryrun.test.mjs`, root-cause fix, R3-1 bundled, then green CI on the head and a QA/Sec spot check; or
- (b) accept a green CI re-run on the head, with Finding 1 kept as a follow-up that blocks the pilot until diagnosed.

I recommend (a), because the pilot's evidence depends on checker verdicts being deterministic.

## Handoff

- **Done:** Lead review of PR #11 at `4cae028` (code `b7f0d30`). Verified CI (green on `b7f0d30`, **red on head**: AC6 dry-run flake), ran root `npm test` locally (518/518) and the dry run 3 times (0 mismatches), checked the scope (`tools/approver/` = 4 repo files; no `.claude/`, `.github/` or `CLAUDE.md` changes; no dependency change), ran the SD9 scan over `main...HEAD` (tree clean; 2 history commits hold the recorded leaks), judged R3-1 (follow-up, does not block) and the deviations, and wrote the pre-flight checklist.
- **Files:** created `docs/reviews/M8/lead-prB.md` (not committed). No source edits. Scratch script in the session scratchpad only.
- **Open questions (owner, via Coordinator):** Finding 1, option (a) 4th cycle or (b) re-run plus follow-up; merge method (squash recommended, Note 4).
- **Follow-ups for the readiness report:** R3-1 (fix before any G4 run counts; bundle into a 4th cycle if one is authorized); Finding 1 if option (b); README pre-flight rewrite (Finding 3); dry run 43-46 s vs 30 s; QA G3 stub test should assert the F10 `error`; Sec R2-3 (process-group escape, pilot check 12), R2-5 (`.GIT` case), R3-2 (copy TOCTOU), R3-3 (untracked `node_modules`/`.DS_Store` fail closed); no maximum expiry; ledger reset by deleting `ledger.json`; indirect `claude` launches = K-DEFAULT, `sudo claude` = K-SYS; Linux CI skips the case-sensitivity tests; top-level `.env` edits without canary content not reported; stale README isolation section, `docs/architecture.md` test count, login-keychain wording; SD9 history in `a9e5993` and `55a6e6f`; stale `guard-test-*` / `team-tests-*` / `tt-checker-*` temp dirs (owner may delete).
- **Recommended next role:** Coordinator (escalate Finding 1 and the merge method to the owner). Then Dev (4th cycle if authorized) -> QA + Sec spot check -> Lead re-check -> readiness report.
