# M1: CI test workflow (GitHub Actions)

- **Status:** Approved for implementation. **D1 resolved = A** (owner decision, recorded in `docs/STATUS.md`). T1 approved for this PR.
- **Requirement source:** the owner's mission text (as relayed by the Coordinator, 2026-11-01):
  "Add a GitHub Actions workflow that runs the tests for root, backend,
  worker, and frontend on pull requests. Use a Postgres service container
  for tests that need a database, no secrets or API keys, and no lint."
  No `docs/requirements/` file exists. The Coordinator should record this
  mission as the approved requirement in `docs/STATUS.md`.
- **Branch:** `chore/ci-workflow` (already exists; the Developer commits this plan and the onboarding docs with the change).
- **Reviews:** QA (always) **and Security** (CI config and supply chain: third-party actions, token permissions, workflow triggers).

## 1. What was found (evidence)

All checks were run locally on 2026-11-01 with Node 26.11 and a throwaway `postgres:18` Docker container. Full table: `docs/architecture.md` §9.3.

| Suite | Needs DB | Env | Applies schema itself | External calls / keys | Local result |
|---|---|---|---|---|---|
| root `npm test` | no | none | n/a | none (fetch stubbed) | 31/31 pass |
| root `npm run db:apply` (schema + `db/tests/schema_constraints.sql`) | yes, empty | `DATABASE_PUBLIC_URL` | it *is* the schema apply | none | PASSED |
| backend `npm test` | **yes, with real NBA data** | `TEST_DATABASE_URL` (else `DATABASE_URL`) | **no**, needs `db:apply` first | none (fake LLM, in-memory cache; `JWT_SECRET` auto-generated) | empty schema: 21 pass / 44 fail / 3 skip |
| worker `npm test` | optional | `WORKER_TEST_DATABASE_URL` (host must be localhost/127.0.0.1, DB name must contain `test`) | **yes**: `DROP SCHEMA public CASCADE` + `db/schema.sql` | none (recorded fixtures) | no DB: 17 pass / 6 skip. With DB: 22 pass / **1 fail** |
| frontend `npm test` | no | none | n/a | none (fetch mocked) | 32/32 pass |

Key facts:

1. **No test needs a secret or API key.** `ANTHROPIC_API_KEY`, `HIGHLIGHTLY_API_KEY` and `ODDS_API_KEY` are not read on any test path (`backend/test/ask.test.js:15` injects `fakeLlm`; `worker/test/sync.test.js:46,102` use fixture dirs). `npm run ask:eval` is the only real-model call and is not part of `npm test`.
2. **The backend suite cannot pass on an empty database.** `backend/test/helpers.js:40-44` (`playerId`) throws when LeBron James / Ja Morant are missing, so every test in `ask`, `props` and `query` fails in its `before` hook. `browse.test.js` and `auth.test.js:50` expect 30 teams. The data can only come from NBA.com, which blocks cloud IPs (`docs/architecture.md` §3.1), so a CI runner cannot load it, and no data fixture is committed. Files that pass on an empty schema: `league`, `names`, `rankings` (3 data tests skip themselves), `ratelimit` (12 pass, 3 skip).
3. **A worker test is already broken on `main`:** `worker/test/players.test.js:31-32` inserts `status 'final'` with no `home_score`/`away_score`, which `games_check6` (`db/schema.sql:152`) rejects. Error: `new row for relation "games" violates check constraint "games_check6"`. It was added in commit `f0e6dd3` and stays hidden locally because the suite is skipped without `WORKER_TEST_DATABASE_URL`. CI would turn red as soon as the worker DB tests are on.
4. **Install:** each package has its own lockfile (v3, all from registry.npmjs.org). No workspaces. `npm ci --ignore-scripts` succeeded from lockfile alone for all four packages (root 14 pkgs, backend 109, worker 14, frontend 109).
5. **Node:** root/backend/worker `>=20`, frontend `>=22.12` (Vite 8). Production runs Node 22 (README stack table). **Choice: Node `22.x`, no matrix.** It meets every `engines` field and matches production. Node 22 is in maintenance LTS until 2027-04, so moving CI and Railway to 24 together is a later task.
6. **Postgres:** production is Postgres 18 (`docs/architecture.md` §8). **Choice: `postgres:18` service image.** Schema and constraint tests passed on 18.6 locally.
7. `db:apply` reads `DATABASE_PUBLIC_URL` from the process env when there is no `.env` (`scripts/lib/env.mjs:6-17`) and turns TLS off for localhost. `db/schema.sql` already contains every migration, so `db:migrate` is not needed.

