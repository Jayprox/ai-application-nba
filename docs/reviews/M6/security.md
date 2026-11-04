# M6 Security Review: Highlightly-first weekly job (PR #7)

Reviewer: Security Reviewer (Sec), independent. I wrote none of the code under review.

## 1. Scope and tools

- **Branch / commit:** `feat/m6-highlightly-weekly` at `b3278b83f843f38bf0a9fb045d33bc493be83fec` (13 commits over `main`, `git diff main...HEAD`, 52 files).
- **Inputs read:** `CLAUDE.md`, `docs/requirements/M6-highlightly-weekly.md` (NFR Security, US-7, US-8.4, US-9), `docs/plans/M6-highlightly-weekly.md` (D11, D12, §4, §9 S1-S4), the M6 Approvals table in `docs/STATUS.md`.
- **Code reviewed:** `worker/scripts/weekly-hl.js`, `worker/src/{hl-weekly-client,hl-fixture-fetch,weekly-schedule,weekly-backfill,weekly-util,team-tz,highlightly,sync,map}.js`, `scripts/weekly.mjs`, `scripts/lib/{weekly,sources,nba-best-effort,env}.mjs`, `scripts/{load-schedule,load-positions,backfill,db-status}.mjs`, `scripts/weekly-drill.sh`, `scripts/fixtures/make-weekly-drill-fixtures.mjs`, the new tests and test helpers, the committed fixtures, `ops/launchd/*`, README changes.
- **Constraints kept:** no live Highlightly, NBA.com, Railway or production calls. `.env` and `.env.example` were not read. No source edits, commits or pushes.
- **Tools run:**
  - `gitleaks`, `semgrep`, `trufflehog`, `trivy`, `osv-scanner`: **not installed.** I did a manual regex sweep instead (see §3).
  - `npm audit --omit=dev` (worker and root): **0 vulnerabilities** for each.
  - Root suite (`node --test 'scripts/lib/*.test.mjs'`) under a preload that blocks every non-loopback socket and logs every `fetch` attempt: **110/110 pass, 0 network attempts.**
  - Worker suite under the same preload, with no `WORKER_TEST_DATABASE_URL`: **40 pass, 51 skipped (need a DB), 0 network attempts.**
  - Local experiments in the session scratchpad, with no network and no real DB:
    - (a) `weekly-hl.js` with a **fake** key in a throwaway env file and a preload that tries to print it.
    - (b) `parseResultLine`, `clean`, `weeklyLine`, `finalLine` and `loadWeeklyConfig` with hostile inputs.
    - (c) the guarded client with a stub whose body never finishes.
- **Not run:** the fake-weekly drill (needs a local Postgres; QA owns it). I reviewed it statically.

## 2. Findings

Overall: no Blocker or Major findings. Three Minor findings (1-3) and six Notes (4-9).

### Finding 1: Minor. The child's key mask works per `write()` call, so a key split across two writes is not masked
- **Location:** `worker/scripts/weekly-hl.js:37-41`
- **Status:** Confirmed by experiment (a), high confidence.
- **What happens:** `mask()` runs on each chunk separately. When I wrote the fake key in two pieces (`process.stderr.write(k.slice(0,10)); process.stderr.write(k.slice(10)+…)`), the full key appeared in stderr unmasked.
  - Every other case **was** masked: a whole-string `console.log`, a `Buffer` write, `console.log({nested: key})`, an `Error` whose message held the key, and an uncaught exception (which prints only the error name).
- **Why it matters for S1:** the launchd plist sets only `WEEKLY_CONFIRM_PROD` and `BACKUP_CONFIRM_PROD`. In the scheduled production run, `HIGHLIGHTLY_API_KEY` exists only in `.env`. So the parent's line-buffered redactor (`scripts/weekly.mjs:272`) never learns the key, and the child's mask is the **only** layer.
- **Impact:** latent. No current code path writes the key at all, let alone split across writes. If a later change (a library writing in pieces, a progress writer, a long `util.inspect`) printed it across a chunk boundary, the key would land in `logs/weekly.log`.
- **Recommended fix:**
  - Make the child's mask chunk-safe: either line-buffer as `lineRedactor` does (flush in `die()` and before `exit`), or keep a carry-over tail of `KEY.length - 1` characters between writes.
  - Add a test where the key comes **only** from the env file (`WEEKLY_HL_ENV_FILE`), not the environment, so the child layer is tested alone. The drill's W30 and the CLI tests always put the key in the environment, where the parent's redactor also covers it.

