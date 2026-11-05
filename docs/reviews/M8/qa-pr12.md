# QA review: PR #12 (approver K-CLAUDE rule, split from PR #11)

## 1. Scope reviewed
- PR #12, branch `feat/m8b8-k-claude`, head `0852d291cdaf6d941570e9cb1602a56a82f5c264`, base `main` at `46a61c1`.
- Branch history over base: one commit, `0852d29` (`git log --oneline origin/main..0852d29`).
- Prior QA of the same code: `docs/reviews/M8/qa-prB.md` on `feat/m8b-team-tests`.

## 2. Traceability
| Check | Command / test | Result |
|---|---|---|
| 1. Approver tree identical to `2c03cde` | `git diff 2c03cde 0852d29 -- tools/approver \| wc -c` | 0 bytes: PASS |
| 2. Exactly 4 files | `git diff --name-only origin/main...0852d29` | Lists exactly `tools/approver/policy/policy.sample.json`, `tools/approver/src/rules/bash.mjs`, `tools/approver/test/bash-rules.test.mjs`, `tools/approver/test/fixtures/requests.json`. Nothing under `tools/team-tests/`, `package.json`, `docs/`, `.claude/`, `.github/`: PASS |
| 3. Same patch as `2c03cde` | `git diff origin/main...0852d29` vs `git show 2c03cde --format=`, both filtered with `grep -v '^index '`, then `diff` | Identical (171 lines): PASS |
| 4a. Root `npm test` | scratch clone at `0852d29` | tests 286, pass 286, fail 0, skipped 0: PASS |
| 4b. Approver suite | `node --test 'tools/approver/test/*.test.mjs'` | tests 171, pass 171, fail 0, skipped 0: PASS |
| 4c. QA K-CLAUDE cases | `k-claude.test.mjs` from `feat/m8b-team-tests`, copied into the scratch clone only at the same relative path, so no import edits were needed | 5 tests, 5 pass, 0 fail: PASS |
| 5. CI | `gh pr checks 12` | See section 3 |

The 5 K-CLAUDE tests passed: every run form asks or denies; K-CLAUDE is the rule id for plain forms; exemption is exactly `--help` and `--version`; `claude` as a plain argument is not a run; the sample policy decision is ask.

## 3. CI and automated test summary
`gh pr checks 12` at review time:
- frontend: pass (16s)
- root: pass (16s)
- backend: pending
- worker: pending

CI was still running and had not completed. I did not re-run it. Run ID 42101177540. The root job, which runs the changed code's tests, had passed. My local results (section 2) are independent of CI.

## 4. Findings
1. Note: backend and worker CI jobs were still pending when I checked. The Coordinator must confirm they are green before recommending merge (CLAUDE.md hard rule 7). These jobs cover areas the change does not touch.
2. Note: I could not delete the scratch clone. The `rm -rf` command was denied by the permission system. It sits under the OS temp dir (from `mktemp -d`). It is outside the repo and holds only a clone and a copy of the QA test file. The owner can remove it.
3. Note: no defects found. The scope is the intended single commit with no extras.

## 5. Verdict
VERDICT: READY

The PR is a faithful split. The approver tree is byte-identical to `2c03cde`, the file list is exactly the 4 expected files, and the patch matches `2c03cde` ignoring index lines. Root `npm test` (286) and the approver suite (171) pass with no failures. My earlier K-CLAUDE probes (5 tests) pass against this code. The only open item is that the backend and worker CI jobs were still pending. This is a condition for merge but does not affect the code verdict, since those jobs cover untouched areas.

## Handoff
- Done: verified the split by diff, ran the suites and the QA probes in a scratch clone, and checked CI.
- Files created: `docs/reviews/M8/qa-pr12.md` in the main checkout, uncommitted.
- Open: confirm backend and worker CI have finished green. The scratch clone could not be removed.
- Next role: Coordinator for the readiness report (Sec if it has not yet reviewed).
