# M8 PR A: Lead review (final)

Reviewer: Engineering Lead. Date: 2026-11-04.
PR #10, branch `feat/m8a-standing-decisions`, head `11e2d1422db2e96e4992e14990f524be2a84eb73` (`gh pr view 10 --json headRefOid`: matches; state OPEN, MERGEABLE, base `main`).
Inputs: requirements §0 and Story 1; plan §2 and §7.1; STATUS Mission M8 Approvals (`docs/STATUS.md:376`, `:379`, `:381`, `:383`, `:385` at `11e2d14`); `docs/reviews/M8/qa-prA.md` and `docs/reviews/M8/security-prA.md` including their final cycle-3 sections (present in the working tree, not yet committed); `git diff main...11e2d14`.
Method: read-only `git`, `gh` for this PR and its CI run, `python3 -I` exact-text checks run on `git show 11e2d14:` copies in a scratch dir, `grep` counts of rule 9 patterns (values not printed). No source file edited; nothing committed.

## 1. Checks

| Check | Evidence | Result |
|---|---|---|
| CI on head | `gh run view 41963319602`: `headSha` `11e2d14...`, event `pull_request`, completed/success; jobs backend, frontend, root, worker all success. `gh pr checks 10`: 4 pass. | PASS |
| Files in PR | `git diff --numstat main...11e2d14`: `CLAUDE.md` +37/-1; STATUS +52; M8 plan +391; M8 requirements +312; `qa-prA.md` +210; `security-prA.md` +331. Nothing under `.claude/`, `.github/`, `tools/approver/`, settings or hooks (grep rc=1). | PASS (see Note 3) |
| Existing CLAUDE.md text | Script: every line of `main:CLAUDE.md` is present in `11e2d14:CLAUDE.md` except `- **Small change:** Dev -> QA -> Coordinator report.` (the one deletion in numstat). Hard rules, workflow, review-loop limit (`CLAUDE.md:39-40`), output contract and verdict format unchanged. | PASS |
| Small-change line | `CLAUDE.md:16` contains the cycle-2 approved definition (`STATUS:383` item 5) verbatim and the bug-fix Sec trigger (`STATUS:381` item 7). | PASS (owner-approved) |
| Always-ask intro paragraph | `CLAUDE.md:56` equals the STATUS "Resulting exact text (a)" (`STATUS:385`) as a whole line: `True`. | PASS |
| Always-ask 6 | "the Always-ask section or the precedence line" present, "Always-ask list" absent; cycle-2 sentence (1) exact `True`; "names that file and the change" present, "file or path" absent. | PASS |
| Item 17 | `CLAUDE.md:74` equals `STATUS:385` (c): `True`. | PASS |
| Other approvals | SD4 "for that mission" (cycle 2 (5)); SD5 cycle-count and ask-first clauses (fixes 1-2); SD6 per F1 (`STATUS:379`); SD9: no "mount" anywhere in CLAUDE.md (Gate 1 Q8, fix 3), repo-link sentence present (F3); always-ask 8 search/docs exemption and fetched-text rule (F4, fix 6); always-ask 11-16 (fix 8). | PASS |
| Nothing unapproved | Script compare of plan §2.2 text with head: SD 1, 2, 3, 7, 8 and always-ask 1-5, 7, 9, 10 and the precedence line are identical to the plan text the owner approved at the plan gate. Every differing line (SD4, SD5, SD6, SD9, intro, AA6, AA8) and every added line (AA11-17, small-change line) traces to one of the approvals above. | PASS |
| Fix cycles | STATUS: cycle 1/3 (`399226d`), 2/3 (`8e1df1a`), 3/3 (`11e2d14`). 3 of 3 used; none remain. | PASS (limit reached) |
| Rule 9 / secrets, committed diff | Added lines of `main...11e2d14`: 0 hits for the local OS username, 0 for `/Users/` or `/home/<x>` paths, 0 `postgres://...@`, 0 key prefixes with values. 8 `~/` hits are the generic `~/.claude` / `~/Library/...` design or audit text; 1 `.local` hit is the `CLAUDE.local.md` filename; 1 `rlwy` hit is the generic `*.proxy.rlwy.net` pattern; the only non-repo URL is the loopback placeholder `http://127.0.0.1:9`. | PASS |
| Rule 9, uncommitted review/STATUS additions | `git diff` (working tree): 0 hits on all patterns above; only URL is the same loopback placeholder. | PASS |

### Story 1 acceptance criteria