### Finding 2: Minor. The Highlightly response body is read with no timeout and no size limit while reading
- **Location:** `worker/src/hl-weekly-client.js:72-85` (the timer is cleared in `finally` once headers arrive) and `:118-121` (`res.text()` reads the whole body, then checks `> MAX_BODY`).
- **Status:** Timeout gap confirmed by experiment (c), high confidence. With `timeoutMs=50`, a body that never finishes was still hanging after 1.5 s. The unbounded read is confirmed by inspection.
- **Impact:** a stalled or very large Highlightly response (vendor fault, or a compromised vendor) holds the HL child until the runner's step timeout (default 3,600 s). During that time the production tunnel and the run lock stay held, and a huge body can exhaust memory. This contradicts plan §4.1 ("timeout (20 s)", "refuse anything over 5 MB"). There is no data-integrity impact, because writes happen only after a successful fetch.
- **Recommended fix:**
  - Keep the abort timer (or a separate body timer, as `sources.mjs` `getBestEffort` already does) running through the body read.
  - Read `res.body` as a stream with a running byte count, and abort above 5 MB.
  - Add a stub test for a stalled body (the existing timeout test covers only headers that never arrive).

### Finding 3: Minor. Schedule scores are not validated, so one bad vendor value fails the whole schedule stage
- **Location:** `worker/src/weekly-schedule.js:145-149` with `worker/src/map.js:16-19` (`totalScore` = sum of `Number(p) || 0`). Score columns are `SMALLINT` (`db/schema.sql:136-137`).
- **Status:** Confirmed by inspection, high confidence. I did not run it against a DB.
- **What happens:**
  - A period value such as `"1e400"` (which becomes `Infinity`) or a total above 32,767 reaches `UPDATE games …` inside the single schedule transaction. Postgres rejects it (22003 / 22P02), `inTransaction` rolls back, the child exits 1, and the weekly run ends `FAIL stage=schedule`.
  - Non-numeric period values are silently counted as 0.
  - Negative values are accepted.
- **Impact:** one malformed field from the vendor stops every schedule update for the week (an availability problem). It also contradicts the plan's "one malformed match → others processed" (§7.1). There is no integrity damage, because the transaction rolls back.
- **Recommended fix:** in `badMatch`, require each period score to be an integer from 0 to a sane maximum (for example 0-200 per period, 0-400 per total). Otherwise count the match as `bad_matches` and continue.

### Finding 4: Note. Sanitisers keep Unicode format characters (bidi, zero-width)
- **Location:**
  - `worker/src/weekly-util.js:5` (`clean` strips `\p{Cc}\p{Zl}\p{Zp}`)
  - `scripts/lib/weekly.mjs` `parseResultLine` reason filter
  - `scripts/lib/nba-best-effort.mjs:14` `ONE_LINE`
- **Status:** Confirmed by experiment (b).
- **What happens:**
  - U+202E (right-to-left override) and U+200B (zero-width space) survive into log lines and `reason`.
  - NBA.com-derived text, such as the game id inside `game X: unknown team id` or `checks failed …` messages, can also appear inside `reason="…"` in the final log line, including a look-alike `FAIL stage=` substring.
- **What is already safe:** newlines, C1 controls and U+2028/9 are stripped, and quotes become `'`, so no new log line can be forged.
- **Impact:** only how the log looks to a human reader (visual spoofing). Low.
- **Recommended fix (optional):** also strip `\p{Cf}`.

### Finding 5: Note (suspicion, low confidence of practical impact). NBA.com strings printed raw by the loaders could contain a fake `@@WEEKLY` line
- **Location:** `scripts/weekly.mjs` `runNode` keeps the **last** stdout line starting with `@@WEEKLY `. `scripts/load-schedule.mjs` logs vendor strings without sanitising them (for example `neutral` with `arenaCity`, `exhibitions`), a pattern that predates M6.
- **What would have to happen:** a newline inside an NBA.com field would start a new stdout line.
- **Why the impact is small:**
  - Every exit-0 path prints the step's real `weeklyLine` last, so a fake line is overridden.
  - A fake line matters only when the step crashes before printing, and then it changes only the FAIL reason text.
  - `parseResultLine` validates the step name, the enums, the `skipped` allowlist and the sizes.
  - This needs NBA.com itself to serve hostile data.
