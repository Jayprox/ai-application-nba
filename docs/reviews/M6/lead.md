# Lead review: M6 Highlightly weekly (PR #7)

Reviewer: Engineering Lead. Date: 2026-11-03.
PR #7 (https://github.com/Jayprox/ai-application-nba/pull/7), branch `feat/m6-highlightly-weekly`, HEAD `f2f6099a673ac0f787842ddbdcb3b1b59c04d94e`. Fix cycles used: 2 of 3.

## Scope and evidence

- **Diff:** `git diff main...HEAD`, 56 files, +5937/-110, 15 commits.
- **Read in full:** `worker/src/sync.js`, `worker/src/highlightly.js`, `worker/src/weekly-schedule.js`, `worker/src/weekly-backfill.js`, `worker/src/weekly-util.js`, `worker/scripts/weekly-hl.js`, `scripts/weekly.mjs`, `scripts/lib/weekly.mjs`, `scripts/lib/sources.mjs`, `scripts/lib/nba-best-effort.mjs`, `scripts/backfill.mjs`, `worker/test/helpers/db.js`.
- **Inputs:** `docs/plans/M6-highlightly-weekly.md`, the requirements, the STATUS M6 Approvals (Q1-Q11), `docs/reviews/M6/qa.md` (READY at `f2f6099`) and `docs/reviews/M6/security.md` (READY at `f2f6099`).
- **CI:** `gh pr checks 7`: backend, frontend, root and worker all pass.
- **Local, run by me:**
  - root `npm test`: 115/115.
  - worker `npm test` on a throwaway `postgres:18` container (`WORKER_TEST_DATABASE_URL`, local `*_test` DB): 107/107, 0 skipped. The container was removed afterwards.
  - I did not rerun the drill. QA reports 203/0 at `f2f6099`.
- **Constraints:** no live Highlightly, NBA.com, Railway or production call. `.env` not read. No source edited.
- **Not changed by the PR** (`git diff --quiet main...HEAD` over these paths): `worker/test/sync.test.js`, `worker/src/{index,planner,players,db}.js`, `db/schema.sql`, `db/migrations`, the weekly plist, `.github`, both lockfiles, `backend/`, `frontend/`. No new dependency. The only `worker/package.json` change is a new `weekly-hl` script.

## Conformance

- **Plan:** tasks T1-T10 are all present. Fetch-then-write with one short transaction (`weekly-util.js:25-41`, `lock_timeout 5s`, one retry on `55P03`). Single NBA.com probe and down latch (`sources.mjs` `nbaStats` and `gate()`). The `@@WEEKLY` result line is validated by `parseResultLine` (`lib/weekly.mjs`). The per-run budget is passed between child processes (`stepExtra`). Internal env vars are stripped (`lib/weekly.mjs:196`). Fixture guards follow D12 (`fixtureGuardError`).
- **Q1:** `grep -rn "INSERT INTO games" worker/src worker/scripts` returns 0 matches.
- **Q3/Q7:** the cap is clamped to 1..600 and the reserve to 1000..100000, in both `lib/weekly.mjs` and `weekly-hl.js:77-78`. Remaining quota is read on every response.
- **Q9:** `WEEKLY_HL_TIPOFF` is set to `'0'` when `schedule:nba` loaded cleanly, else `'1'` (`lib/weekly.mjs:301`). The child reads it at `weekly-hl.js:86`.
- **Q11:** the sweep needs `WEEKLY_HL_FULL_SEASON === '1'` and a live remaining value above 3000 (`weekly-hl.js:85`, `weekly-schedule.js:101-105`, `weekly-backfill.js:79-83`). An unknown remaining value means the sweep is refused.
- **STANDARDS:** ES modules, no code shared across packages, no new dependency, tests are fixture-only (Sec ran them with outbound network blocked), and docs are updated in the same PR.

VERDICT: READY

## Findings

