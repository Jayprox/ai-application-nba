# Security Review: M1, CI test workflow (PR #2)

VERDICT: READY

Nothing blocks the merge. The workflow is minimal and hardened, and this PR adds no secrets. One older exposure is already on `main` (Finding 1). It is not caused by this PR, but the owner should decide on it.

## 1. Scope and tools

- **Branch:** `chore/ci-workflow`. **HEAD:** `89c47913920d1cc7a7c38f81bc8232addb6840d6`, which matches the PR #2 head. Base: `main`.
- **Diff:** `git diff main...chore/ci-workflow`. It changes 7 files: `.github/workflows/test.yml`, `README.md`, `docs/STANDARDS.md`, `docs/STATUS.md`, `docs/architecture.md` (+97 lines), `docs/plans/M1-ci-test-workflow.md` and `worker/test/players.test.js`.
- **Checked against:** plan `docs/plans/M1-ci-test-workflow.md` §3 and §5.
- **Tools run:**
  - `gh api repos/<action>/tags` and `gh api repos/<action>/commits/<sha>`, to verify the action SHAs.
  - `gh pr checks 2`: all 4 jobs pass.
  - `npm audit --package-lock-only` in the root, backend, worker and frontend packages.
  - A lockfile scan (Python) for `hasInstallScript`, `resolved` sources and `integrity` fields.
  - A regex secret scan over `git log --all -p`.
  - A history check for `.env` files.
- **Not installed:** gitleaks, semgrep, trivy, actionlint, zizmor. The regex scan stands in for gitleaks, so its coverage is lower.

## 2. Workflow checks (`.github/workflows/test.yml`)

| Check | Result | Evidence |
|---|---|---|
| Triggers | OK | `on: pull_request` and `push: branches: [main]` (lines 12-15). No `pull_request_target`, `workflow_run` or `workflow_dispatch`. Fork PRs get a read-only token and no secrets. |
| Token permissions | OK | Top-level `permissions: contents: read` (lines 17-18). No job widens it. |
| `persist-credentials` | OK | `false` on all 4 checkout steps. The token is not left in `.git/config`. |
| Action pinning | OK, verified | `actions/checkout@3d3c42e5…ba90b1`: upstream tag `v7.0.1` (and `v7`) points to this SHA, and the commit message is "prep v7.0.1 release (#2531)". `actions/setup-node@949feb24…15c1`: upstream tag `v7.1.0` (and `v7`) points to this SHA, and the commit message is "…package.json from 7.0.0 to 7.1.0 (#1635)". Only first-party `actions/*` are used. (`git/ref/tags/<tag>` returned 404 through `gh`, so I checked with the tags list and commits endpoints instead.) |
| Secrets / API keys | OK | No `secrets.*` and no `*_API_KEY`. Plan §5 AC6 holds. |
| Script injection | OK | No `${{ github.* }}` or any other expression in a `run:` step. The only expression is `${{ github.ref }}` in `concurrency.group`, which is not run by a shell. |
| Postgres password | OK (Note) | The `postgres`/`postgres` literal is used only for a throwaway service container on an ephemeral runner. A comment marks it as not a secret. It is not a real credential. |
| Ports | OK | `5432:5432` binds on the runner VM, which each job gets to itself and is destroyed afterwards. Steps reach the database at `localhost`, so they need this binding. |
| Service image | Note (Finding 2) | `postgres:18` is pinned by tag, not by digest. |
| npm supply chain | OK | `npm ci` installs from the lockfile only (Finding 3). |
| Cache poisoning | OK | The setup-node npm cache only stores `~/.npm` tarballs, and `npm ci` checks each one against the lockfile `integrity` hash. Caches written by a fork PR run are scoped to `refs/pull/N/merge`, so `main` and other PRs cannot read them. Risk is low. |
| Concurrency | OK (Note) | `tests-${{ github.ref }}` with `cancel-in-progress: true`. PR runs are isolated per PR. On `main`, a newer push cancels the run still in progress. That only affects availability, not security. |
| Timeouts | OK | `timeout-minutes: 10` on every job. |
| No lint | OK | No lint step. |

## 3. Findings

1. **Minor (already on `main`, not added by this PR).** Location: `docs/architecture.md:698`, and in history since commit `dd58399`.
   - **What:** The public TCP proxy hostname and port of the production Railway Postgres are committed. The repo is **PUBLIC** (`gh repo view` reports `visibility: PUBLIC`). The PR's hunk header shows this line as context but does not add it. Nearby lines (around 690-696) also name the production backend and web hostnames, which are public by nature. No password or connection string appears with them.
   - **Impact:** Attackers do not have to discover the database. They can go straight to brute-forcing credentials or probing for Postgres vulnerabilities against an internet-exposed database. I am highly confident the exposure is real. Exploitability depends on password strength, which I did not test and will not test.
   - **Fix (owner decision, separate change):**
     - Replace the hostname and port in the doc with a placeholder such as `<proxy>.proxy.rlwy.net:<port>`.
     - Rotate the Railway TCP proxy endpoint so the old one is dead. History keeps the old value, so rotation is the real fix.
     - Confirm the Postgres password is strong. Disable the public proxy when backfills are not running.

