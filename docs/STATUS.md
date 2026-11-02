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
