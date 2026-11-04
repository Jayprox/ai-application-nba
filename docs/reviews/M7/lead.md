# M7 Lead review: permission approver (PR #8)

Reviewer: Engineering Lead. Date: 2026-11-04. Branch `feat/m7-permission-approver`.
Reviewed: code HEAD `c29d629` and PR head `647ead6` (docs only after `c29d629`), with `git diff main...HEAD` (53 files, +7581/−1).
Against: `docs/plans/M7-permission-approver.md` (owner decisions §6.1), `docs/requirements/M7-permission-approver.md` (owner answers §7.0), `docs/reviews/M7/qa.md` (final: READY), `docs/reviews/M7/security.md` (final: READY), `docs/STANDARDS.md`.
Commands run:
- `npm test` at the root: 279 tests, 279 pass.
- `gh pr checks 8`: backend, frontend, root and worker all pass on `647ead6`.
- Two read-only probe scripts against the pre-filter and the hook, using the repo's test helpers in temporary directories.

No source, settings, hooks, `.env*` or Keychain was touched.

## VERDICT: READY

There are no Blockers and no Majors. The Minors below are follow-up tickets or owner install steps. None of them gates the merge or shadow mode.

## Findings

1. **Note: all plan tasks are present.** Each of T1 to T9 is its own commit, plus the T4 follow-up `8b0aba3`:

   | Task | Commit |
   |---|---|
   | T1 | `858cf72` |
   | T2 | `d39d5ee` |
   | T3 | `6701730` |
   | T4 | `b19ea60` |
   | T5 | `515f709` |
   | T6 | `cb284ad` |
   | T7 | `a81b9af` |
   | T8 | `65226a7` |
   | T9 | `2245242` |

   `docs/architecture.md` §7.10 and a row in the root README were added, as `docs/STANDARDS.md` §5 requires. Fix cycles used: 3 of 3 (`docs/STATUS.md`), so the charter limit was respected.

2. **Note: the owner decisions are honoured.**

   | Decision | Evidence |
   |---|---|
   | Model is log-only (Q8 b) | The decision comes from `prefilter()` only (`src/approver.mjs:101-118`). The worker is spawned after the record is final (`approver.mjs:120-127`), and only when `result.undecided` is set. The worker's stdout and stderr are ignored (`src/model/spawn.mjs:10`). Probe: with the model enabled, `curl x`, `git status`, `make build` and `npm install x` sent only `make build` to the model. |
   | Key from the Keychain only (Q2) | Read with `execFile('/usr/bin/security', [...,'-w'])` with no shell and env `{PATH}` only (`src/model/keychain.mjs:16-17`). The key goes only into the `x-api-key` header to the hard-coded `api.anthropic.com` (`src/model/client.mjs:6,95`). The worker env is `{PATH, HOME}` (`spawn.mjs:10`). `grep -rn "ANTHROPIC_API_KEY\|process.env" src bin` finds nothing. |
   | Acts only in this repo (Q9) | `inScope()` realpaths the `cwd` and compares path segments with the realpath `repo_root` recorded at install (`src/paths.mjs:5-8, 52-56`). Out of scope returns empty stdout before the mode, policy, log or model (`approver.mjs:74`). Probe: `cwd: /tmp` gave empty stdout and no record in all five modes. |
   | F9 | `-u` or `--set-upstream` is stripped only in first position, then exactly `origin <feat/…\|fix/…>` (`src/rules/allow.mjs:223-228`). Probe: `git push -u origin feat/x` and `--set-upstream origin fix/y` are allow. `git push origin -u feat/x`, `-u origin HEAD`, `--tags` and `--delete` are ask. `-u origin main` is deny. |
   | Modes, deny always hard | `outputForMode` (`src/hook-io.mjs:39-44`): deny prints in both enforcing modes, and allow prints only in `enforce`. No rule result carries `error` on a deny (only `K-ERROR` asks do), so a deny is never suppressed. An unknown or odd-case mode reads as `shadow` (`src/config.mjs:34-39`). Probe: shadow gave empty/empty/empty; enforce-deny gave deny/empty/empty; enforce gave deny/allow/empty; `ENFORCE` and `garbage` gave empty. |
   | No settings edited | No file under `.claude/` or any settings file is in the diff. `bin/install.mjs` only prints the hook and the deny rules (`install.mjs:103-106`). `bin/uninstall.mjs:28` prints the entry to remove. |