## 2. Decision for the owner

**D1: What should the backend job run, given its suite needs real NBA.com data that CI can't load?** (This changes test scope and test-data architecture, so it needs the owner.)

| Option | What CI runs for backend | Cost / risk |
|---|---|---|
| **A (recommended for M1)** | Schema apply + constraint tests, then only the backend test files that are valid on an empty schema, listed explicitly in the workflow: `test/league.test.js test/names.test.js test/rankings.test.js test/ratelimit.test.js`. The workflow comment and `docs/architecture.md` §9.3 state that the NBA.com number checks still run only locally against loaded data. | No source changes. About 12 of 68 backend tests run in CI (auth, query and props are not covered). The explicit list has to be kept up to date as new files are added. |
| B (follow-up mission, M2) | The full backend suite against a **committed, trimmed real-data fixture** (for example a `pg_dump` of the seed plus the 2003-04 and 2019-20 seasons), produced by JD from his Mac and restored in CI. | Real coverage. But it is a new test-data artifact (probably a few MB compressed), needs a script to regenerate it, and needs JD's Mac to produce it. Too big for M1. |
| C | Change backend tests so data-dependent tests skip when data is missing (move `playerId` out of `before`, guard the 30-team checks). Then run the whole suite in CI. | Source/test changes outside the CI scope. CI would be green while silently skipping the NBA.com checks, so it can mask regressions. Not recommended by itself. |
| D | Run the backend suite against the real Railway DB | **Rejected**: it needs a secret, which the mission forbids, and the tests write `test_*` users into the database. |

Recommendation: **A now, B as a separate mission M2.** If the owner does not choose, the Developer implements A (it is the only option that meets "no secrets" without source changes) and the Coordinator flags it in the readiness report.

Routine decisions taken by the Lead (inside the mission): Node 22.x, Postgres 18, separate jobs per package, fixing the broken worker test (T1).

## 3. Approach

One workflow file, `.github/workflows/test.yml`, with four independent jobs that run in parallel. Each job has `defaults.run.working-directory` set to its package. Postgres service containers go only on the `backend` and `worker` jobs, each with its own database. The two must not share one: the worker suite drops `public`.

