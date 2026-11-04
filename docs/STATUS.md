# Coordinator Status Log

## Mission M1 — Onboard repo + CI test workflow (opened 2026-11-01)

**Mission (owner):** Onboard this repo, then add a GitHub Actions workflow that runs the tests for root, backend, worker, and frontend on pull requests. Use a Postgres service container for tests that need a database, no secrets or API keys, and no lint. Read PLATFORM.md and docs/ first and build on them rather than replacing them.

**Path:** Existing app, first run (Lead onboard) -> Small change + Security (CI config) -> QA + Sec -> Lead review -> readiness report.
PA skipped: requirements are concrete and owner-specified.

**Branch:** `chore/ci-workflow`, **PR #2** (https://github.com/Jayprox/ai-application-nba/pull/2).

**Note:** `docs/architecture.md` already exists; on macOS's case-insensitive FS it *is* `docs/ARCHITECTURE.md`. It is extended in place, not replaced.

### Tasks
- [x] T1 Lead: onboard — extended `docs/architecture.md` (§9 added, §1-8 unchanged), created `docs/STANDARDS.md`, plan `docs/plans/M1-ci-test-workflow.md`
- [x] T2 Dev: worker fixture fix, `.github/workflows/test.yml`, docs; PR #2 opened, CI green first run
- [x] T3 QA review — READY (after fix cycle 1)
- [x] T4 Security review — READY
- [x] T5 Lead review — READY WITH CONDITIONS; conditions closed in fix cycle 2
- [x] T6 Readiness report (below) -> **GATE 2: waiting on owner merge approval**

### Approvals
- 2026-11-01 — Owner: mission text accepted as the requirement (no PA).
- 2026-11-01 — Owner: **D1 = Option A** (backend CI runs schema apply + constraint tests + empty-DB-safe files league/names/rankings/ratelimit). Fixture DB (B) deferred to a future M2.
- 2026-11-01 — Owner: fix the broken worker test fixture (plan T1) in this PR.

### Fix cycles (limit 3)
1. QA Minors: docs record the fixture stat-row move (HOU -> MEM); drop stale "once CI exists" in STANDARDS. Head `36f71c3`, CI green, QA re-verified READY.
2. Lead Minors: architecture §9.3 worker row updated to 23/0; STANDARDS bullet on the explicit backend CI file list; review files committed. Head `202073f`, CI green. Coordinator verified the doc-only diff (Lead said no reviewer re-run needed).