3. **Note: the Appendix A deny list is not weakened.** I ran 57 Bash and 8 file probes covering every Appendix A deny bullet, plus wrapping, obfuscation, Unicode and compound forms (`railway`, non-local `psql`/`pg_dump`, `DATABASE_PUBLIC_URL`, `*_CONFIRM_PROD`, `.env*`, `secrets/`, `~/.ssh`, `security`, `env`, `printenv`, `curl`/`wget` in many spellings, push to main or master, force pushes, `gh pr merge`, `gh release`, `gh workflow run`, `rm -rf` spellings, and writes to `.claude/` and to the install dir).
   - 64 of 65 matched the expected result.
   - The one difference was stricter: `$(echo curl) x` is deny, not ask. That is correct under story 2.5 (a deny visible in the readable part denies).
   - QA's 676-request sweep and Sec's 67-repro regression on the final code agree.

4. **Note: the Dev's deviations are accepted.** All of them are stricter than the plan, and all of them are documented in the README.
   - **Recursive `grep` is ask, and `rg` needs `--no-ignore`.** This closes Sec S3: an agent-written `.ignore` file could make `rg` read `.env`. The cost is extra prompts only.
   - **Non-ASCII paths are ask** (`K-UNICODE`), and deny when the folded form is protected (Sec 4). This matches story 2.6.
   - **A commit message that names `.env` or `~/.ssh/...` as a whole token is deny.** This is the approved A14 reading ("any command naming a `.env*` path is deny"), not a new rule. It is a hard deny that the owner cannot approve in a prompt once enforcing, so the agent must reword the message. The README states this.
   - **Rev-parse gate on git and gh.** git and `gh pr` are allowed only when `git rev-parse --absolute-git-dir`, run in a clean env, reports `<repo>/.git`. It closes nested and implicit git-dir attacks (Sec C2-1, C2-2) and costs about 13 ms (QA).
   - **Implicit git-dir file heuristic.** A file named `config` next to a `hooks/` folder asks. This is a known false positive (QA T2, Sec C3.4), usability only.
   - **New rule ids.** `K-ATTR`, `K-UNICODE` and `K-SHAPE` are in `policy.sample.json`. `K-ERROR`, `K-POLICY` and `K-TOOL` are hook-level ids, used only in `approver.mjs`, and all of them are ask. `chflags` and `xattr` are deny on protected paths, which is self-protection under story 9.
   - None of these turns an Appendix A deny into ask or allow.

5. **Minor: the daily spend cap undercounts failed calls.** `src/model/worker.mjs:64` records cost only when `r.ok`. A model reply that fails validation (`invalid`), or that ends in an HTTP error after billing, has used tokens, but it adds US$0 to the ledger. Spend is still bounded by the one-call lock, the 150-token `max_tokens`, the breaker (3 failures, then a 10-minute pause) and the owner's Console limit.
   - Fix (follow-up): count the cost from `usage` whenever a parsed body has one, or add `per_call_cap_usd` for every completed HTTP exchange.

6. **Minor: the worker does not bound `timeout_ms`.** `validConfig` (`worker.mjs:20`) accepts any positive `timeout_ms`, and story 11.2 says at most 8 s. `install.mjs:73` writes 8000, and `install.json` is locked (0444 + `uchg`), so an agent cannot reach this. It is defence in depth only.
   - Fix (follow-up): require `timeout_ms <= 8000`.

7. **Minor: the owner checklist leaves out the model id and prices.** `tools/approver/README.md` checklist step 2 runs `install.mjs --repo-visibility private` without `--price-in`/`--price-out`.
   - The README's Install paragraph says the defaults (1.0 and 5.0 US$ per million tokens) are placeholders, but the step-by-step list does not repeat it. Wrong prices make the US$1/day script cap inaccurate. The Console limit is still the backstop.
   - No step confirms that `claude-haiku-5-5` is valid on the owner's account. If it is not, every model record shows `http_4xx`, and the decisions are not affected.
   - QA raised the same point as an owner item.
   - Fix: the owner passes `--price-in`/`--price-out` (and `--model-name` if needed) at install and checks the report's model section after day 1. A follow-up README edit should fold both into step 2.

8. **Minor: a mode change is not visible.** The `mode` file is 0644 and not `uchg` (`install.mjs:80-83`, by design so the owner can switch). Any code-execution path the owner approves (for example `npm test` after an agent edited a test) can rewrite it. Writing `shadow` silently turns off deny enforcement. Sec accepted this as a residual (round-1 note 13), and the README lists it.
   - Fix (follow-up): `verify.mjs` prints the mode file's mtime, and `report.mjs` lists the mode changes it sees in the log. `mode` is already logged in every record, so this needs no new data.

