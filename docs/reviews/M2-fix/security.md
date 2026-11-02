# Security Review: M2-fix (PR #3, redact Railway Postgres proxy host)

## 1. Scope and tools
- Branch `fix/redact-railway-proxy-host`, head `31c78ebbfd3b5dc53818e970bbc182188e392ff7` (matches the PR's headRefOid). Base `main` @ `2c99823`.
- Diff: `docs/architecture.md` only, +4/-2. CI on the PR: root, frontend, worker, backend all SUCCESS.
- Tools: `git diff`, `git log --all -S/-p`, `grep -rnIiE` over the working tree (excluding `.git` and `node_modules`), `gh pr view`. `gitleaks`, `trufflehog`, and `semgrep` are not installed, so none were run. No dependency changes.
- Patterns searched: the real host and port from `main:docs/architecture.md:698`, `rlwy.net`, `railway.app`, `railway.internal`, `postgres://`, `postgresql://`, `postgres+*://`, `PGPASSWORD`, `password[=:]`, and `.env*` files in the index and in history.
- Every grep masked the matched values. This report doesn't repeat any of them.

## 2. Findings

1. **Note: the diff is clean.** Verified.
   - Location: `docs/architecture.md:698-701`.
   - Evidence: the real `*.proxy.rlwy.net:<port>` is replaced with `<railway-public-host>:<port>`. The new wording says the proxy was removed on 2026-11-01 and the password rotated, and explains how to re-add a proxy.
   - Impact: the new text discloses no new host, port, credential, or variable value. Saying a rotation happened is low-sensitivity operational information. Fine for this repo.

2. **Note: the current tree has no real proxy host, port, or credentials.** Verified.
   - The real hostname and port appear nowhere in tracked files.
   - The only `rlwy.net` mentions are generic patterns: `scripts/lib/env.mjs:29` (`*.proxy.rlwy.net:PORT`) and `docs/reviews/M1/security.md:46` (`<proxy>.proxy.rlwy.net:<port>`).
   - The only `postgres://` URLs are local CI service credentials: `.github/workflows/test.yml:69,80,101,111,112` (localhost throwaway containers) and placeholders in `docs/plans/M1-ci-test-workflow.md`.
   - Only `.env.example` and `frontend/.env.example` are tracked, and both have empty values. `.gitignore` excludes `.env` and `.env.*`.
   - The `password` hits are test code that uses random or dummy values, plus usage text in `backend/scripts/create-user.js`.

3. **Note: public app hostnames remain on purpose.**
   - Locations: `README.md:7,182`, `docs/architecture.md:692-693`, `docs/vibe-coding-checklist.md:397`.
   - These are the public HTTPS service domains for web and backend-api (`*.up.railway.app`). They serve the app, are already public, and don't reach the database. No action needed.

4. **Minor: PR #3's description re-publishes part of the redacted value.** Confirmed.
   - Location: the PR #3 body, "Verified:" line.
   - The body quotes a grep command that contains a distinctive fragment of the old proxy hostname plus the full old port number.
   - Impact: low, because the proxy has been removed and the password rotated (owner-asserted). It still defeats the purpose of the redaction and makes the old value easy to find.
   - Fix: edit the PR body to remove the literal fragment and port. For example, say "grep for the old host and port returns zero hits."

5. **Minor (conditional): the untracked QA report also contains the fragment and port.** Confirmed.
   - Location: `docs/reviews/M2-fix/qa.md:11`. The file is untracked right now.
   - The QA evidence row quotes the same grep, with the old hostname fragment and the port.
   - Impact: if the file is committed as-is, the value lands back in the current tree of a public repo, which undoes this PR.
   - Fix: before committing, the Coordinator or QA should replace the literals with a description such as "the old host label and port". I did not edit it, since it isn't my artifact.

6. **Note: the old value is still in git history. A history rewrite is not warranted.**
   - Evidence:
     - The real host:port was introduced in `dd58399` (on `main`, pushed publicly) and removed by `31c78eb`. `git log --all -p` shows it 3 times, and only as a bare host:port.
     - No credentialed URL with the real host appears anywhere in history. The only credentialed URLs in history point to localhost, `*.invalid`, `*.example.com`, or `10.0.0.5`, or use the fixture in item 7.
   - Rationale:
     - Only a network endpoint leaked, never the password.
     - The owner reports the proxy is removed (that endpoint is dead) and the password rotated. Any new proxy gets a new host and port.
     - Rewriting `main` means force-pushing a protected branch, invalidates every clone and SHA referenced in docs and reviews, and does not purge GitHub forks, PR diffs, caches, or third-party mirrors.
     - The cost outweighs the near-zero residual benefit. Confidence: high, assuming the owner's statement about removal and rotation is accurate. I could not verify it.
   - Recommendation: the owner should confirm in the Railway dashboard that no TCP proxy is listed on the Postgres service and that `DATABASE_PUBLIC_URL` and `DATABASE_URL` resolve to the new password. If a proxy is re-added for backfills, remove it afterwards, and don't write the new host:port in any tracked file.

7. **Note: a fake Railway-style test fixture exists on a local branch only.**
   - Location: commit `8830918` on local branch `chore/hardwood-agent-setup`, file `backend/test/dbguard.test.js:25`. The file is not on `main`, not on this PR, and not on the remote.
   - The URL uses host `abc.proxy.rlwy.net`, the same port number as the old proxy, and an all-uppercase placeholder word as the password. This is clearly a synthetic guard-test fixture, not a credential.
   - No action needed now. Because it reuses the old proxy port, redact the port before that branch is ever pushed. Secret scanners may also flag it.

## 3. Dependency review
No dependency, lockfile, or config changes in this PR. Not applicable.

## 4. Verdict
VERDICT: READY WITH CONDITIONS

The PR removes the real host:port, adds nothing sensitive, and the current tree is clean. Given the owner-asserted proxy removal and password rotation, leaving the value in history is acceptable, and a history rewrite is not recommended. Conditions:
- (a) Scrub the old hostname fragment and port from the PR #3 description (finding 4).
- (b) Do not commit `docs/reviews/M2-fix/qa.md` until its line 11 is redacted (finding 5).
- (c) The owner confirms the proxy removal and rotation in Railway (finding 6).

## Handoff
- **Done:** Static review of PR #3 (head `31c78eb`): the diff, a broad grep of the tree, a git history scan across all refs, and a check of the PR metadata.
- **Files created:** `docs/reviews/M2-fix/security.md`. No source edits.
- **Open questions:** Can the owner confirm in the Railway dashboard that the Postgres TCP proxy is gone and the password rotated?
- **Next role:** Coordinator. Edit the PR body, have QA redact `qa.md:11`, then send the readiness report to the owner for merge approval.