- **Recommended fix (optional):** run vendor strings through a `clean`-style helper in the NBA loaders' log lines. Or have the runner accept a result line only from a step that printed exactly one.

### Finding 6: Note. Outside the runner, fixture switches are not guarded
- **Location:** `worker/scripts/weekly-hl.js:29-33`, and the existing loaders through `sources.mjs`.
- **What happens:** D12 (`fixtureGuardError`) protects the runner correctly. I confirmed this in code and in drill case W32. But a manual `HIGHLIGHTLY_FIXTURES=… npm --prefix worker run weekly-hl -- schedule` with no `DATABASE_PUBLIC_URL` in the shell falls back to the `.env` value (the production DB) and writes data built from fixtures. The same pattern already exists in `worker/scripts/sync.js` and in `SEED_FIXTURES` for the loaders.
- **Impact:** an operator mistake only. No outside attacker can trigger it.
- **Recommended fix:** in `weekly-hl.js`, refuse `HIGHLIGHTLY_FIXTURES` when the DB URL came from the env file rather than the process environment.

### Finding 7: Note. The `WEEKLY_HL_ENV_FILE` test hook is honoured in production and not stripped
- **Location:** `worker/scripts/weekly-hl.js:16`; `scripts/lib/weekly.mjs` `INTERNAL_ENV` does not include it.
- **What happens:** the variable lets the child read a different env file. Only the two names `DATABASE_PUBLIC_URL` and `HIGHLIGHTLY_API_KEY` are taken from it, and nothing is printed.
- **Impact:** low. Anyone who can set this can already change the launchd job's environment.
- **Recommended fix:** document it as test-only, or honour it only when `HIGHLIGHTLY_FIXTURES` is set or the DB host is local.

### Finding 8: Note. On manual runs, the full-season sweep check can be met by `WEEKLY_HL_LAST_REMAINING` when no rate-limit header arrives
- **Location:** `worker/scripts/weekly-hl.js:78`, `hl-weekly-client.js:42`, `weekly-schedule.js:91-95`, `weekly-backfill.js:79-83`.
- **What happens:** if every response lacks the header, `stats.remaining` stays at the value seeded from the environment, so the sweep could start without a live reading. The runner strips this variable and sets it only from a real header seen earlier in the same run, so scheduled runs are fine. The 600-request cap still applies.
- **Recommended fix (optional):** base the sweep decision only on a header seen by this process. Record a `seenLive` flag in `afterResponse`.

### Finding 9: Note. TLS certificates are not verified for a non-local DB on manual runs
- **Location:** `worker/scripts/weekly-hl.js:95` (`ssl: { rejectUnauthorized: false }`). This copies the existing pattern in `scripts/lib/env.mjs:32`.
- **What happens:** the scheduled run connects through the 127.0.0.1 Railway CLI tunnel, so `ssl` is off there and the CLI provides the transport. A manual run against the public `*.proxy.rlwy.net` host uses TLS without verifying the certificate, which allows an attacker on the network path to intercept credentials.
- **Status:** an existing repo-wide pattern, not introduced by this PR.
- **Recommended fix:** track it as a separate hardening item.

### Verified as correct (focus areas)
- **S1, key redaction design.** **Ruling: keep child self-redaction. A key reader in the parent is not required.**
  - The key is read into a variable, never exported to the environment, never put in argv, and never inherited by the NBA children. Only `weekly-hl.js` uses it; `seed.mjs` uses it too but is not on the weekly path.
  - Error classes carry fixed text only. `ingestion_runs.details` is masked again before writing (`:148`). The `error` column gets fixed reasons only.
  - Experiment (a) showed masking holds for every realistic write path.
  - A key reader in the parent would weaken the M5 rule for no real gain once Finding 1 is fixed. **Condition: Finding 1 must be fixed, because the child's mask is the only layer in production.**
