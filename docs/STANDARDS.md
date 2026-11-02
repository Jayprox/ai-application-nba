# Standards: Chalk That Hardwood

Conventions this repo already follows, written down on 2026-11-01 during
the AI-team onboarding. They describe what the code does now. They are not
new rules. Workflow and authority are in `CLAUDE.md`; architecture
decisions are in `PLATFORM.md` and `docs/architecture.md`; the API contract
is in `docs/api.md`. Those files are not repeated here.

## 1. Code

- **Plain JavaScript, ES modules everywhere** (`"type": "module"` in all
  four `package.json` files). No TypeScript (PLATFORM.md §3). Root scripts
  use `.mjs`; backend and worker use `.js`; frontend uses `.js`/`.jsx`.
- **Four independent packages** (`/`, `backend/`, `worker/`, `frontend/`),
  each with its own `package.json` and committed `package-lock.json`.
  **No code is shared across packages.** When a helper is needed in two
  places it is copied, and a test checks the copies agree (for example
  `backend/test/names.test.js`, PLATFORM.md §3).
- Style as written (no formatter is configured): 2-space indent, single
  quotes, semicolons, dense one-line helpers are fine. Comments explain
  *why*, often citing the real case (a game, a player, a date) that drove
  the rule.
- **Few dependencies.** The backend uses express, pg, redis, jsonwebtoken,
  bcryptjs and cors; the worker and root use pg only; the frontend uses
  React 19, React Router 7, Vite, Tailwind v4 and Vitest. Adding a
  dependency needs a Security review (CLAUDE.md).
- **Domain rules that are not up for debate** (see `docs/architecture.md`):
  no predictive math; splits are tagged when data is written, not computed
  at query time; name matching never guesses (an ambiguous name goes to
  `manual_review`); the worker never overwrites `source = 'nba_stats'`
  rows; the LLM never writes a number.
- **Schema changes:** edit `db/schema.sql` *and* add
  `db/migrations/NNN_<slug>.sql` (the schema file already includes every
  migration). Add negative cases to `db/tests/schema_constraints.sql` for
  new CHECKs.
- **Config:** environment variables only. `.env` and `.env.*` are
  gitignored; `.env.example` and `frontend/.env.example` list the names.
  Never commit secrets.

## 2. Tests

- **Runners:** `node:test` + `node:assert/strict` for root, backend and
  worker; Vitest (`describe`/`it`/`expect`, jsdom) + Testing Library for the
  frontend.
- **Where tests go:** root `scripts/lib/<name>.test.mjs`; backend and worker
  `test/<name>.test.js` (fixtures in `worker/test/fixtures/`); frontend
  next to the source file, `<Name>.test.jsx` / `<name>.test.js`.
- **Pin real numbers.** Tests check published NBA.com (or
  Basketball-Reference) values and recorded vendor responses, not numbers
  our own code produced. Test names state the real fact being checked.
- **No real network calls in `npm test`.** Stub `fetch` or use recorded
  fixtures; inject a fake LLM. Anything that calls a paid or live API (for
  example `npm run ask:eval`) stays outside `npm test`.
- **Database tests:**
  - backend: real Postgres via `TEST_DATABASE_URL` (falls back to
    `DATABASE_URL`) with real data loaded; tests clean up their `test_*`
    users and keys. Tests that need data that may be missing skip with a
    reason (`t.skip('no games loaded')`).
  - worker: only against a localhost database whose name contains `test`
    (`WORKER_TEST_DATABASE_URL`); otherwise skipped with a reason.
- How to run each suite and what it needs: `docs/architecture.md` §9.3.
- Every change keeps all four suites green. A bug fix comes with a test that
  would have caught it (see `scripts/lib/sources.test.mjs` for an example).
- No lint step exists yet. Do not add one as a side effect of other work.

## 3. Branches and pull requests

- `main` is protected and auto-deploys to Railway (`docs/architecture.md`
  §7.5). Never push to it; all changes go through a branch and a PR.
- Branch names seen in the repo: `chore/<slug>` (for example
  `chore/add-eng-team`, `chore/ci-workflow`) and older phase branches.
  Use `feat/<slug>`, `fix/<slug>` or `chore/<slug>`. Note:
  `.claude/settings.json` pre-approves `git push` only for `feat/*` and
  `fix/*`, so pushing a `chore/*` branch prompts for approval.
- One PR per plan task or a small group of related tasks. The PR
  description links the requirement and plan ids.
- Merging requires CI green and owner approval
  (CLAUDE.md rules 6-7).

## 4. Commits

- Subject: a short plain-English sentence with no prefix convention, often
  `Area: what changed` (for example `Worker: auto-link unique exact-name
  players ...`, `Fix weekly run (schedule wrote final with no score)`).
  Use the imperative or a noun phrase, with no trailing period.
- One logical change per commit. Doc updates go in the same commit as the
  change that caused them.
- Agent-made commits end with the attribution trailer the Coordinator
  gives.

## 5. Docs

- After every real design decision or deviation, update
  `docs/architecture.md` in the same change. `PLATFORM.md` is the
  cross-sport playbook and is not edited for app-specific decisions.
- API contract changes update `docs/api.md` (the iOS app depends on it).
- User-visible commands go in the README tables.