2. **Note.** Location: `.github/workflows/test.yml:63,94`.
   - **What:** `image: postgres:18` is a mutable tag, while the actions are pinned by SHA.
   - **Impact:** Low. It is an official Docker library image, it runs only in CI with no secrets, and it gets no write token.
   - **Fix (optional):** Pin `postgres:18@sha256:<digest>`, or accept the tag as is.

3. **Note: `--ignore-scripts` is not needed today.**
   - **What:** None of the four lockfiles contains a package with an install script, except `fsevents` in `frontend/package-lock.json`. That package is optional and macOS-only, so `npm ci` skips it on `ubuntu-latest`. Every entry resolves from `registry.npmjs.org` and has an `integrity` hash. No `package.json` has a `preinstall`, `install`, `postinstall` or `prepare` script.
   - **Impact:** Even if a dependency later adds a malicious install script, it would run with a read-only token and no secrets.
   - **Fix (optional):** Add `--ignore-scripts` to `npm ci`. It costs nothing because nothing currently depends on install scripts.

4. **Note (already present, not changed by this PR).** These are known vulnerabilities in the dependency trees. The PR does not modify any lockfile.
   - **Backend:** `body-parser` (high, DoS) and `qs` (moderate, DoS). Both are runtime dependencies of the production API.
   - **Frontend:** `vite`, `vitest`/`@vitest/mocker`, `undici` and `source-map-js` (3 high, 2 moderate). These are build and test tooling. `frontend/server.js` has zero dependencies, so exposure is limited to developer machines and CI.
   - **Fix:** Track as a follow-up (`npm audit fix` in `backend/` first). Out of scope for M1.

5. **Note.** Location: GitHub repo settings, outside the diff.
   - **What:** Because the repo is public, fork PRs can run this workflow.
   - **Fix:** Keep the default "Require approval for first-time contributors" (or stricter) under Settings → Actions. That limits runner abuse such as crypto-mining. With read-only scope and no secrets, a fork PR has nothing else to steal.

## 4. Docs, test and `.env`

- **Added docs and README:** These are `docs/STANDARDS.md`, `docs/STATUS.md`, the `docs/plans/M1-ci-test-workflow.md` plan, the `docs/architecture.md` §9 addition and `README.md`.
  - They mention variable *names* only: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `HIGHLIGHTLY_API_KEY`, `ODDS_API_KEY`, `JWT_SECRET`.
  - The only connection strings are the throwaway `postgres:postgres@localhost` ones.
  - `*.railway.internal` appears only as a generic pattern.
  - No secret values, real connection strings or new internal hostnames.
- **`worker/test/players.test.js`:** The change only edits a fixture. The SQL adds literal scores `100, 90` and swaps a team-ID constant. Values still go through `$n` parameters, and the interpolated `${HOU}`/`${MEM}` are test constants. No secrets, no injection surface.
- **History scan:** The only credential-shaped strings are deliberate fake fixtures (`SECRETPW` against `example.com`, `db.invalid` and `10.0.0.5`) and a `choose-a-strong-one` placeholder. I found no real tokens or keys. Confidence is moderate because gitleaks was not run.
- **`.env`:** Not tracked. `.gitignore` excludes `.env` and `.env.*`. In all history, the only env files ever added are `.env.example` and `frontend/.env.example`.

## 5. Dependency review summary

- **Dependencies:** This PR adds or changes no npm dependency, and no lockfile is modified.
- **New third-party code:** Two GitHub Actions, both first-party (`actions/checkout` v7.0.1 and `actions/setup-node` v7.1.0), both pinned to full SHAs that I verified against upstream tags. One container image, `postgres:18` (official, pinned by tag).
- **Audit:** No new vulnerabilities. The existing ones are listed in Finding 4.

## 6. Verdict

VERDICT: READY

- The workflow meets every security requirement in the plan:
  - no secrets or API keys
  - no `pull_request_target`
  - least-privilege token
  - no credentials left in `.git/config` (`persist-credentials: false`)
  - SHA-pinned actions
  - no lint
- CI is green on the PR head.
- Findings 2-5 are optional hardening or follow-ups.
- Finding 1 is not caused by this PR and does not block it. It is a real exposure in a public repo, and the owner should decide on it soon.
