# Plan M6: Weekly job on Highlightly (NBA.com best-effort)

Author: Engineering Lead. Date: 2026-11-03. Branch: `feat/m6-highlightly-weekly`.
Requirements: `docs/requirements/M6-highlightly-weekly.md` (APPROVED 2026-11-03). Binding owner answers: `docs/STATUS.md`, M6 Approvals, Q1-Q11.
Inputs read: `CLAUDE.md`, `docs/STANDARDS.md`, `docs/architecture.md` (§3, §7.2-7.4, §8, §9), `docs/plans/M5-weekly-tunnel.md`, `docs/reviews/M5/security.md`, `scripts/weekly.mjs`, `scripts/weekly.sh`, `scripts/lib/weekly.mjs`, `scripts/lib/sources.mjs` (+ test), `scripts/load-schedule.mjs`, `scripts/load-positions.mjs`, `scripts/backfill.mjs`, `scripts/db-status.mjs`, `scripts/lib/env.mjs`, `scripts/lib/tagging.mjs`, `scripts/weekly-drill.sh`, `scripts/fixtures/fake-weekly-step.mjs`, `worker/src/{highlightly,sync,map,planner,players,rest,db,index}.js`, `worker/scripts/sync.js`, `worker/test/sync.test.js`, the four Highlightly fixtures, `db/schema.sql`, `.github/workflows/test.yml`, `ops/launchd/com.chalkthat.nba.weekly.plist`.
No live API, production, Railway, `.env` or `.env.example` access.

---

## 1. Summary

The weekly run becomes **Highlightly first, NBA.com best-effort**:

```
guard -> lock -> preflight -> backup -> tunnel                       (M5, unchanged)
  schedule : schedule:nba  (load-schedule.mjs --nba-best-effort; the run's single NBA.com probe)
             schedule:hl   (worker/scripts/weekly-hl.js schedule; 7 days back .. 60 ahead)
  positions: positions:nba (load-positions.mjs --nba-best-effort; skipped when NBA.com is down)
  backfill : backfill:hl   (worker/scripts/weekly-hl.js backfill; box-score catch-up)
             backfill:nba  (backfill.mjs --season S --nba-best-effort; existing reconcile)
  status   : db-status.mjs (adds a "weekly" line)
-> close tunnel (M5, unchanged) -> OK | OK-DEGRADED | FAIL line + notification
```

- The Highlightly work lives in the **worker package** (`worker/src/weekly-*.js`, CLI `worker/scripts/weekly-hl.js`). It reuses the worker's tested matching, box-score and player-resolution code instead of copying it into `scripts/`. Running a worker-package script from the Mac is an existing pattern (`worker/scripts/sync.js`, "From JD's Mac").
- The live worker's runtime path (`worker/src/index.js` loop) keeps the same behaviour. The only change to live code is a pure refactor of `loadBoxScore` (T2), guarded by the existing `worker/test/sync.test.js`.
- No schema change, no migration, no new dependency.
- Every Highlightly request in the weekly job goes through one guarded client. The client enforces the per-run cap (600), the reserve (1,000, read from `x-ratelimit-requests-remaining` on every response), 4 req/s pacing, and the 429/401/403/5xx rules. Each step **fetches first and writes after**, in one short transaction. A cap or reserve stop therefore writes only complete units and never leaves partial data.
- NBA.com gets one probe with a 15 s limit and no retry. When it fails, the rest of the run skips NBA.com immediately, and the run ends `OK-DEGRADED` with exit 0 (Q2).

## 2. Decisions (routine, inside the approved requirements)

| # | Decision | Why / requirement |
|---|---|---|
| D1 | Highlightly weekly code goes in `worker/` (new modules + CLI). `scripts/` keeps the NBA.com path. | No cross-package imports (STANDARDS §1). One box-score write path instead of two copies that could drift. Precedent: `worker/scripts/sync.js` runs from the Mac. |
| D2 | **Fetch-then-write**: each HL step does all its network I/O first, then one transaction (`BEGIN … COMMIT`) with batched SQL, `SET LOCAL lock_timeout = '5s'`. No network calls inside a transaction. | US-6.4 (one transaction per stage), Q3 (clean stop, no partial-write damage), and short locks so the live worker is not blocked (§5). |
| D3 | Sub-steps report to `weekly.mjs` through **one result line** on stdout: `@@WEEKLY {json}` (spec in §4.4). Exit code stays the pass/fail signal. Exit 0 plus `degraded:true` means `OK-DEGRADED`. | The parent only sees exit codes today (`weekly.mjs:274`). Manual runs keep their exit codes (NFR compatibility). |
| D4 | The **per-run** cap is tracked by the parent. Each HL child gets `WEEKLY_HL_BUDGET = cap − used so far` and `WEEKLY_HL_LAST_REMAINING` (last header value seen). | The cap is per run (US-7.2), but the work spans two child processes. |
| D5 | Tip-off authority (Q9, US-5.3): `schedule:hl` updates `tipoff_utc` **only when `schedule:nba` did not load this run** (down, disabled, or failed with a warning). When NBA.com loaded, HL updates status/score only. | NBA.com wins when it answered completely. Two runs in a row with the same NBA.com availability give the same result. |
| D6 | NBA.com best-effort mode is opt-in per invocation (`--nba-best-effort`, passed only by `weekly.mjs`). Manual `db:schedule` / `db:positions` / `db:backfill` keep today's 30 s × 3 attempts and today's exit codes. | NFR compatibility. |
| D7 | NBA-side problems in best-effort mode are classified as a **warning** (exit 0, degraded): network/timeout/403, a malformed or unexpected response shape, and a backfill season that fails its `checks failed` (the NBA.com data is internally inconsistent). Database errors (connection, constraint, lock timeout) are **FAIL**. In both cases the transaction rolls back. | Q2 (only Highlightly or database failures FAIL), US-5.6, US-3.7. |
| D8 | Cap and reserve can be changed **only in the safer direction**: `WEEKLY_HL_CAP` 1..600 (default 600), `WEEKLY_HL_RESERVE` 1000..100000 (default 1000). The 3,000 sweep threshold is a constant. | Q3 / Q7 / Q11 are owner values. Tests can still use tiny caps. |
| D9 | Box-score catch-up window: final games with tip-off in `[now − DAYS_BACK, now − 8 h]`, `box_score_checks < 2`, and no `nba_stats` player rows. `WEEKLY_HL_DAYS_BACK` defaults to 7 (max 30). | US-3.1. The 8 h exclusion stays out of the worker's active window (`planner.js:31`). A game skipped in that window falls into next week's 7-day window. |
| D10 | `game_date_local` is recomputed only when a tip-off change moves the local date, using a static home-team IANA time-zone map in the worker package. Neutral-site games never take a Highlightly tip-off change; those are reported as `needs_nba`. Shifts over 7 days are reported as `needs_review` and not applied. | US-2.7 / US-2.8 with no schema change. There are no venue time zones for neutral sites. A large shift probably means a bad match. |
| D11 | `weekly.mjs` still **does not read `.env`** (M5 rule). Key redaction has two layers: (a) the parent redacts `process.env.HIGHLIGHTLY_API_KEY` when set; (b) the HL child redacts its own key from everything it writes (wrapped `stdout`/`stderr`, plus `uncaughtException`/`unhandledRejection` handlers), and errors never carry headers, URLs with keys, or response bodies. | US-8.4 and NFR Security. This keeps M5's design. See §9 item S1 for Security to confirm. |
| D12 | Fixture safety: a **production** run refuses `HIGHLIGHTLY_FIXTURES`, `SEED_FIXTURES` and `WEEKLY_STEP_FIXTURE`. A **fake** run (fake railway) requires `HIGHLIGHTLY_FIXTURES`, and either `SEED_FIXTURES` or `WEEKLY_NBA=0`. | Stops fixture data reaching production, and stops a drill spending real quota or calling NBA.com (US-9.6). |
| D13 | Positions stay NBA.com-only (Q4). No Highlightly code writes `players.listed_position`. | Q4. US-4.3 is not applicable. US-4.4 becomes a "never touched" test. |
| D14 | Highlightly never creates games (Q1). US-6.7 is not applicable. It is replaced by a test that asserts `games` row count and `entity_id_crosswalk(source='nba_stats')` are unchanged by HL steps. | Q1, duplicate-game risk (§6). |

