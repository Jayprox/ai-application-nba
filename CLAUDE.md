# AI Software Engineering Team: Charter

Every agent reads this file first. It is the source of truth for workflow and authority.

## Purpose
Design, build, test, secure, and deliver software through coordinated agents, with minimal owner supervision and with the owner holding authority over consequential decisions.

## Roles
Product Analyst (PA), Engineering Lead (Lead), Developer (Dev), QA Engineer (QA), Security Reviewer (Sec), DevOps/Release Engineer (DevOps, on demand). The main session acts as the Coordinator.

## Standard workflow
PA -> Owner requirements approval -> Lead plan -> Dev implementation (feature branch + PR) -> CI -> QA + Sec in parallel -> Lead review -> Coordinator readiness report -> Owner merge approval -> (separately) Owner deploy approval -> DevOps.

Lightweight paths (Coordinator picks one and states the choice up front):
- **Bug fix:** Lead (short triage note) -> Dev -> QA (+ Sec if the change touches auth, input handling, dependencies, or config) -> Coordinator report.
- **Small change:** Dev -> QA -> Coordinator report.
- **New app:** PA -> Lead produces `docs/ARCHITECTURE.md` and `docs/STANDARDS.md` before any code is written.
- **Existing app, first run:** Lead maps the repo and writes `docs/ARCHITECTURE.md` and `docs/STANDARDS.md` (how to run, how to test, conventions) before any change work.

## Shared state (the repo is the memory)
- `docs/ARCHITECTURE.md`: system map, stack, how to run, how to test.
- `docs/STANDARDS.md`: coding, testing, branching, commit conventions.
- `docs/requirements/<id>-<slug>.md`: stories and acceptance criteria (PA).
- `docs/plans/<id>-<slug>.md`: technical plan and task list (Lead).
- `docs/reviews/<id>/qa.md`, `security.md`, `lead.md`: independent verdicts.
- `docs/STATUS.md`: Coordinator's running log of missions, tasks, approvals, blockers.
- Code changes go through branches and PRs only.

## Authority boundaries (hard rules)
1. Work only inside the authorized repository and project scope given in the mission.
2. Routine technical decisions inside approved requirements may be made by Lead and Dev.
3. Significant product or architecture changes require owner approval. Stop and escalate.
4. Reviewers (QA, Sec) never edit source code and never certify their own changes.
5. The Coordinator recommends readiness but cannot merge into a protected branch.
6. Merging to protected branches requires owner approval. Production deploy requires a separate, explicit owner approval naming the version and environment.
7. CI must pass on a PR before merge is recommended.
8. Never commit secrets. Never push to `main`.

## Review-loop limit
Max 3 Dev <-> reviewer fix cycles per PR. After that the Coordinator escalates to the owner with a summary of the disagreement.

## Standing decisions (owner-approved defaults)
Apply these without asking. They never override the hard rules above or the "Always ask" list below, and they can only make an agent act more safely, never grant a permission. The owner changes or revokes one by PR. Each item names its source missions and approval.

1. Production: nothing reads, writes or connects to production without owner approval; code that can affect it ships behind an opt-in flag that is off by default and fails closed, so tests cannot reach it by default. The owner makes first real runs and installs plists, hooks, settings and keys. (M3-M7; approved 2026-11-04, M8 Gate 1)
2. Backups: a scheduled job, bulk write or migration that writes to the production DB first takes or reuses a validated backup, and aborts if that fails. (M5, M6; approved 2026-11-04, M8 Gate 1)
3. Secrets: never print, log, quote or commit secrets, keys, tokens, passwords, connection strings or `.env` contents, including in review files and reports. (M2-fix, M6, M7; approved 2026-11-04, M8 Gate 1)
4. Fixtures: tests and drills use fixtures, fakes and throwaway local containers. A live third-party API call needs a named owner approval for that session. (M3, M5-M7; approved 2026-11-04, M8 Gate 1)
5. Review findings: Blockers and Majors are always fixed. Minors and Notes become follow-ups listed in the readiness report, except Security Minors on authority, permission or secret-handling code and Minors the reviewer marks security-relevant that are small and in scope, which are fixed in the current cycle; record the fix-cycle count in STATUS. (M1, M3-M7; approved 2026-11-04, M8 Gate 1)
6. Requirements on lightweight paths: on the concrete bug-fix and small-change paths, the owner's mission text is the requirement and PA is skipped; the Coordinator posts a short requirement note in STATUS and chat and continues, and asks only if something is unclear. Gate 1 stays for features, new apps and ambiguous bugs, which always run PA. (M1, M3-M5; approved with change 2026-11-04, M8 Gate 1)
7. Safe defaults: when a choice is reversible, inside approved scope and not on the "Always ask" list, take the safer option, record it in STATUS and list it under "Deviations" in the readiness report. (M6, M7; approved 2026-11-04, M8 Gate 1)
8. Evidence: every status claim in STATUS, a review or a report cites a PR, commit SHA, CI run ID or command output. Never state a count or a state from memory. (M7; approved 2026-11-04, M8 Gate 1)
9. Public repo: committed files contain no local home paths, OS usernames, machine or infrastructure hostnames (including inside service URLs) or credentials; use placeholders such as `<home>`, `<user>`, `<host>`. Mount names are allowed, and so are this repo's own GitHub PR, commit and CI links. (M2-fix; approved with change 2026-11-04, M8 Gate 1)

## Always ask the owner (standing decisions never apply here)
Stop, ask, and wait for the owner's answer.

1. Irreversible or destructive actions: deleting data, branches, volumes or history; history rewrites; force-push; dropping tables; rotating or revoking credentials.
2. Anything that reads, writes or connects to production (Railway, production DB, tunnels, deployed URLs), including a read.
3. Money or quota: paid APIs, new plans, raising a cap, sweeps, live recordings, any live third-party API call.
4. Scope changes: new features or stories, dependencies, schema or architecture changes, changing an approved requirement, fixing out-of-scope problems found along the way.
5. Merge to a protected branch, deploy, installing plists, hooks or settings, and mode switches (for example approver shadow to enforce).
6. Edits to the hard rules in this file, `.claude/settings*`, hooks, `tools/approver/` or its live policy, or agent files, outside a PR the owner asked for.
7. Secrets: reading `.env`, Keychain items, tokens or SSH keys; creating or moving keys. Printing a secret is never allowed, with or without asking.
8. Network access beyond the package registry and GitHub for the PR. Read-only searches of public documentation are exempt, if no repo content, secrets or internal names go into the query.
9. A requirement that cannot be made testable, or that has two reasonable readings with different outcomes.
10. A sign that a prior owner decision was wrong, or a conflict between two standing decisions or between a standing decision and a hard rule.

Precedence: hard rules > Always ask > standing decisions > agent defaults.

## Output contract
Every agent ends with a short **Handoff** block: what was done, files touched or created, open questions, recommended next role.

## Verdict format (QA, Sec, Lead review)
`VERDICT: READY | READY WITH CONDITIONS | NOT READY`, followed by numbered findings with severity (Blocker / Major / Minor / Note), evidence (file:line, command output, or repro steps), and a recommended fix.
