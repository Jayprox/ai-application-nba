# Lead review: M1 CI test workflow (PR #2)

VERDICT: READY WITH CONDITIONS

The implementation matches the plan and the owner decisions (D1 = A, worker fixture fix). CI is green at the PR head. QA and Sec both say READY. There are two conditions, both doc-only one-liners (findings 3 and 4). After they land, the result is READY with no new QA or Sec review. If those two lines get written, CI goes green on the new head, and nothing else changes, the Coordinator can treat this as READY.

## 1. Scope and evidence

- PR #2, branch `chore/ci-workflow`, head `36f71c3af5251900f5c5c56743544a76900b7e1e` (`gh pr view 2`). The PR is OPEN.
- `git diff main...HEAD --stat` shows 7 files: the workflow, README, the onboarding docs, the plan, and `worker/test/players.test.js` (+5/-3 lines). No application source changed.
- CI run 41384296966 has `headSha` = 36f71c3, `conclusion: success`, and root, frontend, worker and backend all `success`.
- Inputs read: plan `docs/plans/M1-ci-test-workflow.md`, `docs/STATUS.md` (approvals), `docs/reviews/M1/qa.md` (READY at 36f71c3), and `docs/reviews/M1/security.md` (READY at 89c4791; 89c4791..36f71c3 changes docs only, which QA confirmed in its §5).
- Approved requirement: the owner's mission text, recorded in `docs/STATUS.md` under Approvals. This review checks against approved requirements only.

## 2. Plan conformance

| Plan item | Result | Evidence |
|---|---|---|
| T1 worker fixture | Done, with an approved and justified extension (finding 2) | `worker/test/players.test.js:31-32` (scores 100, 90) and `:41` (stat rows moved to `${MEM}`). Assertions unchanged. CI worker job: 23/23, 0 skipped (QA §3). |
| T2 workflow | Done | `.github/workflows/test.yml`. Triggers are on lines 12-15, `permissions` on 17-18, concurrency on 20-22. There are four jobs. Postgres runs only in worker (64-77) and backend (96-109), and each has its own DB. Backend runs `db:apply` and then the D1 = A file list (124-132). |
| T3 docs | Done, one stale cell (finding 3) | `docs/architecture.md` §9.3 CI bullet (lines ~792-802). README Tests line (README.md:175). The architecture.md diff against main is one hunk with 0 deletions, so sections 1-8 are unchanged. |
| §5 AC 1-11 | All pass | QA §2 traceability table, which I spot-checked against the file. |

## 3. Findings

1. **Note: actions v7 instead of the plan's v6 is accepted.** Plan §3 said "versions must be checked against the actions' release pages at implementation time", so moving to the current major follows the plan. Both pins are full SHAs with version comments (`test.yml:29,32` and the same pins in every job). Sec verified that the SHAs match upstream tags `v7.0.1` and `v7.1.0`, and CI ran green on them. No action needed.

2. **Note: the HOU -> MEM stat-row move is accepted.** I checked the logic. `worker/src/players.js:34-38` builds Pool 1 from `current_team_id = team` OR a stat row *for that team* this season or last. `matchPlayer` resolves against that pool first (`players.js:49`; `names.js:83` returns `name+team+date`). With HOU stat rows for a HOU entry, the test never reached the `no_candidate` -> `name+recent_inactive` branch (`players.js:55-76`) it was written for. QA reproduced this: reverting to HOU fails with `actual: 'name+team+date'`. MEM is the faithful fixture for "played recently elsewhere, now signs here". This was a gap in my plan's T1, which called for scores only. The plan, the PR body and architecture.md §9.3 now record the change. It stays within the owner's approval to "fix the broken worker test fixture", because no assertion and no source changed.

3. **Minor (condition): stale cell in the §9.3 table.** `docs/architecture.md:756` (worker row) still says "With it: 22 pass, 1 fail (see below)". After T1 the result is 23 pass, 0 skip, which the same section's "Fixed (M1, T1)" bullet and the CI bullet (line ~795, "23 tests, none skipped") both say. Plan T3's definition of done is "docs match the merged workflow".
   **Fix:** change the cell to something like "without it: 17 pass, 6 skip. With it: 23 pass (22 pass, 1 fail before M1 T1)".