| AC | Result |
|---|---|
| 1 Section exists, each item names source missions and approval date | PASS: `CLAUDE.md:42-53`, items 1-9 each end with "(Mx; approved 2026-11-04, M8 Gate 1)". |
| 2 Approved decisions present, declined absent | PASS: all nine present; the declined mount-name extension is absent. |
| 3 Always-ask contains every approved §3.3 item; precedence line present | PASS: §3.3 items 1-10 map to `CLAUDE.md:58-67` (item 6 widened by approval; its §3.3 coverage of agent files and live policy is kept via `.claude/` and the "Never edit, without asking" sentence); precedence at `CLAUDE.md:76`. |
| 4 No existing text changed or weakened | PASS with owner-approved exception: one line changed (small change), and the change is stricter (Sec trigger, narrow definition). Note 1. |
| 5 Imperative, one-to-two-line form | PASS in substance; SD5 and SD6 run to 3-4 sentences because of owner-approved additions. Note 2. |
| 6 Single `feat/m8a-*` PR, no settings, hooks or approver | PASS. |

## 2. Fit with PR B (nested sessions, harness dry run in CI)

Read against plan §3.8-§5 and §7.1, with always-ask 6, 14, 16, 17 and the approval paragraph:
- **Dry run in CI:** no model, no `claude` process, Node built-ins, no new dependency, no `.github/` edit (plan §3.8, §1). Item 17 (no session started), item 14 (`npm ci` installs the existing lockfile, not a new run-time download), item 11 (the `package.json` glob adds tests) and item 6 (no `.claude/`, `.github/`, `tools/approver/` edit) are all met. Compatible.
- **Pilot:** the owner writes the approval file and launches `run` (F8), so the nested `claude` sessions are owner-started, not agent-started; item 17 binds agents only and is met as long as no agent runs `team-tests run`. Money (item 3), live API (SD4), and the dedicated key (item 7, SD1 "owner ... installs ... keys") are covered by the owner's F6/F7/F8 approvals at `STATUS:379`. The pilot approval is inside M8, so "valid for its own mission only" holds. Compatible.
- **`--bare` skips hooks, so the M7 approver does not run inside nested sessions** (plan §5.1-§5.2). Read alone, always-ask 16 ("bypassing or disabling the approver") could catch this. It is covered by the owner's F7 (a) decision and the owner launching the run, but the PR B brief should say so (Note 5).
- **Fixture and fake-`HOME` writes:** the harness writes `<scratch>/fixture/.claude/...` and settings under a fake `HOME`. Always-ask 6 ("anything under `.claude/`", "user-level Claude Code settings") is meant for this repo and the real user config, but it does not say so (Note 5).
- **Sec D3-2's fix (an approver ask rule for `claude`)** would edit `tools/approver/` and possibly the approver's live policy. That needs always-ask 6 (the mission must name the file and the change, and "a mission naming them is not enough" for the live policy) and always-ask 4 (it is not in the approved M8 scope). It is a follow-up the owner has to approve. Neither the Dev nor I may add it to PR B on our own (Note 4).
- **Dev confirming CLI flags:** plan §5.6 lets the Dev check UNCONFIRMED items "from local files, never by an extra model call". `claude --help` / `--version` start no session, but item 17's example ("a nested `claude` CLI run") could be read to cover them. The PR B brief should either state that `--help` / `--version` are allowed or forbid them (Note 5).

Conclusion: the final charter does not block PR B as planned. The open points are brief-level clarifications and one owner decision (D3-2). None of them needs a CLAUDE.md change in PR A.

## 3. Reviewer follow-ups: classification

| Item | Reviewer severity | Lead view |
|---|---|---|
| QA Note 1: "relayed from another agent" vs quoted Coordinator brief | Note | Agree, non-blocking. The paragraph says the owner's message is the approval and the quote is the subagent's evidence, and it gives an explicit stop rule. Wording clean-up only, and it needs exact owner wording (AA6). |
| QA Note 2: section named three ways | Note | Agree, cosmetic. All three resolve to `CLAUDE.md:55`. |
| QA Note 3: re-ask after summary | Note | Agree. This is intended behaviour, not a defect. Expect it in long PR B sessions (Note 5). |
| QA Note 4: small-change definition near docs-only, Sec trigger mostly redundant | Note | Agree, non-blocking. The redundancy errs on the safe side. |
| Sec D3-1: tie the owner's answer to the session's own question tool | Note | Agree, optional. Owner wording. |
| Sec D3-2: item 17 not technically enforced; "own delegation" reading | Note | Non-blocking for PR A, because no nested session exists until PR B. Reclassify as a **PR B entry item**, not a general follow-up: the Coordinator raises it with the owner before the PR B brief (Note 4). |
| Sec C2-4(b): exact owner wording for standing-decision changes | Note | Agree, follow-up (already in STATUS Follow-ups). |
| Earlier STATUS follow-ups (cycle-2 notes, backup freshness, "reversible" judgement, preamble wording, git-history scan, `fix/` path cleanup) | Notes | Agree, non-blocking. All are recorded in STATUS `### Follow-ups`. |

