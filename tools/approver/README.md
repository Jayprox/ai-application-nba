# Permission approver (M7)

An independent approver that Claude Code calls through a `PermissionRequest` hook. It reads each request against the written policy (`policy/policy.md`, the owner's APPROVAL POLICY v1) and answers **allow**, **ask** or **deny**. Safe, routine requests stop prompting. Dangerous ones are refused. Everything else, and every error, timeout or doubt, is **ask**, which means the normal prompt appears (the hook prints nothing and exits 0).

Requirements: `docs/requirements/M7-permission-approver.md`. Plan: `docs/plans/M7-permission-approver.md`. Design notes: `docs/architecture.md` section 7.10. Tested with **Claude Code 2.1.318**, Node 26, macOS. Node built-ins only, no dependencies.

**Nothing in this folder is active until you install it.** The repo holds source, tests and a sample policy. No settings file, hook entry or live policy is in the repo. Agents never edit settings, hooks or the installed policy.

## How it works

```
Claude Code PermissionRequest (Bash | Edit | Write | NotebookEdit)
  -> hook: tools/approver/src/approver.mjs (installed copy)
       outside this repo        -> prints nothing, logs nothing, no model (silent)
       inside this repo         -> deterministic pre-filter -> allow | ask | deny   (final decision)
                                -> one line in the decision log
                                -> if the pre-filter could not decide: a detached background worker asks a model
                                   and logs its opinion (it can never change the answer, in any mode)
       prints by mode:  shadow = nothing | enforce-deny = deny only | enforce = allow and deny
```

- **The model decides nothing.** The final decision is the pre-filter's. Anything it leaves undecided is ask. The model's opinion is only logged so you can measure it (owner decision Q8 b).
- **Scope.** The hook is a user-level hook. It acts only when the session `cwd` (symlinks resolved) is inside the repo recorded at install. Elsewhere it is invisible (owner decision Q9).
- **Fail closed.** Bad input, a missing or changed policy, a crash, an unknown tool or a stalled stdin all end in "print nothing, exit 0". A 3 s watchdog exits silently if the process is idle-waiting (for example on stdin or a slow file), but it cannot interrupt a CPU-bound loop: the parser and the log redaction are therefore bounded (commands over 32 KB are not parsed, redaction works on a 4 KB slice) and the only backstop for a runaway is Claude Code's own 5 s hook timeout, which also ends in the normal prompt. The only way to get an allow on stdout is a clean pre-filter allow in `enforce` mode.
- **Strictest part wins.** In `a && b | c`, one deny denies the whole command, one ask (and no deny) makes it ask.
- **What is judged.** For Bash: the parsed command (quotes, wrappers such as `env`, `sudo`, `xargs`, `bash -c`, `eval`, `find -exec`, here-docs, `$()`, aliases and functions defined in the same command are all unwrapped). Never the agent's `description`. For Edit, Write and NotebookEdit: the path only. File contents are never read, logged or sent to a model.
- **Policy file.** `policy/policy.sample.json` holds the machine rules; `policy/policy.md` is the policy text (also the model's prompt). Both are checksummed at install. A mismatch makes every request ask.

### Rules at a glance

| Decision | Examples (rule ids are in `policy.sample.json`) |
|---|---|
| allow | `ls`, `cat`, `grep` (not recursive), `rg --no-ignore` (agent-written `.ignore` files could otherwise whitelist `.env`), `sed -n`, `head`, `tail`, `wc`, `find` (read-only predicates) on existing, non-secret paths inside the repo; `git status/diff/log/show/branch(list)/add/commit`; `git checkout -b` / `git switch -c` for `feat/` and `fix/`; `git push [-u\|--set-upstream] origin feat/<name>` or `fix/<name>`; `gh pr create/view/checks/diff`; `gh pr comment` (only if `repo_visibility` is `private`); `npm test` / `npm run lint` (only while `package.json`, its lockfile and vite/vitest config equal `origin/main`); `node --test test/<file>.test.js`; the two exact drill commands; edits inside the repo on a branch that is not `main` and off the ask list |
| ask | installs, edits to `.github/`, `ops/`, `package.json`, lockfiles, `db/schema.sql`, `db/migrations/`, Dockerfiles, plists, `CLAUDE.md`, anything outside the repo, `tools/approver/` source, `kill`/`pkill`/`chmod`/`chown`/`sudo`/`launchctl`, `chflags`/`xattr` away from protected paths, reads of protected paths, and everything not clearly matched |
| deny | `railway`, `psql`/`pg_dump`/`pg_restore` against a non-local or unparsable host, `DATABASE_PUBLIC_URL`, `WEEKLY_CONFIRM_PROD`, `BACKUP_CONFIRM_PROD`, any `.env*` path, `secrets/`, SSH keys, Keychain paths, every `security` command, `printenv`/`env`/`set`/`export -p`/`declare -p`, expanding `*_KEY` / `*_TOKEN` / `*_SECRET` / `*PASSWORD*` / `DATABASE_*` variables, `curl`, `wget`, `ssh`, `nc` and friends, `git push` to `main`/`master`, force pushes, `gh pr merge`, `gh release`, `gh workflow run`, `rm -rf`, and any write to settings, hooks, the installed approver, its policy, its log, `.claude/`, or `.git/` |

`chflags` and `xattr` (and `chattr`, `setfacl`, `chgrp` ...) are fenced: a target on a protected path, above one, or one the approver cannot resolve (`$VAR`, glob, command substitution) is **deny**, because the user-immutable flag can be cleared without sudo. Anywhere else they are ask.

## Install (you run these by hand; agents cannot)

Install, uninstall and mode refuse to run without an interactive terminal and (for mode and uninstall) a typed confirmation, so an agent's shell cannot use them.

```bash
gh repo view --json visibility            # decides --repo-visibility below
node tools/approver/bin/install.mjs --repo-visibility private      # or public
```

It copies the approver and policy to `~/Library/Application Support/claude-approver/`, records checksums in `install.json`, sets files `0444`, folders `0555` and the user-immutable flag (`chflags uchg`, no sudo) on everything except the `mode` file, creates `~/Library/Logs/claude-approver/` (`0700`, log `0600`), starts in **shadow** mode, and **prints** the hook entry, suggested deny rules and the Keychain command. It does not edit any settings file and runs none of the printed commands. Options: `--model-name <id>` (default `claude-haiku-5-5`), `--price-in`/`--price-out` (US$ per million tokens; the defaults are placeholders, **check the Console price list and set them**), `--no-model`, `--install-dir`, `--log-dir`.

### Owner checklist (after the PR is merged)

1. **Create the API key item** (a dedicated key, with a low spend limit set in the Anthropic Console):
   `security add-generic-password -a claude-approver -s claude-approver-anthropic -T /usr/bin/security -w` (it prompts for the key, so it stays out of shell history). The key lives only in the Keychain: never in `.env`, an environment variable, a file, an argument or the log. `-T /usr/bin/security` lets the background worker read it without a dialog; the cost is that any process you run as `/usr/bin/security` can read it too, which is why the approver denies every `security` command and why you add the `Bash(security:*)` deny rule in step 4.
2. **Install:** `node tools/approver/bin/install.mjs --repo-visibility private` (or `public`).
3. **Paste the hook entry** the installer printed into `~/.claude/settings.json` (merge into `hooks`). Timeout 5 s, no `async`, no `onFailure`.
4. **Add the printed deny rules** to your user settings: `Edit`/`Write` on the install and log folders, `Bash(security:*)`, and `"disableBypassPermissionsMode": "disable"`. The rule syntax for a folder with a space in its name is UNCONFIRMED: ask Claude Code to Edit one file in the install folder and check it is refused.
5. **Verify:** `node "$HOME/Library/Application Support/claude-approver/bin/verify.mjs"` prints versions, mode, log path and a checksum for every installed file, and says `VERIFY OK`.
6. **Self-check (one minute):** in an interactive session in this repo, run something that makes a prompt (for example `npm install --dry-run`), press **No**, then run
   `node "$HOME/Library/Application Support/claude-approver/bin/report.mjs" --selfcheck 5`
   and confirm that record shows `not_run` with a reject marker. The marker for an interactive "No" is UNCONFIRMED until you do this (it fails safe: anything unrecognised is `unknown`). Repeat after each Claude Code upgrade.
7. **Stay in shadow for at least 7 days and 200 logged requests**, then read the report (below).
8. Optionally lower the Console spend limit for the key. The script itself stops at US$1.00 per day.

After `brew upgrade node` (or moving node) the hook's node path can vanish and Claude Code then silently falls back to normal prompts: `verify` reports `MISSING OR NOT EXECUTABLE`; fix it with uninstall + install. The installer records the stable `/opt/homebrew/bin/node` link, not the versioned Cellar path.

Remember to change nothing in `.claude/settings.json` because of this PR: M7 does not touch it. Its existing allow rules still run before the hook (for example `git branch:*` also allows `git branch -D`); that is a separate follow-up for you.

## Day to day

| What | Command |
|---|---|
| Shadow report | `node "$HOME/Library/Application Support/claude-approver/bin/report.mjs" [--from 2026-11-05] [--to ...] [--top 10]` |
| Marker check | `... report.mjs --selfcheck 5` |
| Check the install | `... verify.mjs` |
| Switch mode (kill switch = `shadow`) | `... mode.mjs shadow` or `enforce-deny` or `enforce` (terminal, typed confirmation) |
| Drop log records older than 90 days | `... rotate-log.mjs --days 90` |
| Paid check of the model against the corpus | `... live-eval.mjs --i-understand-this-costs-money [--max-usd 0.50]` (refuses to run without the flag; never part of `npm test` or CI) |

The report reads the decision log and the Claude Code session transcripts (read-only, no network, no model). It prints counts by would-be decision and stage, an agreement rate, the **complete** lists of "would have allowed but the call did not run" and "would have denied but it ran", latency, model opinion vs result vs cost, and the ten most frequent asks. `not_run` can also mean a tool error or a block by another hook or rule, not only a human "No"; `unknown` and `ambiguous` records are shown separately and left out of the rate.

### Stages and exit criteria

The order is `shadow` (changes nothing), then `enforce-deny` (prints deny only; everything else still prompts), then `enforce` (prints allow and deny). Once any enforcing mode is on, a deny is always printed as deny. You flip the stage by hand; nothing switches it automatically. These criteria are suggestions; you decide.

- **Exit criteria, shadow to enforce-deny:** at least 7 calendar days and 200 logged requests; zero would-allow-but-you-denied cases (the complete list in the report), or each one understood and the rule fixed; every would-deny that ran looked at; few `unknown` records; `VERIFY OK`.
- **Exit criteria, enforce-deny to enforce:** a week in `enforce-deny` with no wrong deny that you had to work around; the would-allow list still empty; you are comfortable that the allow list is as narrow as you want (look at the top-10 asks and decide what to add, by editing the policy source in a PR).

### Sessions that cannot show a prompt (`-p`, background subagents)

Claude Code treats "no decision" as a denied tool call there. So in `-p` runs and background subagents, **ask becomes deny**. That is safe, but an automated run that relied on prompts will stall on anything the approver does not allow. In `shadow` mode the approver changes nothing in these sessions either. Their records are logged (`permission_mode`, `agent_id` if present) and shown as `headless (-p)` / `subagent` in the report; their outcome is `unknown` because no human answered. Whether subagent payloads carry `agent_id`/`agent_type` is UNCONFIRMED; the approver treats a missing field as normal.

## Uninstall and rollback

- Fastest: set mode `shadow`, or remove the hook entry from `~/.claude/settings.json`. Claude Code is back to normal prompts at once.
- Full: `node "$HOME/Library/Application Support/claude-approver/bin/uninstall.mjs" [--delete-logs]` (terminal, type `UNINSTALL`). It clears the immutable flag, deletes the install folder, keeps the log unless `--delete-logs`, and prints the hook entry for you to remove by hand.
- To upgrade: uninstall, merge the new code, install again.

## What this does not protect

It is one layer, not a sandbox.

- Allowed commands still run code an agent can edit: `npm test`, `npm run lint`, `node --test`, the drills and `git commit` (git hooks). Mitigations: `package.json`, lockfile and vite/vitest config must equal `origin/main`, only `test/` and `worker/test/` files are allowed for `node --test`, `.git/**` writes are denied. A test file or an imported source file an agent edited can still run.
- **Outside this repo the approver is silent** (owner decision Q9/F8), so a session started in another folder gets no protection from it. For the install and log folders, **your own `Edit`/`Write` deny rules (checklist step 4) are the only protection there**, and in `shadow` mode they are the only protection everywhere, because shadow prints no deny.
- The parser models bash; commands actually run in your shell (zsh) with your aliases and functions, which can change what an allowed word does. A bash/zsh difference in here-document handling is closed by refusing any here-doc body line that starts with the delimiter.
- Edits to tool config that changes what allowed commands do (`.npmrc`, `.ignore`, `.rgignore`, `.gitignore`, `.gitattributes`, `.yarnrc*`, `.mcp.json`, `CLAUDE.local.md`) are ask-listed, and every `.git` directory or file at any depth is protected. `.editorconfig`, scripts under `scripts/` and test files are ordinary edits, so the "allowed commands run agent-editable code" point above still applies.
- Anything that does not reach the hook is out of its hands: calls your settings rules already allow, other tools (Read, Glob, Grep, WebFetch, WebSearch, MCP), and other projects (silent by design).
- The checksum is tamper evidence, not protection: whoever can write the install folder can also rewrite `install.json`. Protection is the combination of file modes, the immutable flag, the approver's own deny rules for those paths, your Edit/Write deny rules, and the TTY-only `mode` script. A person at your keyboard, or a process running as you with a terminal, can undo all of it.
- `-T /usr/bin/security` on the Keychain item lets any process that runs `security` as you read the key (see the checklist). The Console spend limit is the backstop.
- The parser covers a large bash subset. Anything it cannot follow is never allowed; a deny hidden in something it cannot read may only reach the normal prompt, not a silent allow. Report gaps.
- Transcript-based outcomes depend on an internal Claude Code format (checked against 2.1.318) and on transcripts not yet being cleaned up (`cleanupPeriodDays`, default 30). Run the report at least weekly.
- Worktrees of this repo in other folders are out of scope (the hook stays silent there).

## Development

```bash
npm test                       # repo root: runs scripts/lib and tools/approver/test (offline, model and Keychain mocked)
node --test tools/approver/test/corpus.test.mjs   # the labelled corpus alone; prints pre-filter share and latency
```

- `test/fixtures/requests.json` is the labelled corpus (id, tool, input, cwd, branch, expected decision, expected stage, category, A1 to A16 tags, injection twins). Add a case for every rule change.
- Tests use temporary folders and a temporary HOME only. `/usr/bin/security` and `chflags` are injected and mocked; no test calls the network, a model, Railway or any live API.
- Changing `tools/approver/` is an ask-listed edit by design, and the root `package.json` test script lists the approver tests, so CI needs no workflow change.