## 3. Files to change

| File | Change | Task |
|---|---|---|
| `worker/src/hl-weekly-client.js` (new) | Guarded Highlightly client for the weekly job: cap, reserve, pacing, 429/401/403/5xx/timeout policy, per-endpoint counts, quota from headers, size-bounded JSON parse, typed errors, `fetchImpl` injection, fixture fetch. | T1 |
| `worker/src/hl-fixture-fetch.js` (new) | `fixtureFetch(dir)`: maps request path to a fixture file and returns a Response-like object (status, headers, body). Never touches the network. | T1 |
| `worker/src/highlightly.js` | Additive only: export `hostFor(key)` (direct vs RapidAPI base + headers) so both clients share it. Live client behaviour unchanged. | T1 |
| `worker/src/sync.js` | Pure refactor: split `loadBoxScore` into `boxReady(box)`, `resolveSides(db, …)`, `writeSides(db, …)`. Export `teamMap`, `findGame`. Live `loadBoxScore` / `syncDate` behave exactly as before. | T2 |
| `worker/src/team-tz.js` (new) | 30-team abbreviation → IANA zone map, plus `localDate(tipUtc, abbr)`. | T3 |
| `worker/src/weekly-schedule.js` (new) | HL schedule pass (window, nearest-first, match/update/report, team rest recompute). | T3 |
| `worker/src/weekly-backfill.js` (new) | HL box-score catch-up (candidates from DB, fetch, optimistic write). | T4 |
| `worker/scripts/weekly-hl.js` (new) + `worker/package.json` script `weekly-hl` | CLI: `schedule` / `backfill`, `--season`, `--dry-run`; DB from `DATABASE_PUBLIC_URL` only; key from env, else repo `.env` (env wins); self-redaction; `ingestion_runs` row; `@@WEEKLY` result line; Q11 sweep opt-in. | T5 |
| `worker/test/hl-weekly-client.test.js`, `weekly-schedule.test.js`, `weekly-backfill.test.js`, `weekly-hl-cli.test.js` (new) | Fixture tests (§7). | T1, T3, T4, T5 |
| `worker/test/fixtures/weekly/**` (new) | Copies of recorded fixtures plus `synthetic_*` files and a `README.md` saying which files are recorded and which are synthetic. | T1, T3, T4 |
| `scripts/lib/sources.mjs` (+ `sources.test.mjs`) | Best-effort NBA.com mode: 15 s header timeout, no retry on the first call, process-wide "down" latch, `NbaUnavailable` with host and kind, no body or headers in messages. Fixture-mode simulation of an unreachable or malformed NBA.com (synthetic). | T6 |
| `scripts/lib/nba-best-effort.mjs` (new, + test) | Pure helpers: error classification (NBA-side vs DB), `@@WEEKLY` line builder, `nbaSeasonComplete()` guard, skipped-enrichment names. | T6 |
| `scripts/load-schedule.mjs`, `scripts/load-positions.mjs`, `scripts/backfill.mjs` | `--nba-best-effort` flag: honour `WEEKLY_NBA` / `WEEKLY_NBA_STATE`, classify errors, print the summary and `@@WEEKLY` line, add `weekly_run_id` to `ingestion_runs.details`. Without the flag: unchanged. | T6 |
| `scripts/lib/weekly.mjs` (+ `weekly.test.mjs`) | Sub-step table, `stepArgv`/`stepEnv` for sub-steps (strip user-set internal vars, add internal ones), result-line parser, run aggregator, final-line and notification text builders, new config (`WEEKLY_NBA`, `WEEKLY_HL_*`, `WEEKLY_DRY_RUN`), fixture guards (D12). | T7 |
| `scripts/weekly.mjs` | Run the sub-steps, parse result lines, pass state and budget forward, `OK` / `OK-DEGRADED` / `FAIL` final line, new notification text, redaction list adds the env key. M5 pre-steps and cleanup unchanged. | T7 |
| `scripts/weekly.sh` | Notification text "Weekly run FAILED" (drop "NBA.com"); header comment. | T7 |
| `scripts/db-status.mjs` | "weekly:" line for the last weekly run (§4.6). Still read-only. | T8 |
| `scripts/weekly-drill.sh`, `scripts/fixtures/fake-weekly-step.mjs`, `db/tests/weekly_drill_seed.sql` (new) | M6 drill cases (§7.3). `wres()` matches `OK-DEGRADED`. | T9 |
| `docs/architecture.md`, `README.md`, `ops/launchd/README.md` | §3.1 correction (weekly uses `stats.nba.com/scheduleleaguev2`, not the cdn file), new §7.9 "Weekly job on Highlightly", §9.2/§9.3 run and test, env flags, request estimates and the dashboard check (US-7.7). | T10 |