Sketch (the Developer finalises it; versions must be checked against the actions' release pages at implementation time):

```yaml
name: Tests
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: tests-${{ github.ref }}
  cancel-in-progress: true
jobs:
  root:        # npm ci && npm test            (no DB)
  frontend:    # working-directory frontend; npm ci && npm test (no DB)
  worker:      # services.postgres (postgres:18, POSTGRES_DB=worker_test, health-cmd pg_isready, port 5432:5432)
               # env WORKER_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/worker_test
               # npm ci && npm test
  backend:     # services.postgres (postgres:18, POSTGRES_DB=backend_test, healthcheck)
               # step 1 (repo root): npm ci && npm run db:apply   with DATABASE_PUBLIC_URL=postgres://postgres:postgres@localhost:5432/backend_test
               # step 2 (backend/): npm ci && node --test --test-concurrency=1 <D1 file list>
               #                    with TEST_DATABASE_URL=same URL
```

- Each job: `actions/checkout@v6` (`persist-credentials: false`), `actions/setup-node@v6` with `node-version: 22.x`, `cache: npm`, and `cache-dependency-path` set to that package's lockfile (backend lists both `package-lock.json` and `backend/package-lock.json`).
- `npm ci` (strict lockfile). `--ignore-scripts` is optional; Sec decides.
- `timeout-minutes: 10` per job.
- The Postgres password is a throwaway literal for a disposable container. It is not a secret, and a YAML comment should say so to head off false positives in review.
- No `secrets.*`, no `pull_request_target`, no lint step.

## 4. Tasks (in order, each one PR-sized; all can go in one PR)

| # | Task | Files | Definition of done |
|---|---|---|---|
| T1 | Fix the broken worker fixture: give the `'final'` games scores (for example `home_score, away_score` = `100, 90`) in `mk()`. | `worker/test/players.test.js` (lines 31-32) | `WORKER_TEST_DATABASE_URL=postgres://...@localhost:<port>/worker_test npm test` in `worker/`: 23/23 pass, 0 skip. Assertions unchanged. |
| T2 | Add `.github/workflows/test.yml` as in §3, with the backend file list from D1. | `.github/workflows/test.yml` (new) | YAML is valid; on the PR, all four jobs run and pass; worker job log shows 0 skipped; backend job log shows `Constraint tests: PASSED`. |
| T3 | Docs: replace "CI: none yet" in `docs/architecture.md` §9.3 with a pointer to the workflow and what it does *not* cover (D1). Add one line to the README "Tests" section. Commit the onboarding docs (`docs/architecture.md` §9, `docs/STANDARDS.md`, this plan). | `docs/architecture.md`, `README.md`, `docs/STANDARDS.md`, `docs/plans/M1-ci-test-workflow.md` | Docs match the merged workflow. Existing sections 1-8 are unchanged. |

## 5. Acceptance criteria (for QA and Sec)

1. Triggers: `pull_request` (all branches) and `push` to `main`. No `pull_request_target` and no `workflow_run`.
2. Top-level `permissions: contents: read`, and no job widens it.
3. Four jobs: `root`, `backend`, `worker`, `frontend`. Each runs that package's tests and fails the workflow on a test failure.
4. Postgres service (`postgres:18`) only on `backend` and `worker`, with a `pg_isready` health check, a separate database per job, and a worker DB name containing `test` on `localhost`.
5. Backend job applies the schema via `npm run db:apply`, and its constraint tests must pass.
6. No `secrets.*` and no API-key env vars anywhere in the file. `grep -n 'secrets\.\|API_KEY' .github/workflows/test.yml` returns nothing.
7. Every third-party action is pinned to a released version (major tag at minimum; Sec may require a full commit SHA with a version comment).
8. npm cache through `setup-node` with per-package `cache-dependency-path`. Installs use `npm ci`.
9. Node `22.x` in every job.
10. No lint step. No changes to application source; test change limited to T1.
11. Worker job reports 0 skipped tests (proof that the DB suite actually ran).

## 6. Test strategy

- The Developer runs T1 locally against a throwaway `postgres:18` container (commands in `docs/architecture.md` §9.3) and, optionally, the workflow with `act`.
- The real check is the workflow run on the PR itself: QA reads each job's log for pass/skip counts.
- QA negative check (optional): a throwaway commit that breaks a root test shows the `root` job red. Revert it before merge.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Backend coverage in CI is small (D1-A) and can be mistaken for full coverage | The workflow comment and the docs state the gap; M2 (fixture DB) is proposed. |
| Explicit backend file list goes stale when new test files are added | STANDARDS/architecture note; reviewers check new backend test files against the list. Option B removes the list. |
| Timing-sensitive tests (auth brute-force sliding window, about 3 s) are flaky on a shared runner | Auth is not in the D1-A list. If B or C adds it later, watch for flakes. |
| `actions/*` major versions change; old Node runtimes are being removed from runners | Pin current majors (v6) and let Sec decide on SHA pinning. Dependabot for actions is a possible follow-up (needs approval, not in scope). |
| `postgres:18` tag moves between minor versions | Acceptable (production also tracks 18). Pin `18.x` if QA sees drift. |
| `.claude/settings.json` pre-approves pushes only for `feat/*` and `fix/*`, not `chore/*` | Pushing `chore/ci-workflow` will prompt the owner. This is expected and needs no config change. |

## 8. Out of scope

Lint/format, deploy/CD, Dependabot, the fixture database (M2), changing Railway's Node version, and branch-protection settings (the owner sets "require status checks" in GitHub after merge).