1. **Note: the `loadBoxScore` refactor does not change live worker behaviour (O1).**
   - **Evidence:** `git diff main...HEAD -- worker/src/sync.js`. `teamMap` and `findGame` gain only `export`.
   - The inline readiness check became `boxReady`, with the same expression.
   - The player-resolution loop moved into `resolveSides`. It runs in the same order and still outside the transaction. It returns `{problem}` at the same point the old code returned. The caller logs the same text and returns the same `out`.
   - The transaction body moved into `writeSides`, with the same three SQL statements, parameters and order, and with `touched` built in the same place.
   - The `nba_stats` early exit, `BEGIN`/`COMMIT`/`ROLLBACK`, the error text and the post-commit `recomputePlayerRest` are unchanged.
   - `highlightly.js` gains `hostFor()`, which returns the same base URL and headers as before.
   - The live entry point `worker/src/index.js` is unchanged and does not import any new module. `sync.test.js` passes unchanged (107/107 above).
   - **Fix:** none.

2. **Note: the `pg.Pool` transaction pattern is a pre-existing risk. Track it as a follow-up; it is not a merge condition.**
   - **Evidence:**
     - The only `BEGIN` in live worker code is `worker/src/sync.js:151`, which runs on a `pg.Pool` (`db.js:15`, `max: 10`). Each `pool.query` checks out and releases a client.
     - Today it lands on one connection for two reasons. `pg-pool` reuses the most recently released idle client (`worker/node_modules/pg-pool/index.js:158`, `this._idle.pop()`). And the worker tick is serialised (`index.js:80`, `if (busy || stopping) return`), so no other query runs at the same time.
   - **Failure mode:** suppose the connection drops between statements, or a concurrent query is added later. The remaining statements then run as autocommit on a different client, and a box score could be half-written (player rows without the `team_games` or `box_score_checks` update).
   - **Impact:** low. The upserts are idempotent and the 3 h re-check rewrites the game.
   - **The weekly code does not use this pattern.** The CLI uses one `pg.Client` (`weekly-hl.js:100`), the tests use `pg.Client` (`test/helpers/db.js:19`), and no new path takes a Pool.
   - **Why not a merge condition:** M6 did not introduce or change this code. Fixing it in this PR would change live-worker behaviour, which removes the "no behaviour change" basis for O1.
   - **Fix (follow-up PR):** in `loadBoxScore`, use `const c = await db.connect()` and run `BEGIN`…`COMMIT` on `c`, releasing it in a `finally` block. Add a test that passes a Pool.

3. **Minor: the weekly modules do not refuse a Pool.**
   - **Evidence:** `inTransaction(db, …)` (`weekly-util.js:25`), `runSchedulePass` and `runBackfillPass` accept any `db`. Only the callers' choice (finding 2) makes them safe.
   - **Fix (follow-up):** throw in `inTransaction` when `db` is a `pg.Pool` (for example, `typeof db.connect === 'function' && 'totalCount' in db`), with a one-line test.

4. **Minor: a plain JS error in a best-effort loader is reported as an NBA.com data problem.**
   - **Evidence:** `scripts/lib/nba-best-effort.mjs:36` maps any `TypeError`, `SyntaxError` or `RangeError` to `warn` ("nba.com data rejected: unexpected response shape").
   - So a bug in our own loader code shows as `OK-DEGRADED` with exit 0 instead of `FAIL`. Nothing is written, because the transaction rolls back, and the warning is in the log. But the run would not alert as a failure.
   - **Fix (follow-up):** apply the shape classification only to errors raised while parsing NBA.com data, for example by wrapping the `rows()` / `.leagueSchedule` access in an `NbaDataError`. Leave other errors as `fail`.

5. **Note: Developer deviation, per-game savepoints in the box-score catch-up. Accepted.**
   - **Evidence:** `weekly-backfill.js:105-120`.
   - A statement-level error on one game rolls back only that game and counts it as `errored`, which makes the run degraded (`weekly-backfill.js:125`).
   - A lock timeout is re-thrown, so the whole transaction is retried, then FAILs (`:117`).
   - If the connection is lost, `ROLLBACK TO SAVEPOINT` throws and the step still FAILs.
   - This narrows plan D7 ("database errors FAIL") to "database unavailable FAILs; one bad game is a warning". That matches US-2.10 and the owner's Q3 "no partial-write damage".
   - Dry runs also roll back player resolution here (inside the savepoint), which is stricter than the live worker.
   - **Fix:** none.