Not touched: `db/schema.sql`, migrations, `worker/src/index.js`, `worker/src/planner.js`, `backend/`, `frontend/`, the launchd plist, the M5 guard/backup/tunnel code paths, `.env`, `.env.example` (see §9 item O3).

## 4. Technical approach

### 4.1 Guarded Highlightly client (`hl-weekly-client.js`)

`createWeeklyHighlightly({ key, fetchImpl, budget, reserve, rps, lastRemaining, sleep, now, log })` returns `{ matches(etDate), boxScore(id), lineups(id), stats }`.

- **Before every request:** if `stats.total >= budget`, throw `BudgetStop('cap')`. If the known remaining is not null and `remaining − 1 < reserve`, throw `BudgetStop('reserve')`. Pacing: the request starts no sooner than `1000/rps` ms after the previous one.
- **After every response, whatever its status:** parse `x-ratelimit-requests-limit` / `-remaining`. Values must be non-negative integers of at most 7 digits; anything else counts as unknown. A missing header logs `quota unknown` once. Count the request under its endpoint (`matches`, `box-score`, `lineups`, `other`). Retries count too.
- **Status policy (US-7.5):** 200 → body. 404 → `null` (same as the live client). 429 → wait `Retry-After` (seconds or HTTP-date, each wait capped at 30 s, total at 60 s), at most 3 retries, then `BudgetStop('rate_limited')` (stop all HL work for this run, degraded). 401/403 → `HighlightlyAuthError` straight away (`highlightly auth rejected (401)`), no retry. 5xx / network / timeout (20 s) → retry twice with 1 s and 3 s back-off, then `HighlightlyUnavailable` (`highlightly unreachable (timeout|network|HTTP 5xx)`).
- **Body:** read as text, refuse anything over 5 MB, then `JSON.parse` in a try. A failure → `HighlightlyMalformed`. `matches` checks that `data` is an array and paginates `limit=100&offset=` until a short page or `pagination.totalCount`, with a hard stop at 10 pages.
- **Errors and logs** carry endpoint, path without query, status and kind only. They never carry the key, request headers or response body.
- **Fixture mode:** `fetchImpl = fixtureFetch(HIGHLIGHTLY_FIXTURES)`. The file is `<name>.json`. Page 2+ is `<name>@<offset>.json`. An optional sidecar `<name>.meta.json` gives `{status, headers, retryAfter, rawBody, delayMs}` for synthetic errors. An optional dir-level `_quota.json` (`{limit, remaining}`) is decremented per call to simulate headers. When `HIGHLIGHTLY_FIXTURES` is set, `globalThis.fetch` is never used.

### 4.2 HL schedule pass (`weekly-schedule.js`, US-2, US-7.4)

