# QA review: M6 Highlightly weekly (PR #7)

Reviewer: QA Engineer. Date: 2026-11-03.

## 1. Scope reviewed

- Repo: `Jayprox/ai-application-nba`, PR #7, branch `feat/m6-highlightly-weekly`, HEAD `b3278b83f843f38bf0a9fb045d33bc493be83fec`.
- Diff `main...HEAD`: 52 files, +5705/-108. Reviewed the worker modules (`hl-weekly-client`, `weekly-schedule`, `weekly-backfill`, `sync.js` refactor, `highlightly.js`), `worker/scripts/weekly-hl.js`, `scripts/lib/sources.mjs`, `nba-best-effort.mjs`, `weekly.mjs`, `weekly.sh`, `weekly-drill.sh`, and the diffs of `backfill.mjs`, `load-schedule.mjs`, `load-positions.mjs`, `db-status.mjs`.
- Inputs: `CLAUDE.md`, `docs/STANDARDS.md`, `docs/requirements/M6-highlightly-weekly.md`, M6 Approvals table (Q1-Q11) in `docs/STATUS.md`.
- Constraints honoured: no live Highlightly, NBA.com, Railway or production call. `.env` and `.env.example` were not read. No source edited, nothing committed or pushed, branch not switched. The only local infrastructure used was throwaway Docker Postgres containers (the repo's own drill container, plus one `postgres:18` container of mine for the worker DB tests, removed afterwards).

## 2. Traceability (acceptance criterion -> evidence -> result)

Evidence key: D = `npm run db:weekly:drill` case (203 PASS); W = worker test run against local Postgres (91/91); R = root `npm test` (110/110); C = code read.

| Criterion | Evidence | Result |
|---|---|---|
| US-1.1 NBA.com blocked, Highlightly up: 4 stages, exit 0 | D W26 (real sub-steps, synthetic blocked NBA.com) | PASS |
| US-1.2 final line `OK-DEGRADED` with skipped list, clean run keeps `OK season=...` | D W26, existing W-cases (`OK season=2026-27 backup=new:...`); R aggregator test | PASS |
| US-1.3 notification OK / OK with warnings / FAILED, no "NBA.com" | R "notification texts" | PASS |
| US-1.4 Highlightly down: `FAIL stage=... reason="highlightly ..."`, exit non-zero, tunnel closed | D W27 (HTTP 500: FAIL stage=schedule, DB unchanged, tunnel dead, port free) | PASS |
| US-1.5 M5 pre-steps unchanged | D W1-W25 (all M5 cases still pass) | PASS |
| US-1.6 no bare `exit 1` | D W27 reason text; R "failed Highlightly step is a FAIL: reason from result line" | PASS |
| US-2.1-2.3 update tip/status, create crosswalk, never downgrade final/live | W weekly-schedule tests, C (`g.status === 'final'` and live skips) | PASS |
| US-2.4 unmatched not created (Q1) | W "crosswalk hit whose teams do not match", C: no `INSERT INTO games` anywhere in `worker/src/weekly-*.js` or `weekly-hl.js` (grep) | PASS |
| US-2.5 exhibition counted as skipped | W "exhibition / non-NBA side is skipped" | PASS |
| US-2.6 columns Highlightly cannot supply stay byte-identical | W "columns the schedule pass must not touch stay byte-identical"; C: UPDATE sets only status, scores, tipoff, local date | PASS |
| US-2.7 late west-coast tip keeps local date | W "late west-coast tip: LAL home..."; `team-tz` test over 30 clubs | PASS |
| US-2.8 rest/b2b recomputed only on date change | W "tip-off moved a day", "tip-off unchanged: no write" | PASS |
| US-2.9 idempotent | W "second run changes nothing (same updated_at)" | PASS |
| US-2.10 one bad match isolated; malformed whole response fails and writes nothing | W "one malformed match does not stop the others", "a whole malformed response fails the pass and writes nothing" | PASS |
| US-2.11 `ingestion_runs` row source=highlightly with counts and requests | C `weekly-hl.js` details; D W26 | PASS |
| US-3.1-3.2 box score + lineups written, real MEM@HOU values | W weekly-backfill tests against `box-score_1439038.json` | PASS |
| US-3.3 `nba_stats` rows untouched | W weekly-backfill; C (candidate query excludes games with nba_stats rows, re-check under `FOR UPDATE`, `WHERE source='highlightly'` upsert guard) | PASS |
| US-3.4 held players listed, not guessed | W; C `writeSides` held list | PASS |
| US-3.5 `box_score_checks = 2` makes no request | W; C (`box_score_checks < 2` in candidate query) | PASS |
| US-3.6 NBA reconcile runs when reachable, "skipped" when not | D W26, existing backfill drill cases | PASS |
| US-3.7 NBA path one transaction per season, rollback | C (unchanged BEGIN/COMMIT/ROLLBACK); D W31 | PASS |
| US-3.8 team_games only for games just loaded | C `writeSides` (`WHERE game_id AND team_id`) | PASS |
| US-3.9 ingestion_runs for backfill | C `weekly-hl.js` | PASS |
| US-4.1 positions skipped with message, exit 0 | C `load-positions.mjs` `skipExit` (message text matches spec); D W26 | PASS |
| US-4.2 reachable NBA.com unchanged | R `positions.test.mjs` unchanged and passing; C non-BE path identical | PASS |
| US-4.3-4.4 Highlightly positions | Not built; owner Q4 chose NBA.com-only | N/A (descoped by Q4) |
| US-4.5 log reports filled/remaining | C | PASS |
| US-5.1 NBA.com bounded (single 15 s probe, latch down, later calls skipped) | R `sources-best-effort.test.mjs`, C (`attempts = okCalls === 0 ? 1 : 2`, `gate()`); D W26 | PASS |
| US-5.2 NBA.com reachable: existing endpoints/pacing | C (non-BE path diff is `gate()` no-op plus `fixtureOr` pass-through) | PASS |
| US-5.3 tip-off stable across runs (Q9) | W tipoff authority tests, C (`WEEKLY_HL_TIPOFF` only when NBA.com did not load) | PASS (tested by fixtures, not by two consecutive real runs) |
| US-5.4 `WEEKLY_NBA=0` disables | R, C (`disabled`) | PASS |
| US-5.5 error names host + failure type, no body | R `NbaUnavailable` tests | PASS |
| US-5.6 unreachable never FAIL; malformed is a warning | R `classifyError` tests; D W31 | PASS |
| US-6.1 no NULL/default overwrite | W "byte-identical" test; C | PASS |
| US-6.2 never change nba_stats rows / final status / checks=2 | W, C | PASS |
| US-6.3 destructive NBA step only on complete data; zero-row fixture deletes nothing | D W31; R `nbaSeasonComplete` | PASS |
| US-6.4 one transaction, rollback on error | W "malformed response ... writes nothing"; C `inTransaction` | PASS |
| US-6.5 M5 backup unchanged | D W1-W25 | PASS |
| US-6.6 dry run | W "dry run: database unchanged"; `WEEKLY_DRY_RUN=1`, `--dry-run` | PASS |
| US-6.7 duplicate-game guard | N/A: Q1 is update-only, no creation | N/A |
| US-7.1 per-endpoint counts + quota in details | W hl-weekly-client tests; C | PASS |
| US-7.2 cap 600, "request cap reached", degraded not failed | W client cap test, W "dates are fetched nearest first (cap 3)"; D W29 | PASS |
| US-7.3 reserve 1,000, "quota unknown" without header | W client tests; D W28 (remaining 1002 -> stop=reserve, no partial game) | PASS |
| US-7.4 nearest-date-first | W; D W29 | PASS |
| US-7.5 429 Retry-After bounded, 401/403 immediate and keyless, 5xx retry twice | W hl-weekly-client tests (synthetic fixtures, labelled) | PASS |
| US-7.6 4 req/s pacing | W client pacing test | PASS |
| US-7.7 estimates and dashboard hint documented | README.md:152-153, `docs/architecture.md` 7.9 | PASS |
| US-8.1-8.2 stage summary lines, final line fields | C `weekly-hl.js` summary line; D W26/W28 | PASS |
| US-8.3 `db:status` weekly line | C `db-status.mjs` (new block); no automated test runs db-status against a weekly row except D (real `[status]` output appears in the log) | PASS with Note 4 |
| US-8.4 key redaction | R "redactor masks the Highlightly key"; D W30 | PASS |
| US-8.5 lists capped | C `capList`; W | PASS |
| US-8.6 existing log format kept | D W1-W25 line assertions | PASS |
| US-9.1-9.3 fixture-only tests, labelled synthetic | W/R run with no key and no network; fixture README labels recorded vs synthetic | PASS |
| US-9.4 root and worker tests pass, CI green | Section 3 | PASS |
| US-9.5 fake-weekly drill covers NBA down, HL down, reserve hit | D W26, W27, W28 | PASS |
| US-9.6 no production/real host in tests | C (fixtures switch `fixtureFetch`; `sources.fixtureOr` refuses a real request in best-effort fixture mode; D W32 guards) | PASS |
| Q3 runtime header checks + clean stop | W, D W28/W29: stop leaves only complete games, database consistent | PASS |
| Q5 no live recording | Recorded fixtures are the pre-existing four copies; error fixtures labelled synthetic | PASS |
| Q11 opt-in sweep gated on remaining > 3,000 | W "Q11 sweep: refused unless the live header says more than 3,000 remain"; C (`rem === null || rem <= threshold` refuses; off by default) | PASS |

Criteria not tested live (by design): real Highlightly/NBA.com response shapes for 401/403/429/5xx, the Highlightly quota period, and any real tunnel/Railway behaviour. All are covered only by synthetic fixtures and the fake Railway.

## 3. CI and automated test summary

- `gh pr checks 7`: backend, frontend, root, worker all pass.
- Root `npm test`: 110 tests, 110 pass.
- Worker `npm test` with no database configured: 91 tests, 40 pass, 51 skipped (DB-gated), 0 fail. This is the default local result and is easy to misread as green.
- Worker `npm test` against a throwaway local `postgres:18` container (`WORKER_TEST_DATABASE_URL`, database name contains `test`): 91 of 91 pass, 0 skipped. This includes the unmodified `worker/test/sync.test.js` (not in the diff; `git diff main...HEAD --name-only` shows no change to it) passing after the `loadBoxScore` refactor into `resolveSides`/`writeSides`.
- `npm run db:weekly:drill`: second, clean run `203 passed, 0 failed` (matches the Developer's 203). W26-W32 all pass.
- First drill run reported `202 passed, 1 failed`: "a postgres:// URL was seen in ps argv". The drill's sampler is `ps -axww` over the whole host (`weekly-drill.sh:211`), and I was running worker tests and a Docker Postgres container at the same time. I reran with nothing else running and it passed. I attribute the failure to my concurrent activity but could not isolate which process produced the match (see Finding 3).

## 4. Findings

1. **Note.** Clean stop on cap/reserve verified. Cap and reserve are checked before every request (`hl-weekly-client.js` `beforeRequest`); the remaining header is read on every response; a stop mid-pagination discards that date (a date counts only if every page arrived); the backfill writes only games whose box score and lineups both arrived. D W28 (remaining 1002, reserve 1000) and W29 (cap 3) confirm exit 0, `OK-DEGRADED`, no partial game, nearest dates first.
2. **Note.** Q1 verified: no `INSERT INTO games` exists in any new Highlightly weekly path. Unmatched matches are only reported.
3. **Minor.** The drill's secret scan (`weekly-drill.sh:211,225`) samples the argv of every process on the host, so it can fail for reasons unrelated to the weekly job if another process on the machine has a `postgres://` URL in its command line. I saw one such failure while running other work in parallel and a clean pass when the machine was otherwise quiet. Recommended fix: restrict the sampler to the drill's own process tree, or document "run alone". Not a product defect and not blocking.
4. **Minor.** `db:status` weekly line (US-8.3) has no dedicated assertion that checks its content (source, degraded flag, quota); the drill only checks that real `[status]` output reaches the log. The logic is a derivation across several `ingestion_runs` rows (`state`, `stop`, `degraded`), which is where bugs hide. Recommended: a small test that seeds two weekly rows (one `down`, one with `stop='reserve'`) and asserts the line.
5. **Minor.** The worker DB tests (51 of 91) skip silently without `WORKER_TEST_DATABASE_URL`, so a local `npm test` in `worker/` looks green while exercising almost none of the schedule and backfill logic. CI runs them (Postgres service container), so the merge gate is sound; this only matters for local confidence. Recommended: mention in the PR/README how to run them, or print a loud "51 skipped" notice.
6. **Note.** Regression check on manual `db:*` commands. `db:schedule`, `db:positions` and `db:backfill` only change behaviour under `--nba-best-effort` (passed only by `weekly.mjs`). Without the flag, `sources.mjs` `gate()` is a no-op, `fixtureOr` falls through to the original expression, error handling and exit codes are the original paths, and `ingestion_runs` details are unchanged apart from the optional `weekly_run_id` (absent without the flag). `positions.test.mjs` and the existing drill cases for the old behaviour pass. `db:status` gained one extra line and one extra query; it prints `weekly: no weekly run recorded yet` on a database with none. I did not run the manual commands against a real database (no safe one available), so this rests on diff reading plus the passing tests.
7. **Note.** The Q3 period is still unknown, so guardrails assume monthly. The worst case in the requirements (cap 600 x weekly plus the worker) is within the stated budget; the 505-request first sweep is correctly off by default and refuses unless the live header shows more than 3,000 remaining. Owner action remains: confirm the quota period on the dashboard before enabling `WEEKLY_HL_FULL_SEASON=1`.
8. **Note.** The merge redeploys the Railway worker (Lead item O1), because `worker/` changed. The `sync.js` change is a pure extraction (same SQL, same transaction, same call order; `sync.test.js` passes unmodified), so I found no behavioural change for the live poller. I did not test the live worker.
9. **Note.** Residual concurrency risk acknowledged by the Lead (two races needing a worker change): the weekly pass skips live/active-window games and re-reads `FOR UPDATE` against a pre-fetch snapshot, which the tests cover; the two residual races were not reproducible here and are accepted by the plan.

No Blocker or Major defects found.

## 5. Verdict

VERDICT: READY WITH CONDITIONS

Every acceptance criterion US-1 to US-9 traces to a passing test, drill case or code check, except US-4.3/4.4 (descoped by owner Q4) and US-6.7 (moot under update-only Q1). CI is green; I independently reproduced root 110/110, worker 91/91 with a real local Postgres (including the unmodified `sync.test.js`), and a clean 203/203 drill run covering NBA.com blocked with exit 0 `OK-DEGRADED`, Highlightly down with the tunnel closed and port free, reserve and cap clean stops with no partial writes, and key redaction. Conditions: (a) the owner confirms the Highlightly quota period before ever setting `WEEKLY_HL_FULL_SEASON=1`; (b) the owner accepts that merge redeploys the worker (O1); (c) before relying on the first real Monday run, the Lead or Dev considers closing Finding 4 (a `db:status` weekly-line test), and Findings 3 and 5 are logged as follow-ups. None of these block merge on QA grounds. Residual risk: all Highlightly error shapes and the quota period are unverified against the live service by design (Q5 declined), so the first real run should be watched.

## Handoff

- **Done:** Independent QA of PR #7: traced all acceptance criteria, ran root tests (110/110), worker tests with and without a local Postgres (91/91 with DB; 51 skip without), CI check status (4/4 pass), and the full weekly drill (203/203 on a clean run), plus code review of the cap/reserve/clean-stop paths, the no-insert rule (Q1) and the manual-command regression surface.
- **Files created:** `/Users/jayprox_pro/Documents/Projects/git/ai-application-nba/docs/reviews/M6/qa.md`. No source touched. Throwaway containers removed.
- **Open questions:** Owner: Highlightly quota period (gates the Q11 sweep); acceptance of the worker redeploy on merge. Lead/Dev: whether to add a `db:status` weekly-line test and harden the drill's `ps` sampler.
- **Recommended next role:** Lead review (read this alongside `security.md`), then Coordinator readiness report.

---

# Re-review (fix cycle 1), 2026-11-03

Scope: HEAD `db52e097486d3feb549b2b1bb724996a57553d94`, delta `git diff b3278b8..db52e09` (12 files). Same constraints as before: no source edits, no live calls, no `.env`.

## R1. Results

| Check | Result |
|---|---|
| `gh pr checks 7` | backend, frontend, root, worker all pass |
| Root `npm test` | 115 of 115 pass (was 110; +5 `weekly-status` tests) |
| Worker `npm test`, throwaway local `postgres:18`, container removed afterwards | 102 of 102 pass, 0 skipped (was 91; +11 new). `sync.test.js` still unmodified and passing |
| `npm run db:weekly:drill`, machine otherwise idle | 203 passed, 0 failed; both "no password in ps argv" and "no postgres:// URL in ps argv" pass; W26-W32 pass |

## R2. Previous Minors

- **Finding 3 (drill `ps` sampler): resolved.** The sampler now filters `ps` output to descendants of the drill shell (`$$`) in `scripts/weekly-drill.sh:211-213`. I checked the filter on a scratch script: a marker process started under the root shell is kept, so the scan is not vacuous, and the drill passed on a clean run. Residual: I did not re-run it with a deliberately noisy host to prove the original failure no longer occurs, only that the filter selects by tree.
- **Finding 4 (`db:status` weekly line tests): resolved.** The logic moved verbatim into `scripts/lib/weekly-status.mjs`; `db-status.mjs` now only calls it, and the output template is unchanged (diff reads identically). `weekly-status.test.mjs` pins five cases: no rows, clean run (both sources, requests summed, last quota), NBA.com down, reserve stop with a failed NBA row, and missing quota. These match what I asked for.
- **Finding 5 (worker DB tests skip silently):** unchanged by design; CI runs them. Still a Note.

## R3. Security fixes, regression check

- **Whole-line key masking (`worker/src/line-mask.js`, `weekly-hl.js`).** Output is buffered to a newline and masked per whole line, so a key split across two `write()` calls is caught; `flush()` runs on `exit`. Key is now read even in fixture mode, so it is always masked. Tested by `line-mask.test.js` and a new `weekly-hl-cli.test.js` case; drill W30 passes end to end and the result line still reaches the parent (the `@@WEEKLY` line is emitted and parsed in W26-W28). Behaviour change to be aware of: stdout/stderr are now line-buffered through the masker, so progress lines appear at newline boundaries only; harmless for the log. Note A (Minor, low risk): in the over-64 KB-without-newline branch the retained tail equals the key length, so a key straddling that cut could leak at most its first character; only reachable with a single 64 KB line, which this CLI never prints.
- **Streamed body timeout and size limit (`hl-weekly-client.js`).** The timeout now covers headers plus body; the body is read through the reader and cancelled once it exceeds `maxBody`; oversize and malformed bodies are not retried (`HighlightlyMalformed` rethrown before the 5xx/network retry path); a failed attempt is still counted once (`counted` flag prevents double counting, and a response that arrived is counted by `afterResponse`). New tests in `hl-weekly-client.test.js` cover the stalled body, the oversize stream and the no-retry rule, and all of the earlier client tests (cap, reserve, 429, 401/403, 5xx, pacing) still pass, so I see no regression in the budget accounting.
- **Score validation (`weekly-schedule.js`).** `badMatch` now rejects non-array scores, more than 20 periods, non-integer or negative periods, a period over 150, or a team total over 400. A bad match is counted in `bad_matches`, listed, and skipped; the other matches in the same response are still applied (new test in `weekly-schedule.test.js`, passing). Valid fixtures, including the recorded 2026-04-12 day, still pass unchanged.

No new defects found. No regression found in the areas touched.

## R4. Updated findings status

1. Minor (drill sampler): closed. 2. Minor (`db:status` tests): closed. 3. Note A (above, 64 KB masker edge): open, optional. Notes 6-9 from the first review are unchanged. Conditions (a) quota period before `WEEKLY_HL_FULL_SEASON=1` and (b) owner acceptance of the worker redeploy remain owner actions; condition (c) is satisfied.

VERDICT: READY

Rationale: all four CI jobs pass; I independently reproduced root 115/115, worker 102/102 against a real local Postgres, and a clean 203/203 drill at `db52e09`. Both of my Minors are fixed and verified, and the three security changes (whole-line masking, streamed body limit with timeout, score validation that skips only the bad match) behave as described with no regression in the quota, clean-stop, update-only or no-partial-write behaviour. The only remaining items are owner actions that were never QA blockers: confirm the Highlightly quota period before enabling the one-time sweep, and accept that merging redeploys the worker. Residual risk is unchanged: real Highlightly error shapes are unverified by design.

## Handoff (re-review)

- **Done:** Re-ran CI status, root tests (115/115), worker tests with a throwaway Postgres (102/102, container removed), and the drill (203/203); verified the sampler scoping, the `db:status` tests, and the three security changes by diff review and tests.
- **Files touched:** `docs/reviews/M6/qa.md` (appended this section). No source touched.
- **Open questions:** Owner: quota period, worker-redeploy acceptance. Optional: tighten the masker's overflow tail (Note A).
- **Recommended next role:** Lead final review, then Coordinator readiness report.

---

# Re-review (fix cycle 2), 2026-11-03

Scope: HEAD `f2f6099a673ac0f787842ddbdcb3b1b59c04d94e`, delta `git diff db52e09..f2f6099` (5 files: `line-mask.js`, `weekly-hl.js`, `weekly-drill.sh`, two test files). No source edits, no live calls, no `.env`.

| Check | Result |
|---|---|
| `gh pr checks 7` | backend, frontend, root, worker all pass |
| Root `npm test` | 115 of 115 pass |
| Worker `npm test`, throwaway local `postgres:18` (removed afterwards) | 107 of 107 pass, 0 skipped (+5 new); `sync.test.js` still unmodified |
| `npm run db:weekly:drill`, machine otherwise idle | 203 passed, 0 failed |
| W30 key redaction | All checks pass: vendor name equal to the key masked in the log, key absent from weekly log, backup log, stdout and stderr, key absent from `ingestion_runs.details`, tunnel dead and port free |
| `@@WEEKLY` parsing | W26-W28 (OK-DEGRADED, Highlightly-down FAIL, reserve stop) and the root contract test "the Highlightly child ... prints a result line the parser accepts" pass, so the result line still reaches and is parsed by the runner after the `endLine()` change |

Code review of the delta:
- **Masker overflow (`line-mask.js`).** The over-long-line branch now masks the whole buffer first and holds back only the last (key length - 1) characters, the longest prefix of a key that a later write could complete. This closes my Note A (the one-character leak). New masker tests cover it and pass.
- **`endLine()` before `@@WEEKLY` (`weekly-hl.js`).** Pending unterminated text is written masked followed by a newline, so the result line always starts on its own line and the parser cannot be fed a glued line. A new CLI test covers it; the drill confirms the parse path.
- **Drill `WEEKLY_HL_ENV_FILE` = empty file.** Drills can no longer read the real repo `.env` through the Highlightly step's file fallback; this is a safety improvement for the drill and did not change any case result (203/0).

No new defects. My Note A is closed. Remaining open items are unchanged owner actions: confirm the Highlightly quota period before enabling `WEEKLY_HL_FULL_SEASON=1`, and accept that merging redeploys the worker.

VERDICT: READY

Rationale: all four CI jobs pass, and I independently reproduced root 115/115, worker 107/107 with a real local Postgres, and a clean drill at 203/0 with W30 and the `@@WEEKLY` result-line path intact. The fix-cycle-2 changes are narrow, tested, and introduce no regression in redaction, quota handling, clean stops, update-only behaviour or the manual `db:*` commands.

## Handoff (re-review, fix cycle 2)

- **Done:** Reran CI status, root tests, worker tests against a throwaway Postgres (removed), and the full drill; reviewed the cycle-2 delta; confirmed W30 and result-line parsing.
- **Files touched:** `docs/reviews/M6/qa.md` (appended this section). No source touched.
- **Open questions:** Owner: quota period before the one-time sweep; acceptance of the worker redeploy on merge.
- **Recommended next role:** Lead final review, then Coordinator readiness report.