### Readiness report — PR #2 at `202073f`
**What changed**
- `.github/workflows/test.yml`: 4 parallel jobs (root, frontend, worker, backend) on `pull_request` and push to `main`. Node 22.x, `postgres:18` service only on worker and backend (separate DBs), `permissions: contents: read`, `persist-credentials: false`, actions pinned to full SHAs (checkout v7.0.1, setup-node v7.1.0), no secrets, no lint.
- `worker/test/players.test.js`: fixture-only fix (final games get scores; stat rows moved HOU -> MEM so the test exercises the path it's named for). Assertions unchanged.
- Docs: `docs/architecture.md` §9 (run/test), `docs/STANDARDS.md`, plan, reviews, README test note.

**CI:** run 41385352723 green. root 31/31, frontend 32/32, worker 23/23 (0 skipped), backend constraint tests PASSED + 12 pass / 3 skip.

**Verdicts:** QA READY · Security READY · Lead READY WITH CONDITIONS (both conditions closed and verified). No open Blocker or Major findings.

**Known limits / risks**
- Backend CI covers only 4 of 9 test files (owner decision D1-A). Auth, browse, query, props, ask need real NBA data and run locally only. M2 (fixture DB) would close this.
- The explicit backend file list must be maintained (now documented in STANDARDS).
- `postgres:18` is pinned by tag, not digest (Note).

**Reviewer disagreements:** none.

**Recommendation:** **Ready to merge.**

### Follow-ups for the owner (not part of PR #2)
1. **Security, urgent-ish (pre-existing on `main`):** `docs/architecture.md:698` names the production Railway Postgres public proxy host:port in a public repo. Real fix is on Railway: rotate or disable the public proxy, confirm a strong password. Then a `fix/` PR to redact the doc line (history keeps the old value).
2. **Probable bug (worker):** on the `name+team+date` match path the worker doesn't set `is_active = true`, so an inactive player who re-signs with the same team stays off the roster and the props pool until the next roster seed (`worker/src/players.js:34-38,49`). Bug-fix path.
3. **M2:** committed fixture DB so the full backend suite runs in CI.
4. Existing `npm audit` findings: backend runtime (`body-parser`, `qs`), frontend dev tooling (`vite`, `vitest`, `undici`, `source-map-js`).
5. After merge: in GitHub, enable branch protection "require status checks" for the four Tests jobs; keep "require approval for first-time contributors".

### Blockers
- (none)

## Mission M2-fix: redact Railway Postgres proxy host from docs (2026-11-01)
**Mission:** Replace the real Railway public proxy host:port at `docs/architecture.md:698` with `<railway-public-host>:<port>`. Docs only. PR notes the public proxy was removed and the DB password rotated (owner-reported).
**Path:** Small change (Dev -> QA), plus Security because the change redacts infra exposure.
**Tasks**
- [x] T1 Dev: branch `fix/redact-railway-proxy-host`, edit line 698, PR #3 (commit `31c78eb`)
- [x] T2 QA + Sec review (both READY WITH CONDITIONS)
- [x] T3 Coordinator readiness report

**Fix cycle 1 of 3:** PR #3 body rewritten (removed stray backslash escapes and a grep line that quoted the old host fragment and port). `docs/reviews/M2-fix/qa.md` and `security.md` redacted by their authors (both had quoted the old value). Coordinator verified: tree, PR body, and PR comments have zero hits for the old host or port.

### Readiness report — PR #3
**What changed:** `docs/architecture.md` §8 backfill paragraph: real Postgres public proxy host:port replaced with `<railway-public-host>:<port>`; text now says the proxy was removed on 2026-11-01, the password rotated, and a proxy must be re-added in Railway before backfills. Plus this STATUS entry and `docs/reviews/M2-fix/`.
**CI:** run 41396852799 green (root, frontend, worker, backend).
**Verdicts:** QA READY WITH CONDITIONS · Security READY WITH CONDITIONS. Repo-side conditions closed (PR body, review-file redaction). No open Blocker or Major findings. No Lead review (small-change path).
**Remaining conditions (owner):**
1. Confirm in the Railway dashboard that the Postgres public TCP proxy is gone and the password was rotated. Reviewers could not verify this; the PR's safety argument depends on it.
**Risks / notes:**
- The old host:port stays in git history (commit `dd58399` on `main`). Security recommends no history rewrite: only a bare host:port was exposed (never a connection string with the password), and a force-push to `main` would break cited SHAs without clearing GitHub caches or forks.
- Local-only branch `chore/hardwood-agent-setup` (commit `8830918`): `dbguard.test.js` uses the same port as the old proxy. Redact before that branch is ever pushed.
**Reviewer disagreements:** none.
**Recommendation:** Ready to merge, conditional on owner confirmation of item 1.

## Mission M3-backup: off-Railway Postgres backups + restore drill (2026-11-01)
**Mission:** Add `scripts/` backup routine: `pg_dump` of production Postgres through the Railway CLI SSH tunnel (no public proxy), timestamped compressed dump saved outside the repo, keep the most recent N, log success/failure. No credentials in the repo. Restore procedure in docs, tested only against a throwaway local Postgres container. Nothing runs against production without owner approval.
**Path:** Feature (new script + docs). Proposed: mission text as the requirement (no PA), pending owner confirmation at Gate 1.

**Intake findings (Railway CLI 5.71.0 + docs.railway.com, checked 2026-11-01)**
- Tunnel: `railway connect <postgres-service> --tunnel-only [-P <local-port>]` (implies `--ssh`; holds the tunnel until Ctrl+C). It prints host/port/user/password/full URL (on stderr, per connect.rs v5.71.0), so the script must never log that output.
- Prod is Postgres 18; local machine has no `pg_dump`/`psql`. Need a v18 client (`brew install libpq` or Docker `postgres:18`). Docker is installed.
- Railway docs now describe native volume backups (daily/weekly/monthly schedules) and PITR (`railway postgres pitr ...`). This conflicts with the mission premise "no built-in backups". Escalated to owner. Native backups are deleted with the volume, so an off-platform dump remains useful either way.

**Tasks**
- [x] T0 Gate 1: owner confirms requirements, storage location, retention/schedule, native-backup decision
- [x] T1 Lead plan (`docs/plans/M3-backup.md`): Node script + Homebrew libpq 18, creds parsed in memory from tunnel output -> PGPASSWORD, mount-point check, fake-tunnel drill. Security review required. No architecture change needing owner approval.
- [x] T2 Dev: PR #4 (`feat/db-backup`)
- [x] T3 QA + Sec review (3 fix cycles; final QA READY, Security READY at `81113b9`)
- [x] T4 Lead review (READY WITH CONDITIONS; condition = CI green on `2d1e654`, met by run 41487783978)
- [x] T5 Readiness report
- [ ] T6 (separate owner approval) first run against production

### Approvals
- 2026-11-01 — Owner (Gate 1): mission text approved as requirements, no PA. Restore test only against a throwaway local postgres:18 container.
- 2026-11-01 — Owner: storage = external drive `/Volumes/TM-Prism/db-backups`; if the drive isn't mounted, log a failure and stop; never write into Time Machine's own folders.
- 2026-11-01 — Owner: native Railway backups/PITR are not on the current plan (Backups tab says upgrade to Pro). Dump routine only; one-line doc note that a plan upgrade adds native backups + PITR.
- 2026-11-01 — Owner: Developer may `brew install libpq` on this Mac for the drill.
- 2026-11-02 — Owner: after the incident, add a production opt-in guard (`BACKUP_CONFIRM_PROD=1`) and continue reviews.
- 2026-11-02 — Owner: Railway account SSH keys checked, clean (only the owner's GitHub-synced key).
- 2026-11-02 — Owner: `DB-Backups` encrypted, ownership enabled; `/Volumes/DB-Backups/db-backups` owned by owner, mode 700. Coordinator verified read-only (`diskutil info`: FileVault Yes, Owners Enabled; `drwx------`).
- 2026-11-02 — Owner: Railway Postgres service name confirmed as `Postgres` (matches `BACKUP_PG_SERVICE` default).
- 2026-11-01 — Owner: keep 14 dumps; daily launchd job (plist in repo, owner installs it); verify the script manually first.

### Blockers
- (none open)
- Resolved: `/Volumes/TM-Prism` is the Time Machine destination volume itself (`tmutil destinationinfo`). Listing it fails with "Operation not permitted". APFS Time Machine volumes are dedicated to TM, so `db-backups` there would be inside a TM-managed volume. Escalated to owner; nothing written to the drive.
  - Resolved 2026-11-01 — Owner: create a new APFS volume `DB-Backups` on the same drive (owner runs `diskutil apfs addVolume` themselves). Script target is `/Volumes/DB-Backups/db-backups`. TM-Prism is not touched.

### Incident (2026-11-02, hard rule "nothing against production without owner approval")
- 06:54:22Z: while testing the "drive not mounted" case, Dev ran `node scripts/backup-db.mjs` with default config. The owner had already created `/Volumes/DB-Backups`, so preflight passed and the real CLI ran `railway whoami` then `railway connect Postgres --tunnel-only -P 55432 -e production`. The tunnel exited after ~1s: `FAIL stage=tunnel reason="railway tunnel process exited early (output withheld)"`. No `pg_dump`, no DB connection, CLI output never read or logged. Disclosed in the PR #4 body.
- Coordinator verified locally: no railway/ssh/pg_dump process left; one real-run line in `~/Library/Logs/chalk-that-nba/backup.log`; `~/.ssh` unchanged; `~/.railway` only got two empty lock files. Side effect: empty `/Volumes/DB-Backups/db-backups`.
- Owner checked Railway SSH keys: clean. Closed.
- Remedy: production opt-in guard (`BACKUP_CONFIRM_PROD=1`, realpath allowlist for the test fake), drill env scrubbing. The production log still holds only the incident line after all three cycles.

### Fix cycles (limit 3, all used)
1. Owner-directed production guard. Head `20b7b59`, CI 41476164011 green, drill 51/0.
2. Sec Major (drill could fall through to the real CLI with the flag set) + QA/Sec Minors: realpath-allowlist guard, TM-Prism device + firmlink deny, restore-doc step (b), README/architecture, orphaned-tunnel reaper. Head `1f3a027`, CI 41480681670 green, drill 59/0.
3. Lead-scoped: drill launches via `env -i` (Sec R3.1), absolute `BACKUP_RAILWAY_BIN` + run the approved realpath (R3.2/R3.3), PR body rewrite. Head `81113b9`, CI 41485969944 green, drill 60/0, root tests 47/47.
- Coordinator doc-only follow-up (no reviewer re-run needed): `docs/architecture.md` drill count 59 -> 60 (QA Minor), this STATUS entry, review files committed.

### Readiness report — PR #4
**What changed:** https://github.com/Jayprox/ai-application-nba/pull/4 (`feat/db-backup`)
- `scripts/backup-db.mjs` (+ `scripts/lib/backup.mjs`, unit tests): `pg_dump` of production through `railway connect Postgres --tunnel-only` (SSH, no public proxy). Credentials parsed in memory and passed via `PGPASSWORD` only. Dump `chalk-that-nba_<UTC>.dump` (custom format, compressed, 0600) to `/Volumes/DB-Backups/db-backups`, written as `.partial`, validated (`pg_restore --list`, `teams` present), renamed atomically, then rotated to the 14 newest. One log line per run in `~/Library/Logs/chalk-that-nba/backup.log`, macOS notification on failure.
- Safety: production opt-in `BACKUP_CONFIRM_PROD=1` checked before any CLI call (only the repo's fake is exempt, by realpath); real mount-point check; TM-Prism denied by path and device; single-run lock; tunnel always killed, orphan reaper after SIGKILL.
- `scripts/backup-drill.sh` (`npm run db:backup:drill`): local-only end-to-end test with a fake tunnel, a disk image and two throwaway `postgres:18` containers.
- `ops/launchd/com.chalkthat.nba.backup.plist` (daily, sets the opt-in; owner installs), `docs/backup-restore.md` (restore procedure + Pro-plan note), README / architecture updates.

**CI:** run 41487783978 green on `2d1e654` (root, frontend, worker, backend). Root tests 47/47. Drill 60/0 (QA run).
**Verdicts:** QA READY · Security READY · Lead READY WITH CONDITIONS (condition met). No open Blocker/Major/Minor.
**Risks / notes**
- The real `--tunnel-only` output format was built from the CLI source, not observed. It fails closed without printing secrets; the first approved run confirms it.
- Pre-guard incident (above): one real tunnel open, no data accessed; owner verified Railway keys.
- Dumps contain user emails and password hashes; volume is encrypted.
- The launchd job needs an active `railway login` session; an expired session shows up as a logged failure.
**Reviewer disagreements:** none.
**Follow-ups (after merge, Lead F5):** (1) resolve `BACKUP_RAILWAY_BIN` once and spawn that string; (2) forward `BACKUP_PG_BIN_DIR` in the drill; (3) stricter reaper argv match; (4) drill case for the reaper's negative path; (5) drop the 256 KB `pg_restore --list` capture cap; (6) document stale-lock cleanup and pin the drill `postgres:18` image by digest.
**Recommendation:** Ready to merge.
**Still owner-gated:** merge approval (Gate 2); then a separate T6 approval for the first production run (`BACKUP_CONFIRM_PROD=1 npm run db:backup`, by hand), then installing the plist.


## Mission M4 — Backup tunnel leaves ssh child running (opened 2026-11-02)

**Mission (owner):** After a run, `railway connect --tunnel-only`'s separate `ssh -N -i ...` child stays alive listening on 127.0.0.1:55432, so the next run fails with "tunnel port already in use". Fix `scripts/backup-db.mjs` and `scripts/lib/backup.mjs` so every exit path (success, failure, timeout, signal) terminates the ssh child as well as railway, and the orphan reaper also handles an ssh tunnel on the backup port whose railway parent is gone. Make `scripts/fixtures/fake-railway.sh` spawn a detached ssh-like child so the drill catches it. Nothing runs against production; owner verifies with a real run.

**Path:** Bug fix — Lead triage -> Dev -> QA + Sec (process termination / reaper matching) -> Lead review -> readiness report.

### Tasks
- [x] T1 Lead: triage note `docs/plans/M4-backup-ssh-child.md` (root cause: CLI puts ssh in its own process group; script only kills railway's group; Sec needed; F5(3)(4) folded in)
- [x] T2 Dev: PR #5 (`fix/backup-ssh-child`, head `0e9c299`), CI 41583974979 green, root 55/55, drill red 70/33 on old code -> green 99/0
- [x] T3 QA review — READY WITH CONDITIONS (cleanup-failure path not drilled; real CLI verified only by owner run). Pre-fix drill 58/45 reproduces the bug; branch 99/0.
- [x] T4 Security review — READY (Minors: ssh matcher accepts extra forward options; reaper signals ssh process group)
- [x] T5 Lead review — READY WITH CONDITIONS: drill the `stage=cleanup` path in this PR (fix cycle 1). Sec Minors 1-2, Sec note 6, perl prereq check -> one hardening follow-up. Perl launcher deviation accepted.
- [x] T6 Readiness report (below) -> **GATE 2: waiting on owner merge approval**

### Approvals
- 2026-11-02 — Owner: mission text accepted as the requirement (bug fix, no PA). No production runs.

### Fix cycles (limit 3)
1. Lead/QA: add a drill case for `FAIL stage=cleanup` (drill-only, no source change). Head `a574414`, CI 41611129533 green, drill 108/0, root 55/55. QA re-verified (READY WITH CONDITIONS, condition = owner real run). Sec re-review not needed (no source/fixture change). Lead condition met.

### Follow-ups (after merge)
- Hardening: reject extra forward options in the ssh matcher (Sec 1); signal only the pid in the reaper path (Sec 2); scrub `lsof` env, absolute `osascript` (Sec note 6); drill prerequisite check for perl.

### Readiness report — PR #5
**What changed:** https://github.com/Jayprox/ai-application-nba/pull/5 (`fix/backup-ssh-child`)
- Root cause: `railway connect --tunnel-only` runs `ssh -N -L 127.0.0.1:<port>:…` in its own process group and only stops it on SIGINT; the script killed railway's group with SIGTERM, so ssh survived every run.
- `scripts/backup-db.mjs` / `scripts/lib/backup.mjs`: find railway's ssh child (strict argv match, exact port, same uid) while railway is alive; on every exit path kill ssh first, then railway; verify the port is free, else `FAIL stage=cleanup` (exit 2). Orphan reaper now also runs with no stale lock and kills only a same-uid, exact-argv ssh listening on `127.0.0.1:<port>` whose parent is gone.
- `scripts/fixtures/fake-railway.sh`: spawns an own-session ssh-like forwarder (perl setsid) like the real CLI. `scripts/backup-drill.sh`: SIGINT, timeout, orphan-without-lock, cleanup-failure and four must-not-kill cases.
**CI:** run 41611129533 green on `a574414`. Root 55/55. Drill 108/0 (pre-fix code: 58 pass / 45 fail, reproducing the bug).
**Verdicts:** QA READY WITH CONDITIONS (owner real run) · Security READY · Lead READY WITH CONDITIONS (cleanup drill case — met). No open Blocker/Major.
**Risks / notes**
- Fixture models Railway CLI v5.71.0 argv; the real CLI is verified only by the owner's run. If that run ends `FAIL stage=cleanup`, the matcher missed the real ssh argv — report it, don't retry.
- Orphan cleanup can stop a manual tunnel on 55432 whose `railway connect` already exited (live-parent tunnels are never touched). Use another `-P` port for manual sessions.
**Reviewer disagreements:** none.
**Recommendation:** Ready to merge, with the post-merge owner check: `BACKUP_CONFIRM_PROD=1 npm run db:backup`, then `lsof -nP -iTCP:55432 -sTCP:LISTEN` and `pgrep -fl 'ssh .*-L 127.0.0.1:55432'` both print nothing.


## Mission M5 — Weekly job via Railway CLI tunnel (opened 2026-11-03)

**Mission (owner):** Update `scripts/weekly.sh` and `ops/launchd/com.chalkthat.nba.weekly.plist` to reach the Railway DB through the Railway CLI tunnel instead of `DATABASE_PUBLIC_URL` (public proxy removed). Reuse `scripts/lib/backup.mjs` tunnel handling, including closing railway and its ssh child on every exit path. Tunnel on a local port other than 55432/55433; run `db:schedule`, `db:backfill -- --season 2026-27`, `db:status` against it; close on exit even on failure. Production writes need an explicit opt-in flag (like `BACKUP_CONFIRM_PROD`), off by default. Test only against a throwaway local Postgres container and the fake railway. Never run against production; owner does the first real run by hand.

**Path:** Feature, mission text as requirement (no PA) -> Gate 1 (owner answers open questions) -> Lead plan -> Dev (branch + PR) -> CI -> QA + Sec (process control, prod guard, config) -> Lead review -> readiness report -> Gate 2.

### Tasks
- [x] T0 Gate 1: owner answers recorded (see Approvals)
- [x] T1 Lead: plan `docs/plans/M5-weekly-tunnel.md` (shared `scripts/lib/tunnel.mjs` extracted from backup as a pure-refactor first commit; `WEEKLY_TUNNEL_PORT` default 55434; `WEEKLY_CONFIRM_PROD=1` guard; node orchestrator `scripts/weekly.mjs` behind `weekly.sh`; drill-only `WEEKLY_STEP_FIXTURE`; Sec needed). No significant architecture change. Owner items for Gate 2: two prod flags (plist sets both), weekly now depends on the DB-Backups drive, daily backup may notify "lock held" when weekly's backup runs first (follow-up), concurrent tunnels + refactored backup unverified on real CLI.
- [x] T2 Dev: PR #6 (`feat/weekly-tunnel`, head `b49fcc3`), CI 41683723531 green, root 76/76, backup drill 108/0, weekly drill 153/0 (W1-W24). Open: `.env.example` not updated (session permissions deny reading it). Negative check (no-op tunnel kill) went red but cascaded via the backup step, not isolated to weekly close.
- [x] T3 QA review — READY WITH CONDITIONS (`docs/reviews/M5/qa.md`). All requirements traced to passing tests; weekly-only mutants (incl. backup-reused path) caught by W5/W6/W14 — the suspected coverage gap is not real. Minors: `.env.example` not updated; drill cascades after one broken close. Condition: owner's first manual run is the real check (incl. notification).
- [x] T4 Security review — READY WITH CONDITIONS (`docs/reviews/M5/security.md`). Condition = Minor 1: refuse a real weekly run (prod flags) whose backup railway is the fake (prod writes with a fake "backup"). Minors 2-4: fake-mode backup in the real folder could be reused as fresh; redactor can split a secret at its 64 KB line cap; port check only sees the weekly env's BACKUP_TUNNEL_PORT. Notes 5-9.
- [x] T5 Lead review — NOT READY (`docs/reviews/M5/lead.md`): fix cycle 1 = (1) Sec 1 raised to Major: refuse prod run if `BACKUP_RAILWAY_BIN` is set at all; (2) refuse fake weekly run pointing at real backup volume/log; (3) redactor drops overlong lines with a marker; (4) docs on port settings. `.env.example` -> owner at Gate 2; drill cascade + Sec notes 5/6/8 -> follow-ups.

### Fix cycles (limit 3)
1. Lead/Sec: findings 1-4 above. Head `dac36c3`, CI 41709082436 green, root 80/80, weekly drill 155/0 (new W25), backup drill 108/0. Deviation: W23 now hits the new guard first, so the step-fixture realpath check is no longer reached by the drill. Re-checks: QA READY WITH CONDITIONS (80/0, 155/0, 108/0; mutants confirm tests catch findings 1-3; Notes R-1 fixture branch unit-test-only, R-2 single-chunk redactor test is weak). Sec READY WITH CONDITIONS (findings 1 and 3 closed, 2 closed weekly side; new Minor R3-1: isolation check compares path strings, case-insensitive disk lets `/volumes/db-backups` past it -> follow-up; W23 -> follow-up unit test via `stepFixtureError`, no drill variant). Lead final pass: READY WITH CONDITIONS, no fix cycle 2 (R3-1 and W23 accepted as follow-ups).
- [x] T6 Readiness report (below) -> **GATE 2: waiting on owner merge approval**

### Follow-ups (after merge; bundle with open M4 hardening items)
1. Backup side of Sec finding 2 + R3-1: tag fake-mode backup OK lines (`src=fake`) and have `findFreshBackup` reject them; optionally realpath + case-insensitive path compare.
2. Enforce the backup/weekly port reservation in code (finding 4).
3. Extract `stepFixtureError` in `scripts/lib/weekly.mjs` and unit-test it (W23 / Sec R4).
4. Sec notes 5, 6, 8: stale reaper trusts recorded port; lock-takeover race; `logs/weekly.log` permissions.
5. Drill cascade after one broken close (reap and assert ports free between cases).
6. QA R-2: make the single-chunk redactor test fail on the old code.
7. Daily backup's "another backup is running" alert when the weekly backup takes the lock first at wake.

### Readiness report — PR #6
**What changed:** https://github.com/Jayprox/ai-application-nba/pull/6 (`feat/weekly-tunnel`, head `dac36c3`)
- `scripts/lib/tunnel.mjs`: M4 tunnel open/close, ssh-child kill and orphan reaper moved out of the backup unchanged (pure refactor commit, backup drill 108/0 before and after).
- `scripts/weekly.mjs` (new orchestrator, called by `scripts/weekly.sh`): guard `WEEKLY_CONFIRM_PROD=1` (exactly "1", refuses before any lock, CLI call or backup; also refuses if `BACKUP_RAILWAY_BIN` is set) -> pre-write backup (reuse a validated dump under 24 h, else wait up to 10 min on a held lock, else run `db:backup`; abort with no writes on failure) -> tunnel on `WEEKLY_TUNNEL_PORT` (default 55434; 55432/55433/backup port refused) -> schedule -> positions -> backfill `--season 2026-27` -> status -> close railway and its ssh child on every exit path, then verify the port is free. Tunnel URL only in each step's child env; output redacted; log and notification kept.
- Weekly plist sets `WEEKLY_CONFIRM_PROD=1` and `BACKUP_CONFIRM_PROD=1`; launchd logs moved out of `/tmp`. Not installed or loaded.
- Weekly drill (`npm run db:weekly:drill`, local only, throwaway `postgres:18` + fake railway), unit tests, docs.
**CI:** run 41709082436 green on `dac36c3`. Root 80/80. Weekly drill 155/0. Backup drill 108/0. Reproduced independently by QA and Sec.
**Verdicts:** QA READY WITH CONDITIONS · Security READY WITH CONDITIONS · Lead READY WITH CONDITIONS. One fix cycle (Sec 1 raised to Major and fixed). No open Blocker/Major.
**Risks / notes**
- Nothing has run on the real Railway CLI: real tunnel, two tunnels at once, refactored backup on the real CLI and the notification are verified only by the owner's first manual run.
- A real weekly run now needs the DB-Backups drive mounted, and needs both prod flags.
- A fake-mode backup written into the real folder by hand could be reused as "fresh" for 24 h until follow-up 1 lands.
**Reviewer disagreements:** none.
**Recommendation:** Ready to merge, with conditions: (1) owner adds the `.env.example` lines (agents can't read it; text in `docs/reviews/M5/lead.md` finding 5); (2) owner's first real run by hand before installing the plist: `WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1 npm run db:weekly`, then check `logs/weekly.log`, the notification, and that `pgrep -fl 'ssh .*-L 127.0.0.1:5543'` and `pgrep -fl 'railway connect'` print nothing.
**Still owner-gated:** merge approval (Gate 2); first real run; installing/reloading the weekly plist.
- [ ] T6 Readiness report -> Gate 2

### Approvals
- 2026-11-03 — Owner (Gate 1): mission text accepted as the requirement, plus:
  1. **Pre-write backup: yes, abort the weekly run if it fails.** If a *validated* backup from the last 24 hours already exists, use it instead of taking a new one. If a backup run is in progress (lock held), wait up to 10 minutes for it to finish instead of failing. (Context: the Mac is often asleep at 03:17, so the daily backup and the Monday 09:07 weekly job can both fire at wake.)
  2. **Keep `db:positions`**: order schedule -> positions -> backfill -> status.
  3. **Weekly plist sets the production opt-in flag** (like the backup plist). Team does not install/reload the plist; owner does that after the manual first run.

## Mission M6 — Weekly job without NBA.com (opened 2026-11-03)

**Mission (owner):** The first real weekly run (2026-11-03) failed at stage=schedule: stats.nba.com times out and cdn.nba.com returns Akamai "Access Denied" from home wifi and cellular. Make the weekly job (schedule, positions, backfill, status) complete with Highlightly as the primary source and NBA.com as best-effort fallback or not at all, without removing behaviour that works.

**M5 note:** PR #6 is merged on `main` (`cb4a13c`); the owner's first real run is the one in `logs/weekly.log` that failed at schedule (backup reuse and cleanup worked).

**Path:** Feature (full workflow). PA -> Gate 1 -> Lead plan -> Dev -> CI -> QA + Sec (Sec required: new external source, API key handling, input parsing) -> Lead review -> readiness report -> Gate 2.

**Branch:** `feat/m6-highlightly-weekly`.

**Constraints:** no production, Railway tunnel, or live Highlightly/NBA API calls without owner approval; fixtures and recorded responses only; do not touch `.env` or print keys.

### Tasks
- [x] T1 PA: `docs/requirements/M6-highlightly-weekly.md` (DRAFT). Weekly path hits stats.nba.com only (14 calls/run; cdn.nba.com is used only by `seed.mjs`). Highlightly covers box scores (minutes, +/- exact) and schedule time/status for existing games; no arenas, national TV, Cup stage, season type, standings; positions weak. Weekly Highlightly spend ~80-130 typical, ~385 worst, ~505 first run with sweep; plan period (day vs month) unconfirmed. 9 stories, 11 owner questions.
- [x] Gate 1: owner approved 2026-11-03 (answers below)
- [x] T2 Lead plan: `docs/plans/M6-highlightly-weekly.md`. Highlightly weekly code in `worker/` (new modules + `worker/scripts/weekly-hl.js`), reusing worker matching/box-score code; no schema change, no new dependency. One quota-guarded client per run (cap 600, reserve 1,000, header check on every response, clean stop; fetch-then-short-transaction writes). Single 15 s NBA.com probe; `OK-DEGRADED` exit 0 when skipped. Update-only (no game inserts). Q11 sweep behind `WEEKLY_HL_FULL_SEASON=1` + live remaining > 3,000. Concurrency: skip live/active-window games, lock and re-read before write; two residual races logged (need worker change). No owner gate needed per Lead. Items for Gate 2: O1 (PR touches `worker/` so merge redeploys the Railway worker), O2 (tip-off follows whichever source answered that week), O3 (`.env.example` not edited; flags documented), O4 (Q11 opt-in stays an owner action). For Sec: S1 (key redaction when the key exists only in `.env`).
- [x] T3 Dev: PR #7 https://github.com/Jayprox/ai-application-nba/pull/7 (13 commits). CI green on first push (root, worker, backend, frontend). Local: root 110/110, worker 91/91 (with test DB), drill 203/0 (W26-W32 new), frontend 32/32. No live calls, no `.env` access, no schema/dependency/CI/plist change. Deviations (8, routine): notably manual `weekly-hl` applies tip-off changes only with `WEEKLY_HL_TIPOFF=1`; per-game savepoints in catch-up; missing NBA fixture = unreachable. First real run needs `npm --prefix worker ci` once. Dev note (pre-existing, not fixed): live worker runs `BEGIN`/`COMMIT` via `pg.Pool`, only safe while the pool reuses one connection. Sec focus S1-S5.
- [x] T4 QA (`docs/reviews/M6/qa.md`, at `b3278b8`): READY WITH CONDITIONS, no Blocker/Major. CI green; root 110/110; worker 91/91 on throwaway postgres:18 (unmodified `sync.test.js` passes); drill 203/0 on clean rerun (first run 202/1: host-wide `ps` sampler caught an unrelated process). Verified W26 (NBA blocked -> OK-DEGRADED exit 0), W27 (Highlightly down -> FAIL, DB unchanged, tunnel closed), W28/W29 clean stop on reserve/cap with no partial game, W30 redaction, no `INSERT INTO games` (Q1), manual `db:*` unchanged. Minors: drill `ps` sampler host-wide; no test of `db:status` weekly line; 51 worker tests skip silently without test DB. Conditions: owner confirms quota period before `WEEKLY_HL_FULL_SEASON=1`; owner accepts worker redeploy (O1).
- [x] Fix cycle 1/3 (Dev): pushed `db52e09`, CI green. Root 115/115, worker 102/102 (test DB), drill 203/0. C1: new `worker/src/line-mask.js` (whole-line masking on stdout/stderr; key also read from env file in fixture mode for masking). C2: timeout covers headers + body; size limit enforced while streaming (cancel past 5 MB). C3: score validation (ints 0-150/period, <=20 periods, sum <=400), bad match skipped and listed. QA: drill `ps` sampler scoped to drill process tree; `db:status` weekly line extracted to `scripts/lib/weekly-status.mjs` with 5 tests.
- [x] Re-review of fix cycle 1. QA: READY (root 115/115, worker 102/102 on throwaway postgres, drill 203/0, CI green; both QA Minors resolved; Sec fixes no regressions; QA rates the 64 KiB masker edge as at most 1 char leaked, Sec reproduced a full-key leak, so Coordinator follows Sec's confirmed repro). Sec: READY WITH CONDITIONS. C1-C3 confirmed fixed (incl. exit/crash/SIGTERM paths); fixture-mode key read can't cause a request or leak. New C4 (Minor): `worker/src/line-mask.js:11` overflow path (>64 KiB with no newline) can split and print a whole key; not reachable today, one-line fix + tests. Notes: R3-2 drill reads real key from `.env` into memory (set `WEEKLY_HL_ENV_FILE` to an empty temp file); R3-3 unterminated text gets glued to the front of the `@@WEEKLY` line. Coordinator: C4 + R3-2 + R3-3 go into fix cycle 2.
- [x] Fix cycle 2/3 (Dev): pushed `f2f6099`, CI green. Root 115/115, worker 107/107 (test DB), drill 203/0. C4: overflow path masks whole buffer first, holds back last (key length − 1) chars; 4 new tests. R3-2: drill passes `WEEKLY_HL_ENV_FILE` = empty temp file. R3-3: `endLine()` flushes pending text + newline before `@@WEEKLY`; unit + CLI tests.
- [x] Re-review of fix cycle 2. QA: **READY** at `f2f6099` (CI green; root 115/115; worker 107/107 on throwaway postgres; drill 203/0; W30 key absent from all logs/outputs/`ingestion_runs.details`; `@@WEEKLY` parsing intact). Sec: **READY** at `f2f6099`. C4 verified (key swept across every cut position, 1 and 2 writes; 300 random-chunking runs identical, nothing dropped/duplicated/leaked); R3-2 and R3-3 verified. Offline tests 0 network attempts. Only cosmetic leftovers; Notes 4-9 optional.
- [x] T5 Security (`docs/reviews/M6/security.md`, at `b3278b8`): READY WITH CONDITIONS. npm audit 0; tests run with outbound network blocked, no attempts; no secrets in history. S1: child self-redaction accepted, conditional on C1. C1 (Minor) key masking is per `write()`, a split write leaks: mask whole lines + test with key only from env file. C2 (Minor) Highlightly client timeout ends at headers and 5 MB limit checked after full read: stalled/huge body can hold tunnel+lock up to 3,600 s or exhaust memory. C3 (Minor) Highlightly scores not range-checked: one bad value overflows SMALLINT and fails the whole schedule update. S2-S5, SQL parameterisation, quota-only-tightens confirmed. 6 Notes. Coordinator: C1-C3 go to Dev in fix cycle 1 (small, in scope) rather than follow-ups.
- [x] T6 Lead (`docs/reviews/M6/lead.md`, at `f2f6099`): **READY**, no Blocker/Major. All 10 plan tasks present; Q1/Q3/Q7/Q9/Q11 conformance confirmed; schema, deps, CI, plist, `backend/`, `frontend/`, `sync.test.js` unchanged. `loadBoxScore` refactor is a straight extraction (same SQL, order, transaction boundaries); `worker/src/index.js` unchanged and imports none of the new modules. All 8 Dev deviations accepted. `pg.Pool` BEGIN/COMMIT: pre-existing, safe today (single live BEGIN, no concurrent ticks), weekly code uses a single `pg.Client`; follow-up, not a merge condition.
- [x] T7 Readiness report (below) -> **Gate 2: waiting on owner merge approval**

### Readiness report (2026-11-03)
**What changed:** PR #7 https://github.com/Jayprox/ai-application-nba/pull/7 (`feat/m6-highlightly-weekly`, code HEAD `f2f6099`). The weekly job now runs Highlightly first: one short NBA.com probe (15 s, no retry), Highlightly schedule pass (update-only), positions (NBA.com best-effort), Highlightly box-score catch-up, NBA.com reconcile when reachable, status. NBA.com blocked = `OK-DEGRADED`, exit 0, "OK with warnings". Quota-guarded Highlightly client: cap 600/run, reserve 1,000 (env can only tighten), rate-limit headers read on every response, clean stop with no partial game. Q11 full-season sweep built but off (`WEEKLY_HL_FULL_SEASON=1` and live remaining > 3,000). M5 guard/lock/backup/tunnel/cleanup unchanged. No schema, migration, dependency, CI or plist change.
**CI:** green on all four jobs (root, worker, backend, frontend) at `f2f6099`. Local: root 115/115, worker 107/107 (test DB), drill 203/0, frontend 32/32.
**Verdicts:** QA READY, Security READY, Lead READY, all at `f2f6099`. 2 of 3 fix cycles used (cycle 1: Sec C1-C3 + 2 QA Minors; cycle 2: Sec C4, R3-2, R3-3). No open Blocker/Major/Minor.
**Disagreement (resolved):** QA rated the masker 64 KiB edge as at most 1 character; Sec reproduced a full-key leak. Coordinator followed Sec's repro; fixed in cycle 2 and both reviewers verified.
**Risks:** tags (arena, national TV, Cup stage, standings, positions) go stale while NBA.com stays blocked; Cup knockout games show as unmatched from mid-December; tip-off follows whichever source answered that week (O2); real Highlightly error shapes and the quota period are unverified (Q5 declined live recording); two rare worker/weekly concurrency races (plan §5) and the pre-existing `pg.Pool` transaction pattern remain.
**Recommendation: READY WITH CONDITIONS** (owner items, not code changes):
1. Accept that merging redeploys the Railway ingestion worker (O1). Live behaviour is unchanged (Lead verified), but the service restarts.
2. After merge, run `npm --prefix worker ci` on the Mac once; otherwise the next Monday run fails at preflight.
3. Keep `WEEKLY_HL_FULL_SEASON` unset until the Highlightly quota period is confirmed (Q3/Q11 on hold).
4. Expect "OK with warnings" every week while NBA.com is blocked.
5. `.env.example` not edited; new flags have defaults and are documented (O3).

**Follow-ups (new ticket, not merge conditions):** live worker transaction on one checked-out connection (`worker/src/sync.js:151`); weekly modules refuse a Pool; classify our own JS errors in NBA.com loaders as `FAIL` not `OK-DEGRADED` (`scripts/lib/nba-best-effort.mjs:36`); remove unused `toHl` (`worker/src/weekly-backfill.js:40`); the two concurrency races from plan §5; Sec optional Notes 4-9.
**Still owner-gated:** merge approval (Gate 2); installing/reloading the weekly plist; enabling the Q11 sweep.

### Approvals
- 2026-11-03 — Owner (Gate 1): "Continue with the Lead's plan." Requirements `docs/requirements/M6-highlightly-weekly.md` approved. Final answers:

| Q | Final answer | Source |
|---|---|---|
| Q1 | Update-only: Highlightly schedule stage updates existing games and reports unmatched matches; it never creates games. | PA default, accepted |
| Q2 | Yes: Highlightly done + NBA.com skipped = exit 0, `OK-DEGRADED`, notification "OK with warnings". Only a Highlightly or database failure is `FAIL`. | PA default, accepted |
| Q3 | Plan upgraded; response header shows `x-ratelimit-requests-limit: 7500` (remaining 7498 at check). **Period still unconfirmed: keep the monthly assumption** (per-run cap 600, reserve 1,000). Keep runtime checks of the rate-limit headers on every response and a clean stop (stage ends, run reports why, no partial-write damage) when remaining would drop below the reserve or the cap is reached. | **Owner** |
| Q4 | Positions stay NBA.com best-effort only; stage always completes (skipped with a warning when blocked). | PA default, accepted |
| Q5 | **Not approved** (owner did not authorise a live recording). No live Highlightly/NBA.com calls; error fixtures (401/429/5xx) are synthetic and labelled as such. Ask the owner again if a named recording session is needed. | Coordinator (constraint holds) |
| Q6 | Window 7 days back, 60 days ahead. | PA default, accepted |
| Q7 | Cap 600 requests per run, reserve 1,000 remaining, pacing 4 req/s. | PA default, accepted |
| Q8 | Try NBA.com best-effort with one short probe; `WEEKLY_NBA=0` disables it. | PA default, accepted |
| Q9 | NBA.com wins when it answered completely; otherwise Highlightly. | PA default, accepted |
| Q10 | Standings rank stays NBA.com-only; app falls back to win % with a note. | PA default, accepted |
| Q11 | **On hold** until the owner confirms the plan period. Once confirmed, approved to run the one-time full-season sweep if more than 3,000 requests remain. Build it behind an explicit opt-in that is off by default and re-checks remaining > 3,000 from the live header before starting. | **Owner** |

**M6 closed:** owner merged PR #7 into `main` (`77b71b6`).

## Mission M7 — Independent permission approver (opened 2026-11-03)

**Mission (owner):** Reduce permission prompts without auto mode. A Claude Code `PermissionRequest` hook calls a small approver that checks each request against a written policy (APPROVAL POLICY v1, owner draft) and answers allow, ask or deny. Uncertain, failed or timed-out = ask (fail closed). The deny list must not be weakened.

**Requirements to cover (owner):** shadow mode first (log approver decision next to the owner's actual answer, no effect on prompts) for at least a week before it may approve anything; a decision log stored outside the repo; a cheap pattern pre-filter before any model call; prompt-injection test cases; a test suite of at least 50 sample requests with expected decisions, including attempts to talk the approver into yes; policy and scripts live outside the repo's agent-writable paths, installed by the owner.

**Constraints:** nothing touches production, Railway, live APIs or `.env`. Agents do not edit settings, hooks or the live policy. Feature branch + PR; owner merges and installs.

**Path:** Feature (full workflow). PA (incl. Claude Code docs check on PermissionRequest hooks and headless model calls) -> Gate 1 -> Lead plan -> Dev -> CI -> QA + Sec (Sec required: permission and security tooling, input parsing, prompt injection) -> Lead review -> readiness report -> Gate 2.

**Branch:** `feat/m7-permission-approver`.

### Tasks
- [x] T0 Docs check (claude-code-guide, 2026-11-03): no "ask" output value (ask = no decision, empty stdout, exit 0); timeout/crash/bad exit/invalid output fall to the normal prompt, never allow; default command-hook timeout 600 s (set short); in `-p`/background subagents no decision = deny; payload has no git branch and no `tool_use_id`; no hook reports the human's answer (shadow mode must infer it from PreToolUse/PostToolUse); `prompt` hook type cannot deny; headless `claude -p --tools "" --json-schema --bare` possible, but `--bare` needs an API key. Unconfirmed: Edit/Write/WebFetch payloads, transcript recording of denials, `async` on PermissionRequest, foreground subagents.
- [x] T1 PA: `docs/requirements/M7-permission-approver.md` (DRAFT). 13 stories, 16 policy ambiguities (A1-A16, safer reading by default), 14 owner questions, deny list unchanged (policy verbatim in Appendix A). Coordinator edits: removed the `enforce-allow` stage and rewrote Q11 so deny is always hard once enforcing (the PA's default let deny fall back to ask); added a note to Q8 (model-may-never-allow makes the model nearly useless for fewer prompts; options a/b/c).
- [x] Gate 1: owner approved 2026-11-04 (answers below and in requirements section 7.0)
- [x] T2 Lead plan: `docs/plans/M7-permission-approver.md`. Step A live check (Claude Code 2.1.318, 5 nested `claude -p` haiku runs in a scratch dir with inline `--settings` hooks, US$0.0136, nothing written): Write payload = `file_path` + full `content`; Edit = `file_path`, `old_string`, `new_string`, `replace_all`; NotebookEdit = `notebook_path`, `cell_id`, `new_source`, `edit_mode`; no `tool_use_id`; PreToolUse has the identical input; no PostToolUse after a denial; transcript records denials (`is_error`, `toolDenialKind`, `permissionDecision {decision, source, ...}`) and owner approvals as `source: user_temporary|user_permanent`, hash-matchable 4/4. Interactive "No" marker UNCONFIRMED (owner self-check after install). Design: `tools/approver/`, Node built-ins only; pre-filter is the only decider; model = detached log-only worker for undecided requests, direct HTTPS with Keychain key read via `/usr/bin/security` into memory; hook timeout 5 s; shadow report from the transcript; CI via root `package.json` test glob (no workflow edit). 9 tasks T1-T9. Flags F1-F12 for the owner. Coordinator addition for Dev: deny `chflags`/`xattr` on protected paths (the `uchg` flag is removable without sudo).
- [ ] Owner decision on plan flags F1-F12 (waiting)
- [ ] T3 Dev: PR + CI
- [ ] T4 QA, T5 Security (parallel)
- [ ] T6 Lead review
- [ ] T7 Readiness report -> Gate 2

### Approvals
- 2026-11-04 — Owner (Gate 1): "Approved." Q8 (b) model logs only, decides nothing. Q2 dedicated API key in macOS Keychain only (never `.env`, never an exported variable, never printed or logged), US$1/day script cap plus a low Console spend limit; owner creates the key after the code exists. Q9 acts only in this repo, silent elsewhere. Q10 safer readings as proposed; `gh pr comment` is ask if the repo is public. Q1 default (Bash, Edit, Write, NotebookEdit). Q12 owner edits settings personally. Lead to verify Edit/Write payloads and transcript-denial behaviour before design.