1. **Dates:** ET dates from `today − DAYS_BACK` to `today + DAYS_AHEAD` (7 / 60), **nearest first** (today, −1, +1, −2, +2, …, −7, +8 … +60), so a cap cuts the far future first.
2. **Fetch:** one `matches(date)` per date until a stop. A date counts only if all its pages arrived; a partial date is discarded.
3. **Check each match:** `id` is a positive integer, both team ids are present, `date` parses as ISO, and `season` is the end year of `--season`. A bad match is reported and skipped (US-2.10). A whole response that is not JSON or has no `data` array → `HighlightlyMalformed` → stage FAIL, nothing written.
4. **Write (one transaction):**
   - Team ids map through the `highlightly` team crosswalk (`sync.js:11-14`). A non-NBA side → `skipped_exhibition` (US-2.5).
   - Find the game with the existing `findGame` (crosswalk first, then team pair + tip-off ±8 h). If the game came from the crosswalk, its team pair must match in either orientation, else `unmatched: crosswalk team mismatch`. No game or several games → `unmatched` (date, teams). **Never insert into `games`** (Q1).
   - `SELECT … FOR UPDATE` the game and compare `updated_at` / `status` / `tipoff_utc` with the fetch-time snapshot. If anything changed, `skipped_changed` (the worker got there first).
   - Skip and count `skipped_worker` for games that are `live`, or whose tip-off is in `[now − 8 h, now + 10 min]` (the worker's window).
   - Skip games already `final` (US-2.3, US-6.2). For other games, status uses `statusOf`; `final` needs both scores (worker rule `sync.js:53-54`).
   - If tip-off authority is on (D5) and HL `date` ≠ stored `tipoff_utc`: skip with `needs_nba` for neutral sites, `needs_review` for a shift over 7 days, else update `tipoff_utc` and log `tip-off <date> AWY@HOM old → new`. If the home-zone local date changes, update `game_date_local` and add both teams to the rest recompute.
   - Columns written: `tipoff_utc`, `game_date_local`, `status`, `home_score`, `away_score`, `updated_at`, plus `team_games.rest_days` / `b2b_night`, plus `highlightly` game crosswalk rows. Nothing else (US-2.6, US-6.1). `updated_at` changes only when a value changes (idempotence, US-2.9).
   - **Team rest recompute (US-2.8):** for each affected team, all its games in the season, using the `load-schedule.mjs:86-106` rule (preseason tagged among themselves; real games anchored by preseason dates), with `worker/src/rest.js`. Upsert only rows whose tags changed.
5. **Counts:** `matches`, `updated`, `tip_changes`, `unmatched` (list, first 15 + `+N more`), `skipped_exhibition`, `skipped_worker`, `skipped_changed`, `needs_nba`, `needs_review`, `bad_matches`, `dates_done/dates_planned`, and requests by endpoint.

### 4.3 HL box-score catch-up (`weekly-backfill.js`, US-3)

1. **Candidates (one query):** season = `--season`, `status = 'final'`, `box_score_checks < 2`, tip-off in `[now − DAYS_BACK, now − 8 h]`, no `player_game_stats` row with `source = 'nba_stats'`. US-3.5: games with `checks = 2` are never requested.
2. **Fetch:** group by ET date, oldest first. One `matches(date)` per date (gives the match id and the period count). Then `boxScore` + `lineups` per game. A game counts only if both arrived and `boxReady(box)` holds. "Not ready" (404 / empty) → `not_ready`, no write.
3. **Write (one transaction):** for each ready game, `FOR UPDATE`, then the snapshot check (`box_score_checks`, `box_score_synced_at` unchanged, else `skipped_changed`). Then `resolveSides` + `writeSides`, which are the same SQL as the live worker: `player_game_stats … WHERE source = 'highlightly'` (US-3.3, US-6.2), `team_games` for this game only (US-3.8), `box_score_checks = least(+1, 2)`. Held players are reported, never guessed (US-3.4). After COMMIT, run `recomputePlayerRest` in its own short transaction (same order as the live worker).
4. **Not touched:** `players.listed_position` (D13) and any other `players` column, apart from what `resolvePlayers` already does (crosswalk, `current_team_id`, `is_active` for auto-links).
5. **Counts:** `candidates`, `games_loaded`, `rows`, `not_ready`, `skipped_changed`, `held` (list), `created`, `autolinked`, requests and quota.

### 4.4 CLI `worker/scripts/weekly-hl.js` and the result line

- Usage: `node worker/scripts/weekly-hl.js schedule|backfill --season 2026-27 [--dry-run]` (also `npm --prefix worker run weekly-hl -- …`).
- **DB:** `DATABASE_PUBLIC_URL` only. Process env wins over the repo `.env`. `DATABASE_URL` is never used, so a `.env` `DATABASE_URL` cannot redirect a tunnel run. `.railway.internal` hosts are refused, like `env.mjs:27`. Single `pg.Client`, DATE parser as in `db.js`.
- **Key:** `HIGHLIGHTLY_API_KEY` from env, else repo `.env`. It must not be in argv. Not needed in fixture mode.
- **Self-redaction (D11):** before anything else, wrap `process.stdout.write` / `process.stderr.write` so the key value is replaced by `[redacted]`. Install `uncaughtException` / `unhandledRejection` handlers that print a redacted one-line message and exit 1. Vendor strings (names, abbreviations) are printed with control characters removed and capped at 80 chars, so a crafted value cannot inject a fake `@@WEEKLY` line.
- **`ingestion_runs`:** `job_type` `weekly_hl_schedule` / `weekly_hl_backfill`, `source = 'highlightly'`, `triggered_by` `'schedule'` when `WEEKLY_RUN_ID` is set, else `'manual'`. `details` = `{season, weekly_run_id, window, counts, lists (≤15), requests:{total, byEndpoint}, quota:{limit, remaining}, stop, nba_state, tipoff_authority, dry_run:false}` (US-2.11, US-3.9, US-7.1). Never the key or a URL. **Dry-run writes no row.**
- **Dry-run (US-6.6):** runs fetch + write inside the transaction, then `ROLLBACK`. It prints would-update / insert / skip counts and the request budget. `WEEKLY_DRY_RUN=1` from the runner means the same thing.
- **Full-season sweep (Q11), off by default:** only when `WEEKLY_HL_FULL_SEASON=1` (exactly `1`). After its normal window work, each step reads the **latest live header** and starts the sweep only if `remaining` is known and **> 3000**. Otherwise it logs `full-season sweep refused (remaining R ≤ 3000 | unknown)`, and that is not an error. The schedule sweep covers the remaining ET dates between the season's min and max `game_date_local` in the DB, past dates first. The backfill sweep drops the `DAYS_BACK` lower bound. Cap and reserve still apply. The sweep is idempotent, so a capped sweep continues on a later run. The flag is not in the plist. Docs say it stays unset until the owner confirms the quota period (Q3/Q11 on hold).
- **Summary line (US-8.1):** `[hl schedule] source=highlightly dates=68/68 matches=… updated=… tip_changes=… unmatched=… skipped=… requests=71 quota=7410/7500 stop=none duration=42s`.
- **Result line (D3):** the last stdout line, at most 2 KB:
  `@@WEEKLY {"v":1,"step":"schedule:hl","degraded":false,"nba":"n/a","skipped":[],"stop":null,"hl":{"requests":71,"limit":7500,"remaining":7410},"reason":null}`
  `stop ∈ {null,"cap","reserve","rate_limited"}`. `nba ∈ {"ok","down","disabled","skipped","n/a"}`. `skipped` items come from a fixed allowlist (`nba:arena`, `nba:tv`, `nba:cup`, `nba:season_type`, `nba:new_games`, `nba:positions`, `nba:reconcile`, `nba:standings`). On FAIL, the line is still printed with `reason` (`highlightly auth rejected (401)`, `highlightly unreachable (timeout)`, `database error (lock timeout)`, …) and the exit code is 1.
- **Exit codes:** 0 = done (degraded or not). 1 = Highlightly failure (auth, unreachable, malformed whole response), database error, or bad usage. A cap / reserve / rate-limit stop is exit 0, degraded.

### 4.5 NBA.com best-effort (`sources.mjs` + the three loaders, US-4, US-5)

- `--nba-best-effort` sets the mode in-process. If `WEEKLY_NBA=0`: no request, log `nba.com disabled by config`, result `nba:"disabled"`. If `WEEKLY_NBA_STATE=down` (set by the parent after a failed probe): no request, log `nba.com unreachable earlier in this run, skipped`.
- **First NBA.com request in the process:** 15 s limit to response headers, 60 s to read the body, **one attempt**. Later requests (after a success) get 2 attempts with the same limits. Any failure sets a process-wide latch, and every later call throws `NbaUnavailable` without a request. Message: `stats.nba.com unreachable (timeout|HTTP 403 blocked|HTTP <n>|network)`, with no body, headers or query string (US-5.5). The pacing (`sources.mjs:39-46`) and headers are unchanged (US-5.2).
- All three loaders already fetch before `BEGIN` (`load-schedule.mjs:34-55`, `load-positions.mjs:19-25`, `backfill.mjs:319-320`). In best-effort mode, fetch and shape errors → warning, `ROLLBACK` if a transaction is open, `ingestion_runs.status = 'failed'` with `error = 'nba.com unreachable: <kind>'` (or `nba.com data rejected: <reason>`), `@@WEEKLY` with `degraded:true` and the skipped list, **exit 0**. DB errors → exit 1 with `reason`. Skipped-before-start sub-steps (disabled / down) write **no** `ingestion_runs` row. A skipped job must never become a `success` row, because API freshness is `max(finished_at) WHERE status='success'` (`backend/src/query/engine.js:138`).
- **Positions (US-4.1):** when skipped, log `positions: NBA.com unreachable, skipped (N players still unlisted)`, where N comes from the existing "still unlisted" query (`load-positions.mjs:33-36`).
- **Backfill reconcile (US-3.6, US-3.7, US-6.3):** when reachable, it is unchanged: one transaction per season, and the destructive steps (`backfill.mjs:259-271`) still run only inside that transaction and before the checks. New guard `nbaSeasonComplete()` runs before `BEGIN`: when the DB has final games for the season but NBA.com returned zero team-log rows, the reconcile is skipped with a warning (`nba.com returned no game logs; reconcile skipped`). Skipped reconcile logs `nba reconcile skipped`.
- **Probe order:** `schedule:nba` runs first, so the single probe costs at most 15 s. That meets the target of under 30 s of NBA.com time per blocked run (US-5.1).

### 4.6 Runner (`weekly.mjs`, `lib/weekly.mjs`, US-1, US-8)

- **`SUBSTEPS`:** each entry has `{stage, name, script, args, season, kind: 'nba'|'hl'|'status'}`. `FAIL stage=` keeps using the stage name (`schedule`, `positions`, `backfill`, `status`), so the existing log format holds (US-8.6).
- **Step env:** `stepEnv` first deletes any user-set internal variables (`WEEKLY_RUN_ID`, `WEEKLY_NBA_STATE`, `WEEKLY_HL_BUDGET`, `WEEKLY_HL_LAST_REMAINING`, `WEEKLY_HL_TIPOFF`, `WEEKLY_NBA_BEST_EFFORT`). Then it sets them from run state, along with `DATABASE_PUBLIC_URL` as today. The prod flags are still removed.
- **Skips:** in dry-run, the NBA sub-steps and positions are skipped with a NOTE.
- **Sequence:** the run proceeds as listed in §1. After `schedule:nba`, set `nbaState` from its result line. After each HL step, add `hl.requests` to `used`, record `stop` / `remaining`, and pass the new budget on. With budget 0, HL steps still run but make no request, and they log `request cap reached` / `quota reserve`.
- **Final line (US-1.2, US-8.2):**
  - Clean: `<iso> OK season=S backup=… hl_requests=N quota=R/L duration=Ds`. The prefix is unchanged; new fields go before `duration`.
  - Degraded: `<iso> OK-DEGRADED season=S backup=… hl_requests=N quota=R/L nba=down skipped=nba:arena,tv,cup,season_type,new_games,positions,reconcile,standings stop=cap reason="…" duration=Ds`.
  - FAIL: as today. `reason` comes from the child's `@@WEEKLY` reason when there is one (passed through `oneLine`, ≤200 chars), else `exit N` (US-1.6).
- **Notification (US-1.3):** `Weekly run OK` / `Weekly run OK with warnings — see logs/weekly.log` / `Weekly run FAILED — see logs/weekly.log`.
- **Redaction (D11):** `secrets = [tunnel password, process.env.HIGHLIGHTLY_API_KEY if set]`.
- **Unchanged (US-1.5, US-6.5):** guard, lock, backup reuse/abort, tunnel, port verify, signal handling, cleanup.
- **D12 guards** go in preflight, right after `weeklyGuard`.
- **`db-status.mjs` (US-8.3):** one line from the rows that share the latest `details->>'weekly_run_id'`: `weekly: <run id> source=highlightly[+nba_stats] degraded=yes|no (nba=down; stop=cap) hl_requests=N quota=R/L`. The worker quota line stays.

## 5. Concurrency: worker and weekly job (PA Assumption 5)

What I verified in the code:
- The worker writes `games` status/score (`sync.js:56`), `highlightly` game/player crosswalk rows (`ON CONFLICT DO NOTHING`), new `players`, `player_game_stats` (`… WHERE source='highlightly'`, `sync.js:110-116`), `team_games` totals (`sync.js:124-127`, **no source guard**) and `box_score_*`. Its pool has `statement_timeout 15 s` (`db.js:15`). It touches games in its window (tip −10 min … +8 h), re-checks within 4 days, and runs a daily sweep of yesterday and today after 06:00 ET (`planner.js:31-50`).
- The weekly job runs Mondays 09:07 local (plist). At that time no NBA games are live, so overlap is unlikely, but a manual run can happen at any time.

The plan's guarantees:
1. **No overlap on hot rows:** HL weekly steps skip `live` games and games in the worker window (§4.2), and box-score catch-up starts 8 h after tip-off (D9).
2. **Optimistic check:** every game the weekly job writes is re-read `FOR UPDATE` inside its transaction and compared with the fetch-time snapshot. A changed row is skipped (`skipped_changed`), never overwritten with older data.
3. **Short locks:** no network I/O inside transactions (D2), batched SQL, `lock_timeout 5 s`. The weekly job never holds a lock long enough to trip the worker's 15 s statement timeout in normal operation. On a lock timeout, the weekly step rolls back, retries the write phase once (re-reading snapshots), then FAILs with `database error (lock timeout)`.
4. **Idempotent upserts** on both sides (`ON CONFLICT … WHERE source='highlightly'`, crosswalk `DO NOTHING`). If both write the same game, the same Highlightly values win.

Residual risks (accepted, not fixed in M6, because a fix needs live worker changes):
- **R-C1:** if the worker and the weekly job resolve the *same brand-new* player in the same second, two `players` rows could be created (`players.js:86-90` is not atomic with the crosswalk insert). This needs a box score inside the 8 h-plus window that both handle at once. The probability is very low, and `db:review` would show it.
- **R-C2 (existing before M6):** the NBA.com reconcile transaction (`backfill.mjs`) is season-wide and can hold locks for minutes. A worker write to the same rows waits, hits 15 s, and retries on the next tick. A worker `team_games` update right after the reconcile commits could overwrite NBA totals for one just-final game. This only happens when NBA.com is reachable, as before M6. Logged for a future worker change (an advisory lock in `loadBoxScore`).

## 6. Duplicate-game risk (PA Risk 1)

- Highlightly never inserts into `games` (Q1, D14). Unmatched matches are only reported. Test: `games` count and the `nba_stats` game crosswalk are unchanged after HL steps.
- When an ambiguous match finds several games, the match is reported and nothing is linked (`findGame` returns `several games match`).
- A wrong link through a reused Highlightly match id is blocked by the team-pair check on crosswalk hits (§4.2) and the 7-day shift limit (D10).
- The NBA.com loaders still key on the NBA id. A Highlightly tip-off update moves an existing row and never creates one, so a later NBA.com load updates the same row. There is no path that creates a second row.
- Cup knockout games stay NBA.com-only (Q1). Until NBA.com is reachable, they appear in `unmatched` from December on, which shows the gap.

## 7. Test plan (fixtures only, Q5: no live recording)

Fixture rules (US-9.2): recorded files are **copies** of `worker/test/fixtures/{matches_2026-04-12,matches_2026-10-06,box-score_1439038,lineups_1439038}.json`. Everything else is named `synthetic_*` and listed in `worker/test/fixtures/weekly/README.md`. Synthetic files are built only by editing recorded shapes (same field names), never invented formats. NBA.com synthetic cases (unreachable / malformed / zero rows) live under `scripts/fixtures/nba/` with the same labelling.

### 7.1 Worker suite (`worker/`, `node:test`, CI job `worker` with Postgres; DB tests need `WORKER_TEST_DATABASE_URL`)

| File | Cases (fixture) | AC |
|---|---|---|
| `hl-weekly-client.test.js` (no DB) | per-endpoint counts; header present / absent / garbage → `quota unknown`; cap stop before the request (cap 3, 5 dates); reserve stop (`_quota.json` remaining 1003, reserve 1000 → 2 requests then `reserve`); pacing (fake clock, 4 rps); 429 with `Retry-After: 2` then OK; 429 ×4 → `rate_limited`; HTTP-date `Retry-After` capped; 401 and 403 → auth error, 1 request; 500 ×3 → unavailable after 3 requests; timeout (stub never resolves, fake timer) → unavailable; non-JSON body and >5 MB body → malformed; 404 → null; paginated day (`synthetic_matches_2026-11-05` 100 + `@100` 12 = 112); RapidAPI host routing; **the key never appears** in any error message or log call (fake key `test-key-DO-NOT-LOG-…`); fixture mode never calls `globalThis.fetch` (stub throws). | US-7.1-7.6, US-9.3, US-8.4 |
| `weekly-schedule.test.js` | normal day (copy of 04-12, game seeded) → status, scores, `highlightly` crosswalk row; shifted tip-off (synthetic) → `tipoff_utc` updated, log line has old and new; `final` and `live` rows untouched (status, scores); postponed (synthetic `"Postponed"`); unknown team / exhibition (copy of 10-06 with a non-NBA side, synthetic) → skipped, not an error; unmatched → listed, **no insert into `games`**, `nba_stats` crosswalk count unchanged; game with non-default `arena_id`, `is_neutral_site`, `national_tv_tier`, `national_broadcasters`, `cup_stage`, `season_type`, `playoff_series_id` → byte-identical after the run; **late west-coast tip**: LAL home game stored `game_date_local 2026-10-21`, tip `2026-10-22T03:30Z`, Highlightly shifts to `04:00Z` → local date stays `2026-10-21`; tip moved a day → `game_date_local` and both teams' `rest_days` / `b2b_night` recomputed, nothing else touched; tip unchanged → no `team_games` write; neutral-site shift → `needs_nba`, not applied; shift over 7 days → `needs_review`; crosswalk team mismatch → unmatched; worker-window game skipped; snapshot changed between fetch and write (test hook) → `skipped_changed`; second run → 0 changes and same `updated_at`; one malformed match → others processed; whole response malformed → FAIL, DB unchanged; tip-off authority off (`WEEKLY_HL_TIPOFF=0`) → tip-offs untouched, and two runs in a row give the same result; nearest-first order under cap 3 → today, −1, +1 fetched; dry-run → DB unchanged, counts printed. | US-2.1-2.11, US-5.3, US-6.1, US-6.2, US-6.4, US-6.6, US-7.4, D14 |
| `weekly-backfill.test.js` | final game `checks=0` (MEM @ HOU 1439038, copies) → rows written, `source='highlightly'`; **Jae'Sean Tate 26 min, +11; Taj Gibson 19 min, −7** (`box-score_1439038.json`; QA adds one more); `checks=1` → loaded, `checks=2` after; `checks=2` → **0 box-score requests**; a seeded `nba_stats` row → whole game untouched (row byte-identical); held player (near-match, same seed as `sync.test.js`) → listed, not written; box not ready (404 synthetic) → `not_ready`, no write; cap reached after box and before lineups → that game not written, earlier games complete, `stop=cap`; reserve hit → same; `team_games` of other games unchanged; `players.listed_position` unchanged for Okogie / Green (lineup slot labels, D13 / US-4.4); idempotent re-run; dry-run. | US-3.1-3.5, US-3.8, US-4.4, US-6.2, US-6.4, US-7.2, US-7.3 |
| `weekly-hl-cli.test.js` | spawns the CLI with `HIGHLIGHTLY_FIXTURES`, a fake key in env, and the test DB as `DATABASE_PUBLIC_URL`: result line valid JSON with expected fields; `ingestion_runs` row has `source='highlightly'`, counts, requests, quota and **no key**; stdout and stderr contain no key even when a synthetic error message embeds it; `.env` `DATABASE_URL` ignored; dry-run writes no `ingestion_runs` row; `WEEKLY_HL_FULL_SEASON=1` with remaining 2500 → sweep refused, with 3500 → sweep runs (dates beyond the window fetched); auth error → exit 1, `reason` names it. | US-1.4, US-1.6, US-2.11, US-3.9, US-6.6, US-8.1, US-8.4, US-8.5, Q11 |
| `sync.test.js` (existing, **unchanged**) | Must still pass after the T2 refactor. | live worker unchanged |

### 7.2 Root suite (`npm test`, no DB, CI job `root`)

| File | Cases | AC |
|---|---|---|
| `sources.test.mjs` | existing cases still pass (manual mode: 3 attempts); best-effort: first call times out at the injected limit with **1 fetch**, the next 3 calls make **0 fetches**; 403 → kind `HTTP 403 blocked`; message contains host, no body, no query; `WEEKLY_NBA=0` → 0 fetches; `WEEKLY_NBA_STATE=down` → 0 fetches; fixture-mode synthetic unreachable / malformed. | US-5.1, US-5.4, US-5.5 |
| `nba-best-effort.test.mjs` | classification (network / HTTP / parse / shape / `checks failed` → warning; pg error → fail); result-line builder; `nbaSeasonComplete` (zero team rows + DB finals → false). | US-5.6, US-3.7, US-6.3 |
| `weekly.test.mjs` | `SUBSTEPS` order and argv (`--nba-best-effort`, `--season`); `stepEnv` strips user-set internal vars and keeps removing the prod flags; result-line parser (valid, wrong `step`, bad enum, oversized, non-JSON, unknown `skipped` item → ignored); aggregator: clean → `OK`, NBA down → `OK-DEGRADED` with the full skipped list, cap → `stop=cap`, HL fail → `FAIL stage=schedule reason="highlightly …"`; budget hand-off (cap 600, 71 used → 529); notification texts; config ranges (cap 601 rejected, reserve 999 rejected); D12 guards (prod + fixtures → refused; fake without `HIGHLIGHTLY_FIXTURES` → refused); redactor masks the env key. | US-1.2, US-1.3, US-1.6, US-5.4, US-7.2, US-8.2, US-8.4, US-8.6 |
| `positions.test.mjs` (existing) | unchanged and green. | US-4.2 |

### 7.3 Weekly drill (local only: Docker, hdiutil, fake railway; `npm run db:weekly:drill`)

New seed `db/tests/weekly_drill_seed.sql`: 4 teams with `nba_stats` + `highlightly` crosswalk rows, games matching the copied fixtures, and one `highlightly` box-score game. The new cases run the **real** sub-step scripts (not the fake step) with `HIGHLIGHTLY_FIXTURES`, and `SEED_FIXTURES` or `WEEKLY_NBA=0`:

| Case | Expect | AC |
|---|---|---|
| W26 NBA.com down (synthetic unreachable) + HL fixtures | exit 0; `OK-DEGRADED … nba=down skipped=…`; NBA.com time < 30 s; tunnel / forwarder dead, port free, lock released | US-1.1, US-1.2, US-5.1 |
| W27 HL down (synthetic 500 / timeout) | exit ≠ 0; `FAIL stage=schedule reason="highlightly unreachable …"`; cleanup checks pass; DB unchanged | US-1.4, US-1.6 |
| W28 reserve hit (`_quota.json` remaining 1002) | exit 0; `OK-DEGRADED … stop=reserve`; no partial games | US-7.3, Q3 |
| W29 cap hit (`WEEKLY_HL_CAP=3`) | exit 0; `stop=cap`; nearest dates done | US-7.2, US-7.4 |
| W30 key redaction | `HIGHLIGHTLY_API_KEY=<random>` in env; fake step / synthetic error prints it; absent from `weekly.log` and outputs | US-8.4 |
| W31 NBA.com zero-row game logs (synthetic) | `highlightly` rows not deleted; `nba reconcile skipped` | US-6.3 |
| W32 fixture guard | prod-looking run with `HIGHLIGHTLY_FIXTURES` → preflight FAIL; fake run without it → preflight FAIL | D12, US-9.6 |
| W1-W25 (existing) | all still pass (M5 behaviour unchanged) | US-1.5, US-6.5 |

### 7.4 Gates

`npm test` (root), `npm test` (worker, with `WORKER_TEST_DATABASE_URL`), frontend and backend suites unchanged and green. CI green on the PR (rule 7). Drill result pasted into the PR (local-only, as in M5). No test or script calls a real host (Sec checks: `grep` for `highlightly.net`, `rapidapi.com`, `nba.com` outside `sources.mjs`, `highlightly.js` and the client's `hostFor`).

## 8. Ordered Dev tasks

One PR from `feat/m6-highlightly-weekly`, one commit per task (STANDARDS §3-4). T6 does not depend on T1-T5 and can be done in any order.

| Task | Scope | Done when | AC |
|---|---|---|---|
| **T1** Guarded client | `hl-weekly-client.js`, `hl-fixture-fetch.js`, `hostFor` export, `fixtures/weekly/` + README, `hl-weekly-client.test.js` | All §7.1 client cases pass; no network in tests; key never in messages | US-7.1, 7.3, 7.5, 7.6, US-9.1-9.3 |
| **T2** Box-score refactor | split `loadBoxScore` (`boxReady` / `resolveSides` / `writeSides`), export `teamMap` / `findGame` | `sync.test.js` passes **unmodified**; diff shows no SQL change | US-3.3 (shared guard) |
| **T3** HL schedule pass | `team-tz.js`, `weekly-schedule.js`, tests | §7.1 schedule cases pass | US-2.1-2.10, US-5.3, US-6.1, 6.2, 6.4, US-7.4, D14 |
| **T4** HL box-score catch-up | `weekly-backfill.js`, tests | §7.1 backfill cases pass | US-3.1-3.5, 3.8, US-4.4, US-6.2, 6.4 |
| **T5** HL CLI | `worker/scripts/weekly-hl.js`, `package.json` script, CLI tests, Q11 sweep | §7.1 CLI cases pass; manual `--dry-run` against a local test DB with fixtures prints counts | US-1.4, 1.6, 2.11, 3.9, US-6.6, US-7.2, US-8.1, 8.4, 8.5, Q11 |
| **T6** NBA.com best-effort | `sources.mjs`, `nba-best-effort.mjs`, three loaders, root tests, NBA synthetic fixtures | §7.2 sources / best-effort cases pass; manual-mode tests unchanged | US-3.6, 3.7, US-4.1, 4.2, 4.5, US-5.1, 5.2, 5.4-5.6, US-6.3 |
| **T7** Runner | `lib/weekly.mjs`, `weekly.mjs`, `weekly.sh`, `weekly.test.mjs` | §7.2 weekly cases pass; M5 tests unchanged except the step-table assertions | US-1.1-1.6, US-5.4, US-7.2, US-8.2, 8.4, 8.6, D12 |
| **T8** Status | `db-status.mjs` weekly line | Run against the drill DB shows the line; worker quota line still present | US-8.3 |
| **T9** Drill | seed SQL, W26-W32, `wres()` regex | Drill all PASS locally (W1-W32) | US-1.1, 1.4, 1.5, US-6.3, 6.5, US-9.5, 9.6 |
| **T10** Docs | `architecture.md` (§3.1 correction, §7.9 new, §9.2 / §9.3), README command and env tables, `ops/launchd/README.md` | Docs list every flag in §10, the estimates (80 typical / 385 worst / 505 first sweep), and "check the Highlightly dashboard for the quota period before enabling `WEEKLY_HL_FULL_SEASON`" | US-7.7, STANDARDS §5 |

## 9. Reviews and flags

**QA:** required. **Security: required** (STATUS: new external source in the weekly path, API key handling, untrusted input parsing, config). Items for Sec:
- **S1** Key redaction design (D11). The parent does not read `.env`, so a key that lives only in `.env` is protected by child self-redaction plus "never in messages". The alternative is a narrow single-key reader in the parent (redaction only, never put in env), which would relax the M5 rule. The plan picks child self-redaction. Sec to confirm or require the alternative.
- **S2** Result-line trust: parser validation, vendor-string sanitising, allowlisted `skipped` values.
- **S3** Response parsing: size bound, JSON in try, type checks, no URL or path built from response fields except numeric match ids (validated as positive integers before they are used in `/box-score/{id}`).
- **S4** D12 fixture guards and the internal-env stripping.
- **S5** No real hosts in tests or drill.

**Owner flags.** No significant product or architecture change is needed. There is no schema change, no new dependency, and no change to the approved scope. For the owner to know before merge (Gate 2), with no approval needed now:
- **O1 Merging this PR redeploys the ingestion worker.** T1-T5 add files under `worker/` and refactor `worker/src/sync.js` (behaviour unchanged, guarded by existing tests). Railway's `ingestion-worker` service builds from `rootDirectory /worker` on `main` (architecture §8), so a merge will redeploy it. I could not determine whether Railway watch paths are configured. The Coordinator's readiness report should say this explicitly. Fallback if the owner wants no worker redeploy: put the HL code in `scripts/` as copies with agreement tests (STANDARDS §1 pattern). This costs about one extra day and leaves two copies of the box-score write path.
- **O2 Tip-off authority can alternate** if NBA.com is reachable some weeks and not others while the two sources disagree. Each run's result is consistent with Q9.
- **O3 `.env.example`** is not read or edited by agents (constraint). New flags have defaults and need no `.env` entry. The owner or Coordinator decides whether to add the names; docs list them.
- **O4 Q11 sweep** is built but off. Enabling it is an owner action after the quota period is confirmed (Q3).

## 10. Environment flags

| Variable | Default | Range / values | Who sets it |
|---|---|---|---|
| `WEEKLY_NBA` | `1` | `0` = no NBA.com attempts this run (`nba.com disabled by config`) | owner |
| `WEEKLY_HL_CAP` | `600` | 1..600 | owner / tests |
| `WEEKLY_HL_RESERVE` | `1000` | 1000..100000 | owner |
| `WEEKLY_HL_RPS` | `4` | 1..10 | owner |
| `WEEKLY_HL_DAYS_BACK` / `WEEKLY_HL_DAYS_AHEAD` | `7` / `60` | 1..30 / 0..120 | owner |
| `WEEKLY_HL_FULL_SEASON` | unset | exactly `1` = opt in to the Q11 sweep (still needs remaining > 3000 from the live header) | owner, only after Q3 |
| `WEEKLY_DRY_RUN` | unset | `1` = HL steps roll back; NBA steps and positions skipped | owner / QA |
| `HIGHLIGHTLY_FIXTURES`, `SEED_FIXTURES` | unset | fixture dirs; **refused on a production run**, `HIGHLIGHTLY_FIXTURES` **required** on a fake run | tests / drill |
| `HIGHLIGHTLY_API_KEY` | from env or repo `.env` | read only by the HL child | existing |
| Internal: `WEEKLY_RUN_ID`, `WEEKLY_NBA_STATE`, `WEEKLY_HL_BUDGET`, `WEEKLY_HL_LAST_REMAINING`, `WEEKLY_HL_TIPOFF`, `WEEKLY_NBA_BEST_EFFORT` | set by `weekly.mjs` | user-set values are stripped | runner only |

Existing M5 flags are unchanged.

## 11. Risks

1. **No recorded error shapes (Q5 declined).** The 401/429/5xx handling is built from status codes and headers only, not bodies, so unknown body shapes do not matter. The residual risk is the `Retry-After` format, which is handled both ways.
2. **Quota period unknown (Q3).** The cap and reserve are sized for a monthly quota. Remaining is checked on every response, so a shared key that the worker also drains is still respected.
3. **Highlightly far-future coverage (Assumption 1).** Empty future dates cost one request each and change nothing.
4. **Stale NBA-only tags** (arena, TV, Cup) while NBA.com stays blocked. Every run shows `OK-DEGRADED` with the skipped list. Cup knockout games show as `unmatched` from December.
5. **Concurrency residuals R-C1 and R-C2** (§5).
6. **Worker redeploy on merge (O1).** It is covered by unchanged `sync.test.js`, and the live loop does not import the new modules.
7. **Time-zone map drift** if a team relocates. It is a static 30-entry map with a unit test that checks it covers every team in `db/tests` seeds. Neutral sites are excluded by design.
8. **Could not determine:** Railway watch-path settings; Highlightly per-second limit; `Retry-After` presence; the real per-week request mix (needs an owner-approved read-only `ingestion_runs` query).

## Handoff

- **Done:** wrote the M6 technical plan: Highlightly-first weekly flow with NBA.com as a single 15 s probe, a guarded client (cap 600, reserve 1,000 from live headers, 4 req/s, 429/401/5xx rules), fetch-then-write steps with one short transaction, update-only schedule (no game creation), box-score catch-up reusing the worker's write path, `OK` / `OK-DEGRADED` / `FAIL` result and notification, Q11 sweep behind an off-by-default opt-in with a live >3,000 check, fixture-only tests with synthetic files labelled, and drill cases W26-W32. Resolved PA Assumption 5 (concurrency, §5) and the duplicate-game risk (§6).
- **Files:** created `docs/plans/M6-highlightly-weekly.md`. No source, `.env` or `.env.example` touched; no live calls.
- **Open questions:** none blocking. Owner awareness at Gate 2: O1 (merge redeploys the ingestion worker), O2, O3, O4. Security to rule on S1 (child self-redaction vs a narrow `.env` key reader in the parent).
- **Recommended next role:** Developer (T1 → T10 on `feat/m6-highlightly-weekly`), then QA + Security in parallel, then Lead review.