- **S2, result line.** Experiment (b) confirmed that `parseResultLine` rejects:
  - a wrong `step`, unknown `stop` or `nba` values, and negative, fractional or oversized counts;
  - lines over 2,048 characters, and lines that do not start exactly with `@@WEEKLY `.
  It also drops `skipped` items not on the allowlist, ignores `__proto__` (no prototype pollution), and makes `reason` a single line with quotes neutralised. Notification text comes from the fixed `NOTIFY_TEXT`, so no vendor text reaches `osascript`. Vendor names in the HL child are cleaned and capped at 80 characters, and log lines at 300.
- **S3, parsing.** In the HL client:
  - JSON is parsed inside a `try`, and `matches` requires `data` to be an array.
  - Pagination stops after 10 pages.
  - Match ids must be positive integers before they are used in `/box-score/{id}` or `/lineups/{id}`. No other URL or path is built from response fields.
  - Rate-limit headers must be integers of at most 7 digits. `Retry-After` waits are capped at 30 s each and 60 s in total.
  In the backfill, shape errors are caught per game (savepoint rollback). Gaps: Findings 2 and 3.
- **S4, guards.**
  - A production run refuses `HIGHLIGHTLY_FIXTURES`, `SEED_FIXTURES` and `WEEKLY_STEP_FIXTURE`. A fake run requires `HIGHLIGHTLY_FIXTURES` plus either `SEED_FIXTURES` or `WEEKLY_NBA=0` (`scripts/lib/weekly.mjs` `fixtureGuardError`, called in preflight; drill W32).
  - `stepEnv` drops every runner-only variable (`WEEKLY_RUN_ID`, `WEEKLY_NBA_STATE`, `WEEKLY_HL_BUDGET`, `WEEKLY_HL_LAST_REMAINING`, `WEEKLY_HL_TIPOFF`) and both production flags, then adds the runner's own values.
  - The child validates `WEEKLY_RUN_ID` (`^[A-Za-z0-9:_-]{1,64}$`) and `WEEKLY_NBA_STATE` (enum).
- **S5, no real hosts.**
  - Both suites ran with zero non-loopback network attempts under the blocking preload.
  - Fixture mode never uses `globalThis.fetch`: `fixtureFetch` maps requests to files, and a test stubs `fetch` to throw.
  - In best-effort mode with fixtures, a missing NBA fixture is treated as unreachable instead of making a request. `nbaScheduleSeason`, `nbaGameLog`, `nbaRoster` and `geocode` read fixtures only.
  - CLI tests run with a minimal environment, a temporary env file, and only a localhost DB whose name contains "test" (`worker/test/helpers/db.js:8`).
  - The drill runs the real sub-steps only with fixture directories or `WEEKLY_NBA=0`, and the guard enforces that.
- **SQL.** Every query built from external data is parameterised. The only dynamic identifiers come from code constants (`STAT_COLS`, `teamTotals` keys, `COLS`). Arrays go in through `unnest($n::type[])` or `ANY($n)`. `sync.js` was refactored with no SQL change.
- **Quota guard cannot be loosened through environment variables.**
  - Runner: cap 1-600, reserve 1,000-100,000. Experiment (b) showed `601`, `999`, `0x10` and `1e9` are all rejected.
  - Child: the same ranges, plus budget 0-600.
  - The sweep threshold of 3,000 is hard-coded.
  - The per-run budget is carried forward by the runner, and a user-set `WEEKLY_HL_BUDGET` is stripped.
- **Error messages.** The HL child never echoes raw pg or vendor messages (SQLSTATE code only). It prints only the DB host, never the URL or password.

## 3. Secrets and dependency review
- **Secrets:** I searched `git log -p main..HEAD` for API-key, token, password and bearer assignments, long hex strings, RapidAPI-style `msh…` keys, `postgres://user:pass@`, AWS keys and PEM headers.
  - The only matches were commit SHAs and obvious test placeholders (`test-key-DO-NOT-LOG-…`, `postgres://u:p@127.0.0.1…`, `nobody@127.0.0.1:1/nope`).
  - No `.env*` file was added or changed.
  - The committed Highlightly fixtures contain no auth headers or key-like fields.
  - The drill generates its fake key at run time (`openssl rand`), and it is never committed.
  - The launchd plists are unchanged and hold only the two confirm flags.
  - `.gitignore` now also excludes `.claude/settings.local.json`.
