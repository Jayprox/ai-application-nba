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