6. **Note: Developer deviation, manual `weekly-hl` applies tip-off changes only with `WEEKLY_HL_TIPOFF=1`. Accepted.**
   - **Evidence:** `weekly-hl.js:86`. The runner sets the value per Q9 (`lib/weekly.mjs:301`) and strips any value the user sets (`:196`).
   - This is the safe default for hand runs and does not change the scheduled behaviour.

7. **Note: Developer deviation, a tip-off shift over 8 h is only recognised through an existing crosswalk link. Accepted.**
   - **Evidence:** `findGame` (`sync.js:17-33`, unchanged) is used at `weekly-schedule.js:137`. An unlinked game whose time moved more than 8 h shows in `unmatched` and is not linked by guesswork. This is consistent with Q1 and the duplicate-game analysis in plan §6.

8. **Note: the other deviations are accepted.** These are: `WEEKLY_NBA_BEST_EFFORT` not used, the added `weekly-util.js` and test helpers, synthetic fixtures as directories or built at run time, the drill fixture generator, and a missing NBA.com fixture treated as "unreachable" (`sources.mjs` `fixtureOr`). Each is either a file-layout detail or a safety tightening. None changes approved behaviour.

9. **Note: first real run needs worker dependencies installed.**
   - **Evidence:** `scripts/weekly.mjs:194` fails preflight with `worker dependencies missing (run: npm --prefix worker ci)` when `worker/node_modules/pg` is absent. The failure is clean and happens before the lock, backup or tunnel.
   - **Fix:** owner runs `npm --prefix worker ci` once on the Mac after merge. This is in the Gate 2 list below.

10. **Note (nit): `toHl` is computed and never used** (`weekly-backfill.js:40`).
    - **Fix:** remove it in any later touch. Not worth a fix cycle.

The QA and Security conditions are all closed at `f2f6099`: C1-C4 and R3-2/R3-3 are verified READY by both reviewers. There are no Blocker or Major findings, and findings 2-4 and 10 do not need another fix cycle.

## Items for the owner at Gate 2

1. **Merge redeploys the Railway `ingestion-worker` (O1).** The live code path has no behaviour change (finding 1), but the service restarts. Approve with that in mind.
2. **Before the first scheduled run after merge:** run `npm --prefix worker ci` on the Mac (finding 9). Otherwise the Monday run will fail at preflight with that exact message.
3. **Quota period (Q3) is still unconfirmed.** Keep `WEEKLY_HL_FULL_SEASON` unset until you have checked the Highlightly dashboard (Q11 on hold). The guardrails assume a monthly quota.
4. **Expected result while NBA.com is blocked:** `OK-DEGRADED` and the "OK with warnings" notification each week. Arena, national TV, Cup stage, standings and positions are not refreshed. Cup knockout games will appear as `unmatched` from mid-December until NBA.com answers.
5. **Tip-off source can alternate (O2):** in weeks NBA.com answers, its time wins; in other weeks Highlightly's does.
6. **Follow-ups to schedule (not merge conditions):** finding 2 (worker Pool transaction), finding 3 (Pool guard), finding 4 (error classification), and the residual concurrency races R-C1/R-C2 from plan §5.
7. **`.env.example` was not edited (O3).** The new flags have defaults and are documented in `docs/architecture.md` §7.9 and the README.

## Handoff

- **Done:** final Lead review of PR #7 at `f2f6099`. Checked conformance to the plan, the Q1-Q11 answers and STANDARDS. Verified that the `loadBoxScore` refactor does not change live behaviour, assessed the 8 Developer deviations (all accepted), and assessed the Pool/`BEGIN` risk (pre-existing; the weekly code avoids it; follow-up). CI green. Root 115/115 and worker 107/107 (throwaway Postgres) run locally.
- **Files:** created `docs/reviews/M6/lead.md`. No source edited, nothing committed or pushed.
- **Open questions:** none for the Developer. Owner items 1-7 above.
- **Recommended next role:** Coordinator, for the readiness report and Gate 2 (owner merge approval). Then a small follow-up ticket for findings 2-4.
