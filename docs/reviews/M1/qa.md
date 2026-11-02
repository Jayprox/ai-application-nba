# QA review: M1 CI test workflow (PR #2)

## 1. Scope
Branch `chore/ci-workflow`, commit `89c4791`, rechecked at head `36f71c3af5251900f5c5c56743544a76900b7e1e` (fix cycle 1). Runs 41383261639 and 41384296966 (pull_request). Reviewed `.github/workflows/test.yml`, `worker/test/players.test.js` diff, README, docs/architecture.md, docs/STANDARDS.md, plan. No source edited. Scratch container `qa-pg18` (postgres:18) created and removed; `pg` untouched.

## 2. Traceability (plan section 5)
| # | Criterion | Check | Result |
|---|---|---|---|
| 1 | Triggers pull_request + push main; no pull_request_target/workflow_run | Read file; grep | PASS |
| 2 | `permissions: contents: read`, no widening | Read file | PASS |
| 3 | Four jobs; fail on test failure | Plain `run:` steps, no `continue-on-error`, no `\|\|` (grep empty); `node --test`/vitest exit non-zero. Not exercised with a red commit (optional per plan) | PASS (by inspection) |
| 4 | postgres:18 on backend+worker only, pg_isready, separate DBs, worker DB `worker_test` on localhost | Read file | PASS |
| 5 | Backend applies schema via `npm run db:apply`, constraint tests pass | CI log "Constraint tests: PASSED"; reproduced locally | PASS |
| 6 | No secrets / API keys | grep `secrets\.\|API_KEY` empty. Only a throwaway `postgres` password, commented | PASS |
| 7 | Actions pinned | checkout and setup-node pinned to full SHAs with version comments | PASS |
| 8 | npm cache with per-package paths, `npm ci` | Read file (backend caches root + backend locks) | PASS |
| 9 | Node 22.x everywhere | Read file | PASS |
| 10 | No lint; no app source change; test change only T1 | `git diff main --stat`: only workflow, docs, one worker test | PASS (see finding 1 on the test scope) |
| 11 | Worker 0 skipped | CI log: 23 tests, 23 pass, 0 skipped; reproduced locally | PASS |

Docs: architecture.md sections 1-8 unchanged (`git diff main -- docs/architecture.md` is a single hunk at line 700, 97 additions, 0 deletions). README line and architecture 9.3 match the workflow (file list, D1 = A, 23 tests).

## 3. CI and local results
- CI: worker 23/23, 0 skip. root 31/31. frontend 12 files, 32 tests. backend: constraint tests PASSED, then 15 tests, 12 pass, 3 skip (rankings self-skips), 0 fail. All four jobs green.
- Local reproduction on a fresh postgres:18: worker 23/23, 0 skip; root 31/31; `db:apply` PASSED; backend list 12 pass / 3 skip / 0 fail; frontend 32/32. Matches CI.
- Mutation check on the fixture (see finding 1): restoring the stat rows to HOU makes `players.test.js` fail (`actual: 'name+team+date'`, expected `name+recent_inactive`).

## 4. Findings
1. **Note (answers the focus question): the HOU -> MEM stat-row move is justified and keeps the test's intent.** `resolvePlayers` (worker/src/players.js) builds Pool 1 from players with a stat row for the entry's team in this or last season. `matchPlayer` hits that pool first, so a HOU row for a HOU entry resolves as `name+team+date` and never reaches the `no_candidate` -> `name+recent_inactive` branch added in f0e6dd3. I proved this by reverting only the team id while keeping the scores: the test fails with that method. The scenario the test names (a player with no team, a stat row in the last 2 seasons, signing with a new team) needs the stat on a different team, so MEM is the faithful fixture. Assertions are unchanged and the "old / dup / ghost stay held" cases still run. I see no masked product bug in this branch. Without the move, the score-only fix in plan T1 would have been insufficient (the plan said scores only). The plan's T1 text should be amended or the PR description should say so.
2. **Minor, RESOLVED at 36f71c3: docs omit the second fixture change.** architecture.md 9.3 "Fixed (M1, T1)" says only that scores were added. Add one clause that stat rows are now on MEM, and why.
3. **Minor, RESOLVED at 36f71c3: stale wording in `docs/STANDARDS.md:77`**, "Merging requires CI green (once CI exists)". CI now exists. Drop the parenthetical.
4. **Note: observation outside this PR.** A returning player who is already in the team pool is matched as `name+team+date`, and that path does not set `is_active = true` (only the recent_inactive path does). This looks deliberate but is untested. Lead may want to confirm. No action for this PR.
5. **Note: coverage limits are real and documented.** Backend CI runs 12 tests of the whole suite (auth, browse, query, props, ask and the NBA.com number checks are not run). The explicit file list will go stale as new backend test files are added. Owner accepted this as D1 = A.
6. **Note: `concurrency` cancel-in-progress** also applies to push-to-main runs sharing a ref group; harmless, since each ref has its own group.
7. **Note: runner annotation** for ubuntu-latest moving to Ubuntu 26. Not a failure; consider pinning if drift appears.

I did not run a deliberately failing commit through Actions. Failure propagation is verified by inspection only.

## 5. Recheck at 36f71c3 (fix cycle 1)
- Diff vs 89c4791 is doc-only (STANDARDS.md, architecture.md, plan T1); no workflow or source change, so the earlier criteria results stand.
- Finding 1 (plan/PR wording): plan T1 now states the HOU -> MEM stat-row move and why. Resolved.
- Finding 2 (architecture.md 9.3): "Fixed (M1, T1)" now records the MEM move and the `name+team+date` vs `name+recent_inactive` reason. Resolved.
- Finding 3 (STANDARDS.md:77): parenthetical removed. Resolved.
- architecture.md vs main still has 0 deleted lines (sections 1-8 unchanged).
- CI run 41384296966: worker, root, backend, frontend all green.
- Findings 4-7 remain notes, no action required.

VERDICT: READY

All 11 acceptance criteria pass, CI is green at 36f71c3, every suite was reproduced locally, the worker fixture change is faithful to the test's intent, and the doc conditions from the first review are fixed. Remaining items are notes only (finding 4 for Lead, documented backend coverage limit under D1 = A).

## Handoff
- Done: recheck of fix cycle 1 (doc-only diff, CI run, architecture.md sections 1-8), verdict updated.
- Files touched: `/Users/jayprox_pro/Documents/Projects/git/ai-application-nba/docs/reviews/M1/qa.md` (uncommitted).
- Open questions: finding 4 (`is_active` on the `name+team+date` path), for Lead.
- Next role: Lead review (Sec in parallel), then Coordinator readiness report.
