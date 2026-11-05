# QA review: M8 Part A (PR #10)

## 1. Scope
- PR #10, branch `feat/m8a-standing-decisions`, head `93f902739149cce52716d982ebf1f1e17b2dd172`, vs `main`.
- Diff (`git diff main...HEAD --stat`): `CLAUDE.md` (+29), `docs/STATUS.md` (+33), `docs/plans/M8-...md` (+391), `docs/requirements/M8-...md` (+312). No `.claude/`, settings, hooks or `tools/` change.
- Docs-only change; QA verified by reading and by diff/grep commands. No behaviour to run.

## 2. Traceability (Story 1)
| Criterion | Test | Result |
|---|---|---|
| AC1 section, each item names source mission and approval date | Read CLAUDE.md items 1-9; each ends with "(Mx...; approved 2026-11-04, M8 Gate 1)" | PASS |
| AC2 approved decisions present, declined absent | Compared to requirements §0 and STATUS Approvals (table 4a) | PASS (see F3, F4) |
| AC3 always-ask has every §3.3 item; precedence line present | One-to-one compare with requirements §3.3 (table 4b) | PASS |
| AC4 diff only additions | `git diff main...HEAD -- CLAUDE.md`: one hunk, `@@ -39,6 +39,35 @@`, 29 added lines, 0 removed. `git diff main...HEAD \| grep -c '^-[^-]'` = 0 | PASS |
| AC5 imperative, one-to-two lines | Read items | PARTIAL: items 1, 5, 6, 9 are each one long paragraph line (about 3-5 rendered lines). See F5 |
| AC6 single `feat/m8a-*` PR, CLAUDE.md and STATUS, no settings/hooks/approver | `git diff --stat`; branch name | PASS (PR also carries the M8 requirements and plan docs, which the plan §1 says it should) |

## 3. Owner-decision mapping
4a. Standing decisions
| Item | Source | Faithful? |
|---|---|---|
| 1 Production, opt-in flag, owner first runs | Req C3, P2, P3; Gate 1 "all defaults accepted" | Yes |
| 2 Backups: scheduled job, bulk write or migration | Req C2 and Q3 default ("scheduled jobs and any bulk or migration write") | Yes |
| 3 Secrets | C4 | Yes |
| 4 Fixtures, live call needs named approval per session | C5, Q8 default | Yes |
| 5 Review findings, Sec Minors on authority/permission/secret code fixed, count in STATUS | Req Q1/Q2 defaults, §3.4 | Yes. Wording is slightly broader than the Q2 default: adds "Minors the reviewer marks security-relevant that are small and in scope" (this is the Q1 refinement). OK |
| 6 Requirements on lightweight paths | Gate 1 change ("only existing small-change and bug-fix paths") plus plan §7.1 F1 (no new Gate 1 stop on concrete bug/small change; requirement note; ask if unclear) | Yes, with F1 below |
| 7 Safe defaults | C6, Q5 | Yes |
| 8 Evidence | C7, Q4 | Yes |
| 9 Public repo: home paths, usernames, infra hostnames (incl. in service URLs), credentials; own PR/commit/CI links allowed | Gate 1 Q8 change (no mount names), plan F3, Coordinator reading of "hostnames" | Yes, but see F3 |

4b. Always-ask items 1-10 match requirements §3.3 items 1-10 in order. Differences, all owner-approved: item 8 adds the public-documentation search exemption (plan §7.1 F4); item 7 adds "Printing a secret is never allowed, with or without asking" (from §3.3 item 7 "forbidden outright"); item 2 keeps "including a read". Nothing added that the owner did not approve. Precedence line text matches §3.3/§3.4.