No Blocker, Major or Minor is open from QA or Sec. Both final verdicts are READY.

## 4. Findings

1. **Note: AC4 literal deviation (owner-approved).** Evidence: `git diff --numstat` shows `CLAUDE.md` -1, and that line is the small-change line (`CLAUDE.md:16`). Plan A2's DoD ("no `-` lines") is superseded by owner approvals `STATUS:381` (7) and `STATUS:383` (5). Fix: none. List it under "Deviations" in the readiness report.
2. **Note: AC5 length.** Evidence: SD5 (`CLAUDE.md:49`) has 4 sentences and SD6 (`CLAUDE.md:50`) has 3, both from owner-approved additions. Fix: none now. Any shortening would need owner wording.
3. **Note: review files are in the PR.** Plan A2's DoD listed only four files. Committing `docs/reviews/M8/*` follows the existing practice (M1-M7) and touches no protected path. Fix: none.
4. **Note (owner decision before PR B): Sec D3-2.** Item 17 relies on agent compliance (`grep` of `tools/approver/src` by Sec found no `claude` rule). Adding an approver rule would edit `tools/approver/` and is outside approved M8 scope (always-ask 4 and 6), so only the owner can authorise it. Fix: the Coordinator asks the owner, before briefing PR B, whether to (a) add an approver ask rule for `claude` in PR B (the mission must name the file and the change), or (b) rely on item 17 plus the rule that the owner alone launches `team-tests run`.
5. **Note (PR B brief clarifications, no CLAUDE.md change).** The Coordinator's PR B brief should state: (a) only the owner runs `team-tests run`; agents run only the dry run and stubbed tests. (b) `claude --help` / `--version` are either allowed as non-session commands or forbidden; pick one. (c) Writes to `<scratch>/fixture/.claude/` and to the fake `HOME` are inside the mission scope (M8 Part B names the scratch fixture) and are not the repo or user files that always-ask 6 protects. (d) `--bare` disabling hooks in nested sessions rests on the owner's F7 (a) approval (`STATUS:379`), so always-ask 16 does not stop the owner-launched pilot. (e) Expect to re-ask approvals after a conversation summary (QA Note 3). If the owner wants any of (a)-(d) written into CLAUDE.md, that is a separate PR with owner-approved wording.
6. **Note: STATUS housekeeping.** Evidence: working-tree `docs/STATUS.md:372-373` has both "T5a Lead review PR A" and "T5 Lead review". Fix (Coordinator): rename T5 to "T5b Lead review PR B" when ticking T5a.
7. **Condition (process, not a fix cycle): the head will change.** The final QA and Sec sections, the STATUS update and this file are uncommitted. Evidence: `git diff --stat` shows 3 modified files, and this file is new. Committing them moves the head past `11e2d14`. Fix: commit these docs to the PR branch, then confirm a green CI run whose `headSha` equals the new head before recommending merge (hard rule 7). This commit changes no `CLAUDE.md` content, so it does not reopen review and does not count as a fix cycle. If anything in `CLAUDE.md` changes, the PR goes back to the owner (3 of 3 cycles used).

VERDICT: READY WITH CONDITIONS

Condition for merge recommendation: Finding 7 (commit the review and STATUS docs; CI green on the resulting head SHA). Content at `11e2d14` meets Story 1. Every owner decision is reflected exactly, and nothing unapproved was added. The only existing line changed is the owner-approved small-change line. Rule 9 is clean, QA and Sec are READY with no open Blocker, Major or Minor, and CI run 41963319602 is green on `11e2d14`. Findings 1-3 go to the readiness report as deviations. Finding 4 is an owner decision before PR B. Findings 5-6 are Coordinator actions.

## Handoff

- **Done:** Final Lead review of PR #10 at `11e2d14`. Checks: exact-text comparison of the approved wording (intro paragraph, always-ask 6 and 17, small-change line, cycle-2 sentences) against STATUS, by script; line-level preservation of `main:CLAUDE.md`; trace of every changed or added line to an approval; Story 1 AC1-6; fit with PR B; classification of reviewer follow-ups; rule 9 counts on committed and uncommitted additions; CI and PR head via `gh`.
- **Files created:** `docs/reviews/M8/lead-prA.md`. No other file edited, nothing committed. Scratch copies are in the session scratchpad only.
- **Open questions:** Finding 4 (owner: approver rule for `claude` in PR B, or rely on item 17 plus owner-only `run`). Finding 5 (b): whether `claude --help` / `--version` count as starting a session.
- **Recommended next role:** Coordinator: commit the docs, verify CI on the new head, write the readiness report (deviations: Findings 1-3; follow-ups: section 3), and go to Gate 2 (owner merge approval). Raise Finding 4 with the owner before briefing PR B.