4. **Minor (condition): the explicit backend file list is maintainable only if the rule is written where developers look.** `test.yml:132` is an allow-list. A new `backend/test/*.test.js` file will silently *not* run in CI, and CI stays green. The workflow comment (`test.yml:11`) and `docs/architecture.md:802` both state the rule. Plan §7 named STANDARDS as part of the mitigation, but `docs/STANDARDS.md` §2 "Tests" (lines 40-67) does not mention it. With four short entries and a single `node --test` line, the list is easy to maintain *if* people know about it. Today there are 9 test files: 4 listed and 5 local-only (`ask`, `auth`, `browse`, `props`, `query`).
   **Fix (this PR):** add one bullet to STANDARDS §2: "Backend CI runs an explicit file list (`.github/workflows/test.yml`, D1 = A). A new backend test file that passes on an empty schema must be added to it. If it needs loaded data, say so in the PR." Writing this bullet satisfies condition 4.
   **Follow-up (optional, not required here):** a small CI guard step that fails when `backend/test/*.test.js` contains a file that is in neither the CI list nor a documented local-only list. M2 (the fixture DB) would remove the list entirely.

5. **Note: the security exposure on `main` should not block this merge. It should be a separate, high-priority follow-up for the owner.** Sec finding 1 concerns `docs/architecture.md:698`. My reasoning:
   - This PR did not introduce the line, and the PR's hunk only shows it as context. The exposure has existed on `main` and in history since `dd58399`. Holding the merge does not change it.
   - Removing the line from the doc does not fix it, because public history keeps the value. The real fix is an operational change on Railway: rotate or disable the TCP proxy and confirm the password strength. That is outside this repo and needs the owner's decision.
   - Bundling a doc redaction into a CI PR widens the scope and mixes a security fix into an unrelated review trail.

   **Recommendation:** the Coordinator raises it with the owner in the readiness report as a separate item:
   - (a) The owner rotates or disables the Railway public proxy when backfills are not running.
   - (b) A `fix/redact-db-proxy-host` PR replaces the host:port in `docs/architecture.md` with a placeholder. Sec reviews it.

   Treat it as urgent, but not as a gate on PR #2. The hostname is deliberately not repeated in this review.

6. **Note (answers QA finding 4): the `name+team+date` path does not set `is_active = true`. This looks like a likely gap, not a confirmed design choice, and it is out of scope for M1.**
   - **Evidence:** `players.js:49-53` writes only the crosswalk on a team-pool match. `is_active = true` is set only on the recent-inactive path (`players.js:73`) and for players the worker creates (`:87`). Elsewhere it is set by `scripts/seed.mjs:210-218` (from NBA.com rosters, run from JD's Mac) and by `scripts/review-players.mjs:34`. Pool 1 includes players who have a stat row for the team last season, whatever `is_active` says. So a player who was marked inactive and then re-signed with *the same* team would match `name+team+date` and keep `is_active = false` until the next seed. Inactive players are filtered out of `backend/src/routes/browse.js:28` (team roster) and `worker/src/props.js:50` (props pool), and they rank lower in `backend/src/ask/resolve.js:40-42`.
   - **Why this may be intended:** the team pool may be trusted to agree with the seed's roster data, and f0e6dd3's commit message only claims activation for the auto-link path. I could not determine the intent from the code or the history.
   - **Recommendation:** open a bug-fix triage item after M1. Either set `is_active = true` (and `current_team_id`) on team-pool matches too, with a test, or document why not. It needs no action in this PR.

7. **Note: workflow design choices are sound.**
   - Separate per-job databases keep the worker's `DROP SCHEMA public` away from the backend's database (`test.yml:79`).
   - The backend's `--test-concurrency=1` matches `backend/package.json:12`.
   - Job-level `DATABASE_PUBLIC_URL`/`TEST_DATABASE_URL` point only at the disposable service.
   - The backend cache keys on both lockfiles (`test.yml:121-123`).
   - Sec's optional hardening is fine to defer: `--ignore-scripts`, a digest pin for `postgres:18`, and the first-time-contributor approval setting. So is QA's note about `ubuntu-latest` drift.
   - Branch protection ("require status checks") is an owner setting after merge (plan §8). The four job names `root`, `frontend`, `worker` and `backend` are the check names to require.

## 4. Conditions to reach READY

1. `docs/architecture.md:756`: update the worker cell (finding 3).
2. `docs/STANDARDS.md` §2: add the backend file-list bullet (finding 4).

Both are doc-only. Dev fixes them in this PR, and that counts as fix cycle 2 of 3. After that, CI on the new head needs to be green. QA and Sec do not need to re-review, because no workflow, test or source file changes.

## Handoff
- **Done:** Lead review of PR #2 at 36f71c3 against the plan, the owner decisions, STANDARDS, and the QA and Sec verdicts. Checked the workflow, fixture logic, docs accuracy, CI run and the `is_active` question.
- **Files created:** `docs/reviews/M1/lead.md` (uncommitted). No source edited and nothing committed.
- **Open questions:** whether `is_active` should be set on the `name+team+date` path (finding 6, follow-up). The owner's decision on the Railway proxy exposure (finding 5, separate follow-up).
- **Next role:** Dev, for the two doc-only conditions. Then the Coordinator writes the readiness report and includes finding 5 as a separate owner item.
