# QA Review: M2-fix (PR #3, redact Railway proxy host)

## 1. Scope
Branch `fix/redact-railway-proxy-host`, commit 31c78ebbfd3b5dc53818e970bbc182188e392ff7 (single commit over main). Reviewer did not modify source.

## 2. Traceability
| Criterion | Test | Result |
|---|---|---|
| Docs only, no code/config/test changes | `git diff main...fix/redact-railway-proxy-host`; `gh pr view 3 --json files` | PASS: only docs/architecture.md (+4/-2) |
| Placeholder `<railway-public-host>:<port>` present | Read diff | PASS (architecture.md ~698) |
| Real host/port gone from whole working tree | grep the whole tree (excluding .git/node_modules) for the old host, the old port, and `rlwy\.net` | PASS: no hits for the old host or port. Only generic `*.proxy.rlwy.net` hints in scripts/lib/env.mjs:29 and docs/reviews/M1/security.md:46; no real values |
| Edited paragraph reads correctly and is accurate | Read diff | PASS: states the proxy was removed 2026-11-01 and the password rotated, and tells the reader to re-add a proxy (new host/port). The DATABASE_PUBLIC_URL sentence still flows. Accuracy of the removal/rotation is owner-reported and cannot be verified from the repo |
| PR notes proxy removed and DB password rotated | `gh pr view 3` | PASS on content (item 2) |
| PR body renders properly as markdown | Inspected raw body | FAIL: see finding 1 |
| CI green | `gh pr checks 3` | PASS: backend, frontend, root, worker all pass |

## 3. CI and automated tests
All four CI jobs pass. The change is docs-only, so no application tests apply. I ran no code tests.

## 4. Findings
1. **Minor: PR body has stray backslash escapes.** The raw body contains `\`` before and after every inline code span, for example `\`<railway-public-host>:<port>\``, and `\|` in the grep command. In GitHub markdown the escaped backticks do not form code spans. The result is literal backticks and backslashes. The placeholder `<railway-public-host>` is also likely to be parsed as an HTML tag and disappear from the rendered text. The requirement text is present but may display wrongly. Fix: `gh pr edit 3 --body-file <file>` using a body without backslashes, written from a quoted heredoc.
2. **Note:** The old host/port remains in git history (commit before 31c78eb). The PR states this and relies on the proxy removal and password rotation. Both are owner-reported and unverified by QA. History rewriting is not in scope.
3. **Note:** `docs/STATUS.md` is modified but uncommitted in the local tree. It is not part of the PR, which is correct. It still lists T1 as unchecked.

## 5. VERDICT: READY WITH CONDITIONS
The diff is docs-only, the real host and port are gone from the working tree, the paragraph is accurate and reads well, and CI is green. The one condition is to fix the PR body's stray backslash escapes (finding 1) so the placeholder and code spans render. This is cosmetic and does not block the merge, but the fix is a quick edit. Owner confirmation of the proxy removal and password rotation is still needed, since QA cannot verify either.

## Handoff
- Done: reviewed the diff, grepped the tree, inspected the PR body and CI.
- Files created: docs/reviews/M2-fix/qa.md
- Open questions: should Dev fix the PR body? Has the owner confirmed the rotation?
- Next role: Dev (PR body edit only), then Coordinator readiness report. Sec review is in parallel.
