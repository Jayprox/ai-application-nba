# Coordinator Status Log

## Mission M1 — Onboard repo + CI test workflow (opened 2026-11-01)

**Mission (owner):** Onboard this repo, then add a GitHub Actions workflow that runs the tests for root, backend, worker, and frontend on pull requests. Use a Postgres service container for tests that need a database, no secrets or API keys, and no lint. Read PLATFORM.md and docs/ first and build on them rather than replacing them.

**Path:** Existing app, first run (Lead onboard) -> Small change + Security (CI config) -> QA + Sec -> Lead review -> readiness report.
PA skipped: requirements are concrete and owner-specified.

**Branch:** `chore/ci-workflow` (one PR for onboarding docs + workflow).

**Note:** `docs/architecture.md` already exists; on macOS's case-insensitive FS it *is* `docs/ARCHITECTURE.md`. It is extended in place, not replaced.

### Tasks
- [x] T1 Lead: onboard — extended `docs/architecture.md` (+89 lines, §9, nothing removed), created `docs/STANDARDS.md`, plan `docs/plans/M1-ci-test-workflow.md`
- [ ] T2 Dev: plan tasks T1 (fix broken worker test fixture), T2 (workflow), T3 (docs); open PR, get CI green
- [ ] T3 QA review
- [ ] T4 Security review
- [ ] T5 Lead review
- [ ] T6 Readiness report -> GATE 2 (owner merge approval)

### Approvals
- 2026-11-01 — Owner: mission text accepted as the requirement (no PA).
- 2026-11-01 — Owner: **D1 = Option A** (backend CI runs schema apply + constraint tests + empty-DB-safe files league/names/rankings/ratelimit). Fixture DB (B) deferred to a future M2.
- 2026-11-01 — Owner: fix the broken worker test fixture (plan T1) in this PR.

### Blockers
- (none)
- ~~**D1:**~~ resolved, Option A. the backend test suite needs real NBA.com data, which CI can't load. Plan recommends Option A (run only the backend test files that are valid on an empty DB) now, and Option B (a committed fixture DB) as follow-up mission M2.

### Findings from onboarding
- `worker/test/players.test.js:31-32` is already broken on `main` (violates `games_check6`). It's hidden locally because the DB suite skips without `WORKER_TEST_DATABASE_URL`. Plan T1 fixes the fixture only.