- **Dependencies:** no new or changed dependencies. The only `worker/package.json` change is a new `weekly-hl` script entry, and no lockfile changed. `pg ^8.13.0` is unchanged (a caret range already present on `main`, with the lockfile in place). `npm audit --omit=dev` found 0 vulnerabilities in worker and in root.

## 4. Verdict

`VERDICT: READY WITH CONDITIONS`

**Rationale:** the design meets the M6 security requirements:
- the key is never in argv or in logs on any normal path;
- vendor strings are sanitised, and the result line is validated against an allowlist;
- SQL is parameterised;
- quota limits can only be tightened;
- fixtures cannot reach production through the runner;
- no test or drill reaches a real host;
- there are no secrets in the diff and no dependency changes.

None of the findings allows key disclosure, injection, or data corruption today.

**Conditions:**
1. **C1 (Finding 1, before merge recommended):** make the child's key mask chunk-safe, and add a test where the key comes only from the env file. In the scheduled production run this mask is the only redaction layer. The fix is small.
2. **C2 (Finding 2, before merge or as a tracked follow-up the owner accepts):** keep the timeout running while the body is read, and enforce the 5 MB limit during the read.
3. **C3 (Finding 3, before merge or as a tracked follow-up):** validate score values in `badMatch`, so one bad vendor value cannot fail the weekly run.

Findings 4-9 are optional hardening items.

---

## Handoff
- **Done:**
  - Static security review of PR #7 at `b3278b8` (S1-S5, SQL, quota guard, secrets, dependencies).
  - `npm audit` on worker and root: 0 vulnerabilities each.
  - Root and worker suites run under a network-blocking preload: 0 network attempts.
  - Local experiments with a fake key and stubs confirmed Finding 1 and Finding 2.
  - S1 ruling: keep child self-redaction, conditional on Finding 1.
- **Files created:** `docs/reviews/M6/security.md`. Scratch files only under the session scratchpad. No source changes.
- **Open questions:** whether the owner accepts C2 and C3 as follow-ups rather than pre-merge fixes. Fixing C1 before merge is recommended.
- **Recommended next role:** Developer, to fix C1 (and ideally C2 and C3; this is review-loop cycle 1 of 3). Then Lead review. Then a Coordinator readiness report.

---

# Re-review (fix cycle 1), 2026-11-03

**This section's verdict replaces the one above.**

## R1. Scope and tools
- **Delta reviewed:** `git diff b3278b8..db52e09` (1 commit, 12 files), on branch `feat/m6-highlightly-weekly` at HEAD `db52e09`.
- **Files checked against C1-C3:**
  - `worker/src/line-mask.js` (new) and `worker/scripts/weekly-hl.js` (C1)
  - `worker/src/hl-weekly-client.js` (C2)
  - `worker/src/weekly-schedule.js` `badMatch` (C3)
  - The new tests, the drill sampler change, and the `db-status` refactor into `scripts/lib/weekly-status.mjs` (queries are constant, nothing security-relevant)
- **Constraints kept:** no source edits, no live calls, `.env` not read or printed.
- **Tools run** (all local; scratchpad scripts; fake key only; no real DB):
  - Root suite with non-loopback network blocked: **115/115 pass**.
  - Worker suite, same: **49 pass, 53 skipped** (no test DB).
  - **0 network attempts** across both suites.
  - `npm --prefix worker audit --omit=dev`: **0 vulnerabilities**.
  - No package, lockfile or `.env*` changes in the delta.
  - Experiments:
    - (d) `createLineMasker` edge cases;
    - (e) `weekly-hl.js` with the key only in a throwaway env file, under uncaught exception, `process.exit`, and SIGTERM;
    - (f) a stalled body and an endless body, using real `Response`/`ReadableStream` objects;
    - (g) fixture mode with a key present and `globalThis.fetch` stubbed to throw.

## R2. Conditions

