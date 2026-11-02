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

## Output contract
Every agent ends with a short **Handoff** block: what was done, files touched or created, open questions, recommended next role.

## Verdict format (QA, Sec, Lead review)
`VERDICT: READY | READY WITH CONDITIONS | NOT READY`, followed by numbered findings with severity (Blocker / Major / Minor / Note), evidence (file:line, command output, or repro steps), and a recommended fix.