9. **Note: two small departures from the plan text are acceptable.**
   - Malformed stdin or JSON is logged before the scope check (`approver.mjs:66,69`), so a broken payload from another project leaves a record. The record holds only an error code and a size, with no input. Q9 allowed "minimal or no log".
   - For undecided requests, the hook waits up to 300 ms to hand the request to the worker (`spawn.mjs:26`). It usually returns as soon as the stdin write completes. QA measured whole-process p95 at 129 ms. It does not affect decided requests.

10. **Note: the code is maintainable.**
    - Module boundaries follow plan §3.14:
      - I/O is isolated in `hook-io.mjs`, and a lint test enforces that nothing else touches stdout (`test/io.test.mjs:79`).
      - Config, paths, parser, rules (`bash.mjs` deny/ask and `allow.mjs` allow, split) and file rules each have their own module, and so does each model part.
    - The parser (`src/shell/parse.mjs`, 529 lines) is one recursive-descent `Parser` class of about 20 small methods. Nesting is bounded (`MAX_NEST = 4`), and commands over 32 KB are not parsed. It is the riskiest file to change. The README rule "add a corpus case for every rule change" is the right guard.
    - Tests:
      - The corpus has 254 labelled items, each above its category minimum (allow 41, ask 48, deny 67, compound 24, injection 19, obfuscation 39, fail-closed 16), with A1 to A16 all tagged.
      - Fault matrix, mocked always-allow, invalid and hanging models, redaction with fake secrets, synthetic transcripts, and install in a temporary HOME.
      - Everything runs offline. `/usr/bin/security` and `chflags` are injected.
    - Style matches `docs/STANDARDS.md` §1 (ESM `.mjs`, 2-space indent, single quotes, comments that explain why). There are no dependencies.

11. **Note: the only change outside `tools/approver/` and docs is safe.**
    - Root `package.json`: the `test` script gains `'tools/approver/test/*.test.mjs'`. No dependency or other script changes.
    - Root `README.md`: one table row.
    - CI picks up the new tests through the existing root job (`.github/workflows/test.yml:37-38`), so no workflow edit was needed (plan F11).
    - `npm test` takes about 9 s locally, and the root CI job took 16 s.

12. **Note: the README owner checklist is complete enough to install and run shadow mode alone.** It covers:
    - the Keychain item;
    - install, the hook paste and the deny rules, with a check for the UNCONFIRMED space-in-path syntax;
    - verify, and the one-minute "No" marker self-check;
    - 7 days / 200 records, the report, and the exit criteria for each stage;
    - `-p` behaviour, the Node path after `brew upgrade`, uninstall and rollback, and "what this does not protect".

    Finding 7 is the only gap.

## For the owner

**Decisions before merge:** none required.

**At install (README checklist):**
- set the real prices, and the model id if needed (finding 7);
- create the Keychain item;
- add the printed deny rules, including `Bash(security:*)` (§6.1 F4), and test one Edit to the install folder;
- run the "No" self-check;
- stay in shadow for at least 7 days and 200 records.

**Follow-up tickets:**
1. Count spend for failed or invalid model replies (finding 5).
2. Bound `timeout_ms` to at most 8000 in the worker (finding 6).
3. Fold the price and model-id step into README checklist step 2 (finding 7).
4. Make mode changes visible: mode mtime in `verify`, mode transitions in `report` (finding 8).
5. Reduce the git-dir heuristic false positive (`config` next to `hooks/`) if it shows up in the top-10 asks.
6. Owner's own item (Q12, plan F12): the `.claude/settings.json` allow rules (`git branch:*` includes `-D`, `git checkout -b:*`, `pytest:*`) still pre-approve calls before the hook sees them.
7. Housekeeping: the plan's Step A left a scratch session transcript folder under `~/.claude/projects/`. The owner may delete it.

## Handoff

- **Done:**
  - Lead review of PR #8 against the plan, the requirements, the owner decisions and both final verdicts.
  - `npm test` 279/279. CI green on all four jobs at `647ead6`.
  - Read-only probes: 65 deny-list and owner-decision cases, the mode × scope table, and the model-only-for-undecided check.
- **Files:** `docs/reviews/M7/lead.md` (this file, not committed). Probe scripts are in the scratchpad (`m7-lead/probe.mjs`, `e2e.mjs`, `e2e2.mjs`).
- **Open questions:** none blocking. Owner install items and follow-up tickets are listed above.
- **Recommended next role:** Coordinator, for the readiness report and the owner's merge approval (Gate 2). Install and mode switches stay the owner's own actions.