**C1, key mask is now chunk-safe: met, with one narrow leftover (R3-1).**
- `weekly-hl.js` now routes both streams through a line-buffered `createLineMasker` and flushes on `exit`.
- Experiment (e): the key is masked in every case:
  - a key split across two `stderr` writes;
  - text with no trailing newline that is still buffered at exit;
  - the `uncaughtException` → `die()` path;
  - `process.exit(3)`.
- **SIGTERM:** buffered text with no newline is **dropped**, not printed. That is the safe direction, because SIGTERM gives no `exit` event. A hard kill or OOM behaves the same way.
- The new CLI test covers a key that exists **only** in the env file (`weekly-hl-cli.test.js`, "C1: …"). This closes the test gap I raised.

**C2, body timeout and streamed size limit: met.**
- The timer now covers headers and body (`Promise.race([work, timeout])`, with `ac.abort()`). The body is read as a stream with a running byte count and cancelled above `maxBody`.
- Experiment (f):
  - A body that stalls after its first bytes ends `highlightly unreachable (timeout)` after 3 attempts, counted once each (~900 ms at `timeoutMs=300`).
  - An endless body is cut at the limit after about 1.1 MiB pulled with `maxBody=1 MiB`, and ends `body too large` with no retry.
  - My original stub (headers fine, body never ends) now times out.
- A fallback to `res.text()` remains when there is no `body` stream. Only `fixtureFetch` takes it (local files only).

**C3, score validation: met.**
- `badMatch` now requires:
  - each side's periods to be an array of at most 20 entries;
  - each period to be an integer from 0 to 150;
  - each team total to be at most 400 (below the 32,767 `SMALLINT` limit).
- Anything else is counted under `bad_matches` and the stage carries on.
- The recorded fixtures use integer periods (checked: every value is `number` and `Number.isInteger`), so real data is not rejected. Null or missing scores are still allowed.

**Side effect: `weekly-hl.js` now reads `HIGHLIGHTLY_API_KEY` from the env file even in fixture mode.**
- **No real request can result.** The CLI passes `fixtures` and no `fetchImpl`, so the client uses `fixtureFetch`, sets `auth = null`, and sends requests to the base `https://fixture.invalid` with empty headers. Experiment (g): with a key **and** fixtures set, `matches()` and `boxScore()` gave 0 `globalThis.fetch` calls.
- **No leak.** The key is held only in a variable. It is never exported to the environment, never put in argv, and never sent to `fixtureFetch`. Everything printed goes through the masker.
- Only the names still missing are read from the file. With `DATABASE_PUBLIC_URL` already set in the environment, the file's DB URL is never used.
- See R3-2 for one consequence in the drill.

## R3. New findings (from the delta)