## 4. Consistency and ambiguity walk-through
Scenarios (what the text tells an agent):
1. QA Minor on CSS (not security): item 5 says follow-up in readiness report. Clear.
2. Sec Minor on token handling: item 5 names "secret-handling code": fix in the current cycle, record cycle count. Clear. But if it arrives in cycle 3 the text does not say what happens (see F1).
3. Lead WebSearch for Node docs: always-ask 8 exempts read-only public documentation search if no repo content/secrets/internal names in the query. Clear. A search for an error string copied from the repo is a judgement call (F6).
4. Concrete bug report that turns out to need a schema change: item 6 skips PA and continues; always-ask 4 ("schema or architecture changes", "changing an approved requirement") stops it. Precedence line makes ask win. Item 6's "asks only if something is unclear" does not itself say a discovered scope change triggers a stop, but the precedence line resolves it. Acceptable. Also hard rule 3 applies.
5. Reviewer marks a Minor in `tools/approver/` as security-relevant: item 5 says fix in cycle; always-ask 6 says edits to `tools/approver/` outside a PR the owner asked for need asking. Precedence resolves to ask, but the text does not say so (F2).
6. Ambiguous bug: item 6 says "Gate 1 stays for ... ambiguous bugs, which always run PA". The charter bug-fix path is Lead -> Dev with no PA, so this is an implicit new branch of the path (it only adds a stop, so it is safer, and the owner's Gate 1 wording supports it). Noted (F7).

Cross-checks:
- Item 4 vs always-ask 3: consistent (both require owner approval for live calls; item 4 is the narrower statement).
- Item 5 vs 3-cycle limit: see F1.
- Item 6 vs bug-fix path: consistent with owner F1 (no extra Gate 1 on concrete bug/small change; requirement note and continue). The "Gate 1 stays" wording in the owner's Gate 1 text conflicts with F1; plan §7.1 says F1 overrides, and CLAUDE.md follows F1. Correct.
- Item 1 "installs plists, hooks, settings and keys" vs always-ask 5/6/7: consistent.
- Item 2 migration vs always-ask 4 (schema change) and 2: consistent; item 2 only adds a precondition.
- Item 7 excludes the always-ask list: yes.
- No standing decision grants a permission; the intro says so. No conflict with hard rules 1-8 found.

## 5. Rule 9 scan of files this PR adds or changes
Command: grep of the added lines for home-path prefixes, the OS username and the GitHub account name, `.local`, proxy/railway hostnames, `postgres://`-style URLs, key prefixes, and `user@host:port` shapes.
- No absolute home paths, no OS username, no account name, no real hostnames, no credentials in any added line.
- Hits are generic only (values not copied): `docs/plans/M8-...md` lines mentioning `~/.claude` and a fake HOME as design text; format-check text listing forbidden key prefixes and `postgres://` (plan, around the canary format check); requirements/plan text naming the generic proxy host class and the "password"/"tokens" words. None is a real value.
- Requirements §3.5 and plan §2.4 cite file:line locations of existing leaks without values. Acceptable.
- Result: PASS.

## 6. CI
`gh pr checks 10` at head `93f9027`: backend pass, frontend pass, root pass, worker pass (run 41958451616). CI does not test docs content; this is not evidence for the findings above.

## 7. Findings
1. **Minor (ambiguity).** Item 5 vs the 3-cycle limit: a security-Minor "fixed in the current cycle" can arrive in cycle 3, or its fix can open a new finding. Text does not say the limit still applies (escalate to owner). Recommended fix: add "Fix cycles still count toward the 3-cycle limit; if the limit is reached, escalate" or accept that the Review-loop limit section governs.
2. **Minor (ambiguity).** Item 5 vs always-ask 6: a security-relevant Minor in `tools/approver/`, hooks or settings is told to be fixed in-cycle, while always-ask 6 says edits there outside an owner-requested PR need asking. Precedence resolves it but a reader must infer it. Recommended fix: add "except where the fix is in always-ask 6 territory" to item 5, or leave and rely on the precedence line.
3. **Minor (fidelity).** Item 9 says "Mount names are allowed". Owner said "do NOT extend to mount names" (not extended), which is silence, not an affirmative allowance. Effect is the same today; wording grants a permission. Recommended: "Mount names are not covered by this rule" or keep, with owner awareness.
4. **Note.** Item 9 hostnames "including inside service URLs" reflects the Coordinator reading recorded in STATUS Approvals (not an explicit owner statement); it is flagged for the readiness report. The existing tree conflicts with it until the cleanup `fix/` PR (plan §2.4, STATUS follow-up). Confirm the Coordinator lists it under Deviations.
5. **Note (AC5).** Items 1, 5, 6, 9 exceed "one-to-two lines" in the strict sense. Content is imperative and matches the approved text; owner/Lead to decide if this matters.
6. **Note.** Always-ask 8 exemption relies on the agent judging "no internal names in the query"; low risk.
7. **Note.** Item 6 introduces PA for "ambiguous bugs", which the charter's bug-fix path does not mention. Adds a stop only; consistent with owner's Gate 1 wording.
No Blocker or Major findings.

## 8. Not tested
Agent behaviour under the new text (that is Part B's golden missions, not yet run). Sec review is separate.

VERDICT: READY WITH CONDITIONS

Rationale: The CLAUDE.md change is additions only (29 lines added, none removed), every standing decision and always-ask item traces to an owner approval in requirements §0, plan §7.1 or STATUS, nothing unapproved was added, the precedence line is present, the diff holds no home paths, usernames, hostnames or credentials, and CI is green on head 93f9027. Conditions are small wording points for the Lead/owner to accept or fix: Minors 1-3 (item 5 vs 3-cycle limit, item 5 vs always-ask 6, "Mount names are allowed" phrasing), plus the Coordinator listing the hostname reading (finding 4) and the item 6 PA-for-ambiguous-bugs reading (finding 7) under Deviations in the readiness report.

## Handoff
- Done: reviewed PR #10 at 93f9027 against requirements, plan §7.1 and STATUS approvals; diff check, mapping, scenarios, rule 9 grep, CI check.
- Files created: `docs/reviews/M8/qa-prA.md`. No other file edited, nothing committed.
- Open questions: accept or fix Minors 1-3; confirm Deviations entries for findings 4 and 7.
- Next role: Security Reviewer (parallel) and Lead review; Dev only if the owner wants Minors 1-3 reworded.