### R3-1: Minor. The masker's no-newline overflow path can split a complete key
- **Location:** `worker/src/line-mask.js:11`
- **Status:** Confirmed by experiment (d), high confidence.
- **What happens:**
  - When the buffer passes 64 KiB without a newline, the code writes `mask(buf.slice(0, len - K))` and keeps the last `K` characters (K = key length).
  - A **complete** key whose start falls in the last `K + 1` to `2K - 1` characters is split at the cut: the front part is written unmasked, and the rest of the key no longer matches.
  - Reproduced: `'y'×70000 + KEY + 'zzz'` and `'y'×70000 + KEY + 'z'` both put the full key in the output.
  - These are safe: a key exactly at the end, a key prefix at the end (the committed test's case), a key across two long chunks, and every case with a newline.
- **Reachability:** none in the current code. `console.log` always ends with a newline, which takes the whole-line path. A leak needs a single raw `write` over 64 KiB with no newline, containing the key near its end. This is the same latent class as the original Finding 1, but much narrower.
- **Recommended fix (one line):** mask the whole buffer first, then hold back only the last `K - 1` characters of the masked text:
  - `const s = mask(buf); write(s.slice(0, s.length - (K - 1))); buf = s.slice(s.length - (K - 1));`
  - Guard `K <= 1`.
  - Add the two reproducing cases above to `line-mask.test.js`.

### R3-2: Note. The drill's HL child now loads the real `.env` key into memory
- **Location:** `worker/scripts/weekly-hl.js:30` with `scripts/weekly-drill.sh`. The drill does not set `WEEKLY_HL_ENV_FILE`, and apart from W30 the key is not in its environment.
- **What happens:** every drill case that runs the real HL step now reads the owner's real `HIGHLIGHTLY_API_KEY` from the repo `.env`.
- **Impact:** low. As shown above, it is never sent and every printed byte is masked. But the drill is no longer fully separate from production secrets. The CLI tests are not affected, because they always pass a temporary env file.
- **Recommended fix (optional):** have `run_weekly` in the drill set `WEEKLY_HL_ENV_FILE` to an empty temp file.

### R3-3: Note. Buffered text with no newline is glued to the front of the `@@WEEKLY` line
- **Location:** `worker/scripts/weekly-hl.js` `emit()` together with the masker.
- **Status:** Observed in experiment (e): `unterminated [redacted]@@WEEKLY {…}`.
- **Impact:** if child code ever left a line unterminated, the runner's `startsWith('@@WEEKLY ')` check would miss the result line. A missing result line only adds a `no result line` note and loses the counts. This also happened before the change (the bytes are the same), and no current code writes without a newline.
- **Recommended fix (optional):** start the result line with `\n` when a masker holds pending text, or always.

Earlier Notes 4-9 are unchanged by this delta and stay optional.

## R4. Verdict (fix cycle 1)

`VERDICT: READY WITH CONDITIONS`

**Rationale:** C1, C2 and C3 are fixed and verified by experiment, with tests added. The fixture-mode key read cannot cause a real request or a leak. On exit or crash, no key tail escapes: buffered text is either flushed with masking or dropped, never printed raw. The only remaining issue is R3-1, which no current code can reach.

**Condition:**
- **C4 (R3-1):** apply the one-line overflow fix in `line-mask.js` and add the two reproducing tests. Because no current code path can trigger it, the owner may accept C4 as a tracked follow-up instead of a pre-merge fix. If C4 is fixed, or formally accepted as a follow-up, I consider the PR **READY** from a security standpoint. A re-review of the C4 fix alone would be a short delta check.

R3-2 and R3-3 are optional.

## Handoff (fix cycle 1)
- **Done:**
  - Re-reviewed `b3278b8..db52e09` against C1-C3. All three are met and confirmed by local experiments.
  - Checked the fixture-mode key-read side effect (no request, no leak) and the exit/crash flush behaviour (masked or dropped, never raw).
  - Suites re-run with the network blocked (0 attempts); `npm audit` clean.
- **Files touched:** `docs/reviews/M6/security.md` (this section appended). No source changes.
- **Open questions:** does the owner want C4 fixed before merge (one line plus tests, review cycle 2 of 3) or tracked as a follow-up?
- **Recommended next role:** Developer for C4 (optionally R3-2 and R3-3), or the Coordinator to record C4 as an accepted follow-up; then Lead review and the readiness report.

---

# Re-review (fix cycle 2), 2026-11-03

**This section's verdict replaces both verdicts above.**

## S1. Scope and tools
- **Delta reviewed:** `git diff db52e09..f2f6099` (1 commit, 5 files), HEAD `f2f6099`:
  - `worker/src/line-mask.js`
  - `worker/scripts/weekly-hl.js`
  - `scripts/weekly-drill.sh`
  - `worker/test/line-mask.test.js`
  - `worker/test/weekly-hl-cli.test.js`
- No package, lockfile or `.env*` changes. No source edits by me, no live calls, `.env` not read.
- **Tools run** (all local, network blocked, fake key only):
  - Root suite: **115/115 pass**.
  - Worker suite: **53 pass, 54 skipped** (no test DB).
  - **0 network attempts.**
- **Experiments** (scratchpad):
  - (h) The fix-cycle-1 reproducing cases.
  - (i) An exhaustive sweep: the key placed at every offset from `65536 − 2K − 2` to `65536 + 2K + 2`, as a single write and split into two writes at 1, 13 and K−1 characters.
  - (j) 300 random-chunking fuzz runs over ~200 kB of text with keys and newlines mixed in. Each output was compared byte for byte with a whole-string mask (`split(key).join('[redacted]')`).
  - (k) Empty, 1-, 2- and 3-character, `undefined` and `null` keys across the 64 KiB cut.
  - (l) `endLine` behaviour.
  - (m) The CLI exit/crash experiment from fix cycle 1, with the key only in a throwaway env file.

## S2. Items

**C4 (R3-1), overflow path: met.**
- `line-mask.js:11-16` now masks the whole buffer first, writes all but the last `K − 1` characters of the **masked** text, and holds those back.
- **Why a key can't straddle the cut:** the masked text `m` contains no complete key. A key crossing the cut at `m.length − (K−1)` would have to end inside `m`, so it would lie wholly inside `m`, which is impossible. Any later completion of a key starts within the held-back K−1 characters, and the next mask catches it.
- **Results:**
  - (h) `70,000 chars + key + "zzz"`, `+ "z"` and `+ ""` are all masked.
  - (i) Every offset matches the whole-string mask exactly.
  - (j) All 300 fuzz runs give output **identical** to the whole-string mask: no drop, no duplication, no leak.
- **Short keys:** for keys shorter than 4 characters (including empty, `undefined` and `null`), `keep = 0`. The code uses `m.slice(m.length − 0)`, not `slice(-0)`, so the buffer correctly becomes `''` and the text passes through unchanged (k).
- **Memory:** the buffer stays bounded at 64 KiB plus one chunk.
- **Tests:** the committed tests cover the reproducing case, several pad offsets around the cut, a key fully inside the overflowed part, and a key split across the boundary.

**R3-2, drill env file: met.**
- `weekly-drill.sh` creates `$WORK/empty.env` and adds `WEEKLY_HL_ENV_FILE=$WORK/empty.env` to `BENV`.
- `build_env` derives every run's `LE` from `BENV`, removing only `WEEKLY_STEP_FIXTURE`, `WEEKLY_RAILWAY_BIN` or `BACKUP_RAILWAY_BIN` when asked. So every real-step drill case carries the variable.
- `stepEnv` passes the variable through to the HL child, because it is not in `INTERNAL_ENV`. The drill therefore no longer reads the real `.env`.
- W30 still puts its fake key in the environment, so redaction is still exercised.

**R3-3, result line on a fresh line: met.**
- `emit()` calls `endLine()` on both maskers before writing `@@WEEKLY …`. `endLine` writes any pending text masked, plus `\n`, and writes nothing when the buffer is empty (l).
- (m): after unterminated output that contains a key prefix, the uncaught-exception path printed `unterminated [redacted]` and then `@@WEEKLY {…}` **on its own line**, with 0 key occurrences.
- In the `exit` and `sigterm` modes there was no key leak. There was also no result line, because my preload ended the process outside the child's flow, which is expected.
- A new CLI test covers the same case.

## S3. New findings
- **Note (cosmetic, no action needed):**
  - Cutting at the 64 KiB boundary can split a UTF-16 surrogate pair, turning one astral character into `U+FFFD` in the log.
  - A key that is itself a substring of `[redacted]` could be masked twice.
  - Neither affects confidentiality, and real Highlightly keys are long random strings.
- No other issues in the delta.

Notes 4-9 from the first review remain optional hardening and do not block.

## S4. Verdict (fix cycle 2)

`VERDICT: READY`

**Rationale:** every condition is resolved and verified:
- C1, C2 and C3 in cycle 1;
- C4, R3-2 and R3-3 here, including an exhaustive cut sweep and fuzzing against a reference mask.

The key cannot appear unmasked in the child's output on any path tested: chunked, over-long, at exit, or on a crash. Fixture runs and drills cannot make real requests or read the real `.env`. There are no dependency changes and no secrets in the diff, and both suites pass with the network blocked. The remaining Notes are optional.

## Handoff (fix cycle 2)
- **Done:**
  - Verified C4, R3-2 and R3-3 at `f2f6099`.
  - Re-ran the reproducing cases, plus a cut-position sweep, 300 fuzz runs, short-key cases, and the exit/crash experiment.
  - Suites re-run offline: 0 network attempts.
- **Files touched:** `docs/reviews/M6/security.md` (this section appended). No source changes.
- **Open questions:** none from Security. Notes 4-9 and the S3 cosmetic note are optional follow-ups at the owner's discretion.
- **Recommended next role:** Lead review, then the Coordinator's readiness report (Gate 2). Remind the owner of plan item O1: merging redeploys the ingestion worker.
