# Plan M7: Independent permission approver (PermissionRequest hook)

Author: Engineering Lead. Date: 2026-11-04. Branch: `feat/m7-permission-approver`.
Requirements: `docs/requirements/M7-permission-approver.md` (APPROVED 2026-11-04, Gate 1). The owner answers in its section 7.0 override the defaults in its section 7.
Inputs read: `CLAUDE.md`, the requirements (all), `docs/architecture.md` (§9), `docs/STANDARDS.md`, `.github/workflows/test.yml`, the four `package.json` files (read only), `.claude/settings.json` (read only), the docs check of 2026-11-03.
Nothing in the repo was changed except this file. No settings, hooks, `.claude/`, `.env`, Keychain, production or live API was touched.

---

## 1. Summary

- One **command hook** on `PermissionRequest`, installed at user level by the owner, matcher `Bash|Edit|Write|NotebookEdit`.
- It acts only when the session `cwd` resolves inside this repo. Everywhere else it exits 0 with empty stdout, logs nothing, calls no model.
- The **final decision comes only from a deterministic pre-filter** (allow / deny / ask). Undecided is ask (Q8 b).
- The **model never decides**. For undecided requests only, the hook starts a **detached background worker** that asks the model and appends its opinion to the log. The worker's stdout is `/dev/null`, and the hook has already answered and exited. So the model cannot reach stdout, and it adds no latency to any prompt.
- The model call is a **direct HTTPS call from Node** to the Anthropic API. The key is read from the macOS Keychain into memory with `/usr/bin/security`. It is never in an environment variable, file, argument or log.
- Modes: `shadow` (prints nothing), `enforce-deny` (prints deny only), `enforce` (prints allow and deny). Deny is always hard once enforcing.
- **Shadow correlation reads the session transcript**, which Step A showed records the permission outcome for every tool call (section 3.2). No extra PreToolUse or PostToolUse hook is needed.
- Code in `tools/approver/` (Node built-ins only, no new dependency). Tests run in the root `npm test`, so CI needs **no `.github/workflows/` edit** (one line in the root `package.json` instead).

## 2. Step A: verification results

Claude Code **2.1.318** (`claude --version`), Node v26.11.1, macOS (Darwin 27.0.0). Method as approved: a fresh scratch dir outside the repo, a logging hook (append stdin, empty stdout, exit 0), nested `claude -p --model haiku --setting-sources project --settings '<inline hooks>'`. The scratch dir has no `.claude/`, so no allow rule could pre-approve anything. Five nested sessions, total cost **US$0.0136** (0.0047 + 0.0022 + 0.0022 + 0.0022 + 0.0023). Nothing was written outside the scratch dir. Every Write, Edit, NotebookEdit and Bash request reached `PermissionRequest` and was denied (no file was created or changed).

### 2.1 Payload shapes (values replaced by types)

Common fields on all four PermissionRequest payloads:

```json
{"session_id":"string","transcript_path":"string","cwd":"string","prompt_id":"string",
 "permission_mode":"string","effort":{"level":"string"},"hook_event_name":"PermissionRequest",
 "tool_name":"string","tool_input":{...},"permission_suggestions":[...]}
```

| Tool | `tool_input` shape | Content present? |
|---|---|---|
| Write | `{"file_path":"string","content":"string"}` | Yes, full file content |
| Edit | `{"file_path":"string","old_string":"string","new_string":"string","replace_all":"boolean"}` | Yes, old and new strings |
| NotebookEdit | `{"notebook_path":"string","cell_id":"string","new_source":"string","edit_mode":"string"}` | Yes, new cell source |
| Bash | `{"command":"string","description":"string"}` | n/a |

`permission_suggestions` seen: `[{"type":"setMode","mode":"string","destination":"string"}]` for file tools; Bash adds `{"type":"addDirectories","directories":["string"],"destination":"string"}`. The approver ignores this field.

Other facts:

| Item | Result |
|---|---|
| `tool_use_id` on PermissionRequest | Absent (confirmed). Present on PreToolUse and PostToolUse. |
| `agent_id` / `agent_type` | Absent for main-agent calls. Subagent calls: UNCONFIRMED (not tested). Logged if present. |
| `scratchpad_dir` | Absent (the docs check listed it). Not used. |
| File paths | Absolute in all four payloads. Relative paths are still handled (resolved against `cwd`). |
| `cwd` | Follows the session's Bash `cd`: after `cd sub`, the next PermissionRequest had `cwd` = `.../sub` (run 5). |
| `permission_mode` | `default` in all runs. |
| Optional Bash keys | Not seen here, but the Bash tool schema also has `timeout`, `run_in_background`, `dangerouslyDisableSandbox`. The parser accepts these known keys. Any other key is ask. |

### 2.2 Event order and denial markers

| Question | Result |
|---|---|
| PreToolUse before PermissionRequest for the same call? | **Yes.** Same session, same `prompt_id`, byte-identical `tool_input` (same sha256 of canonical JSON). |
| PostToolUse after a denial? | **Absent** for all four denied calls. Present for calls that ran (Read, ToolSearch). |
| Denial in the transcript? | **Yes.** The `tool_result` record of a denied call has `is_error: true`, a top-level `toolDenialKind` and a top-level `permissionDecision` object. |
| Can a PermissionRequest record be matched to the transcript? | **Yes, exactly.** The transcript `tool_use` block input hashed the same as the PermissionRequest `tool_input` for 4 of 4 calls. The `tool_use.id` then links to the `tool_result`. |

Transcript record shape for a tool result (values replaced):

```json
{"type":"user","sessionId":"string","timestamp":"string","isSidechain":"boolean","entrypoint":"string",
 "version":"string","toolDenialKind":"string (only on denials)",
 "permissionDecision":{"decision":"accept|reject","source":"string","reasonType":"string?","reasonCode":"string?","ruleSource":"string?","grantScope":"string?"},
 "message":{"content":[{"type":"tool_result","tool_use_id":"string","is_error":"boolean?"}]}}
```

Values observed (structure only; no content copied):

| Where | `permissionDecision` | `toolDenialKind` |
|---|---|---|
| Nested `-p`, hook gave no decision | `decision: reject`, `source: config`, `reasonCode: unknown` | `user-rejected` |
| This project's transcripts, owner approved a prompt | `decision: accept`, `source: user_temporary` (also `user_permanent`), with `grantScope`, `reasonCode` such as `bashMiss:*`, `rule:*`, `safetyCheck` | absent |
| This project's transcripts, settings rule or mode | `decision: accept` or `reject`, `source: config`, `reasonType: rule / mode / classifier / subcommandResults / other` | `permission-rule` on rule rejections |
| Session type | `entrypoint: cli` (interactive) vs `sdk-cli` (`-p`). `isSidechain: true` for subagent records. | |

**UNCONFIRMED:** the exact markers when the owner presses "No" in an interactive session. None of this project's transcripts contain one. The design maps any `decision: reject` (or any `toolDenialKind`) to `not_run`, and anything unrecognised to `unknown`. The owner runs a one-minute self-check after install (task T9) that confirms the marker.

### 2.3 Output handling

| Question | Result |
|---|---|
| Plain text `allow` on stdout, exit 0 | Ignored. The call was still denied (run 3). The approver still never prints plain text. |
| `async: true` on PermissionRequest | Accepted (no settings error), the hook ran, the call was denied (run 2). Whether an async hook's output is honoured: UNCONFIRMED. **Not used.** |
| Detached child of a hook | A child started with `detached: true, stdio: 'ignore'` and `unref()` kept running after the hook exited and after the `-p` session ended (run 4). Used for the model worker. |
| Node start-up cost | `node -e ''` about 0.12 s wall on this machine. The 200 ms p95 pre-filter target is tight; see risk R3. |

Left on disk by the verification: the scratch dir, and one transcript folder under `~/.claude/projects/` for the scratch session (persistence was needed for item 2). The owner may delete both.

## 3. Architecture

### 3.1 Flow of one hook call

```
stdin (≤ 4 MiB, 2 s read limit)
 -> parse JSON, check shape                       (bad -> silent ask, logged)
 -> load install.json from the install dir        (bad -> silent ask, best-effort log)
 -> scope: realpath(cwd) inside realpath(repo_root)?  (no -> exit 0, empty stdout, NO log)
 -> mode file (unreadable/unknown -> shadow)
 -> policy.json + policy.md, sha256 vs install.json (mismatch/bad/unknown version -> ask, logged)
 -> pre-filter: Bash rules or path rules -> {decision, rule_id, undecided}
 -> append one log record (failure ignored)
 -> if undecided and model enabled: spawn detached worker, write request to its stdin, unref
 -> output by mode (only here does anything touch stdout), exit 0
```

A watchdog timer exits 0 with empty stdout after 3 s. Uncaught exceptions and rejections exit 0 with empty stdout. The hook `timeout` is 5 s.

### 3.2 Output by mode

| Pre-filter result | `shadow` | `enforce-deny` | `enforce` |
|---|---|---|---|
| deny | empty | deny JSON | deny JSON |
| allow | empty | empty | allow JSON |
| ask or undecided | empty | empty | empty |
| any error | empty | empty | empty |

Allow JSON is exactly `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`. Deny JSON adds `"message":"Denied by the approval policy (rule <id>). Ask the owner if this is needed."`. No command text, no `interrupt`, no `updatedInput`, no `updatedPermissions`. Only `src/hook-io.mjs` may write to stdout, once, as the last step. A test fails the build if any other source file contains `process.stdout` or `console.log`.

### 3.3 Scope check (Q9)

- `install.json` records `repo_root` as a **realpath** taken at install.
- In scope when `rel = path.relative(repoRootReal, realpath(cwd))` is `''` or does not start with `..` and is not absolute. This compares path segments, not string prefixes, and follows symlinks.
- `cwd` comes from Claude Code, not from the agent's tool input. It follows Bash `cd` (Step A), so an agent that `cd`s out of the repo gets normal prompts. Silent is always the safe direction.
- Target paths in the request (Edit/Write path, Bash path arguments) are resolved separately, with the same realpath logic, and judged by the rules. A target outside the repo is ask (or deny when protected).
- Out of scope: exit 0, empty stdout, no log, no model. Git worktrees of this repo elsewhere are out of scope.
- `realpath` of a path that does not exist yet: realpath the deepest existing ancestor, then append the rest. Any `..` left, a null byte or a failure is ask (deny if the text matches a protected or secret pattern).

### 3.4 Branch

Read `<repo_root>/.git/HEAD` directly (no git process, no git config execution). `ref: refs/heads/<name>` gives the branch. A detached HEAD, a missing or odd file, or `.git` being a file gives "unknown", and edits and writes are ask (story 1.3).

### 3.5 Pre-filter: Bash

Two layers. The strictest result across all parts wins: deny > ask > allow (story 3).

1. **Normalise.** Unicode NFKC, then a small confusables table (Cyrillic and Greek lookalikes) to build a "skeleton" of each word. Strip quote splitting and backslashes when building command names (`c"ur"l`, `\curl`, `/usr/bin/curl` all become `curl`). Any non-ASCII byte means no allow (ask at least). Control characters other than tab and newline, or a null byte, mean ask.
2. **Parse** a bash subset into a list of simple commands: operators `&& || ; | & newline`, `( )`, `{ ; }`, `$( )`, backticks, `<( )`, here-docs, redirections, assignments. Unwrap wrappers and judge the inner command too: `env`, `command`, `exec`, `time`, `nohup`, `sudo`, `xargs`, `watch`, `find -exec/-execdir/-ok/-okdir`, `bash|sh|zsh -c '<string>'` and `eval` (the string is parsed recursively, depth ≤ 4). Aliases and functions defined in the same command (`alias x=…`, `f(){ …; }`) are expanded in the same pass, or the command is ask.
3. **Deny scan** runs on every word in command position (after unwrapping), and also on the raw normalised text when parsing fails, so a visible deny item still denies (story 2.5).
4. **Allow** only when parsing fully succeeded and every simple command matches an allow rule exactly. Anything dynamic is not allow: `$VAR`, `${…}`, `$( )`, backticks, `<( )`, here-docs, globs in path arguments, and redirections other than `2>&1`, `>/dev/null`, `2>/dev/null`.

Rules (all ids live in `policy.json`; the Lead interpretations marked † are flagged in section 6):

| Decision | Rule (id) | Covers |
|---|---|---|
| deny | `D-PROD-RAILWAY` | `railway` in any form |
| deny | `D-PROD-PSQL` | `psql`, `pg_dump`, `pg_restore` with a non-local or unparsable host (`-h`, `--host=`, `host=`, URL, `PGHOST=`, `$DATABASE_*`) (A13) |
| deny | `D-PROD-VARS` | `DATABASE_PUBLIC_URL`, `WEEKLY_CONFIRM_PROD`, `BACKUP_CONFIRM_PROD` anywhere in the text (A12) |
| deny | `D-SECRET-ENVFILE` | any path-like word (no whitespace) matching `.env*` or `*/.env*` (A14) |
| deny | `D-SECRET-PATH` | `secrets/`, `~/.ssh/`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `~/Library/Keychains/` |
| deny | `D-SECRET-KEYCHAIN` † | `security` with any subcommand |
| deny | `D-SECRET-ENVDUMP` † | `printenv`, bare `env`, bare `set`, `export` / `export -p`, `declare -p`/`-x`, `typeset -p`, `ps` with the `e` flag; `$NAME` where NAME matches `*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `DATABASE_*` |
| deny | `D-NET` † | `curl`, `wget`, `nc`/`ncat`/`netcat`, `socat`, `telnet`, `ssh`, `scp`, `sftp`, `rsync` to a remote, `ftp`, `http`/`https` (httpie), `xh`, `aria2c`; `gh api` with a write method, `-f`/`-F`/`--input`; `gh gist create` |
| deny | `D-GIT-MAIN` | push whose refspec targets `main` or `master` in any form (`main`, `x:main`, `HEAD:refs/heads/main`), `--all`, `--mirror` (A15) |
| deny | `D-GIT-FORCE` | `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `+refspec` |
| deny | `D-GH` | `gh pr merge`, `gh release *`, `gh workflow run` |
| deny | `D-RM-RF` | `rm` with both a recursive and a force flag in any spelling (`-rf`, `-fr`, `-r -f`, `--recursive --force`) |
| deny | `D-SELF` | any write-capable command (`>`, `>>`, `tee`, `sed -i`, `perl -pi`, `cp`, `mv`, `rm`, `ln`, `chmod`, `chown`, `chflags`, `touch`, `truncate`, `dd`, `install`, `python -c`, `node -e`, `git` write ops) whose path resolves to a protected path (3.7); any execution of a file in the install dir |
| ask | `K-INSTALL` | `npm install/i/ci/add`, `pip install`, `yarn add`, `pnpm add`, `brew install` |
| ask | `K-SYS` | `kill`, `pkill`, `killall`, `chmod`, `chown`, `sudo`, `launchctl` |
| ask | `K-WEB` | (Bash has none left after `D-NET`; WebFetch and WebSearch are not matched by the hook) |
| ask | `K-SELF-READ` | read-only commands on protected paths (story 9.5) |
| ask | `K-DEFAULT` | anything else not matched (undecided; the model worker may run) |
| allow | `L-READ` | `ls`, `grep` (not `-r`/`-R` unless `--exclude=.env*`), `rg` (not `-u*`, `--hidden`, `--no-ignore*`, `-L`, `--pre`), `sed -n` with a print-only script (A2), `head`, `tail`, `wc`, `find` with read-only predicates only (A9), `cat` (A1). Every path argument must resolve to an **existing** path inside the repo and not to a secret or protected path (A11). |
| allow | `L-CD` | `cd <dir>` to an existing repo subfolder, before allowed commands (relative paths after it resolve from the new dir) |
| allow | `L-GIT-READ` | `git status`, `diff`, `log`, `show` without `--output*`, `--ext-diff`, `-c`, `--exec-path` or other global options (`--no-pager` is fine) |
| allow | `L-GIT-BRANCH` | `git branch` list forms only (A4) |
| allow | `L-GIT-ADD` / `L-GIT-COMMIT` | `git add <paths>`; `git commit` without `--amend`, `--no-verify`, `-n` (A5) |
| allow | `L-GIT-NEWBRANCH` | `git checkout -b` / `git switch -c` with `^(feat\|fix)/[A-Za-z0-9._/-]+$`, no `..`, no extra arguments (A3) |
| allow | `L-GIT-PUSH` | exactly `git push origin feat/<name>` or `git push origin fix/<name>` (A15) |
| allow | `L-GH` | `gh pr create` (flags from a fixed list), `gh pr view/checks/diff <n>` (no `--web`, no `-R`); `gh pr comment <n> --body '<literal>'` **only when `repo_visibility` is `private`** (A6, Q10) |
| allow | `L-TEST` | `npm test`, `npm run lint`, guarded by A8 (below); `node --test <file>` where the file matches `^(worker/)?test/[A-Za-z0-9._-]+\.test\.(js\|mjs)$` relative to `cwd` (A7) |
| allow | `L-DRILL` | exactly `npm run db:backup:drill` or `zsh scripts/weekly-drill.sh` with `cwd` = repo root, no prefix, no extra words (A12) |

**A8 guard (`npm test`, `npm run lint`).** Run `git -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --quiet --no-ext-diff --no-textconv refs/remotes/origin/main -- <pkg>/package.json <pkg>/package-lock.json <pkg>/vite.config.* <pkg>/vitest.config.*` with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, a minimal env and a 1.5 s timeout. Exit 0 means allow; anything else is ask. The compare base is **`origin/main`, not `HEAD`** (flag F5): the agent may commit freely, so "clean against HEAD" proves nothing.

**`gh pr comment` and "public" (Q10).** The hook makes no network call to find out. The owner sets `repo_visibility` (`private` | `public`) in `install.json` at install with a required flag. Missing or any other value counts as unknown, and unknown is ask. The install script prints the `gh repo view --json visibility` command for the owner to run by hand; it does not run it.

### 3.6 Pre-filter: Edit, Write, NotebookEdit

The path is `file_path` or `notebook_path`. Content, `old_string`, `new_string` and `new_source` are never read, logged or sent to the model (only the content length is logged).

| Order | Target (after realpath) | Decision |
|---|---|---|
| 1 | Protected path (3.7) | deny `D-SELF` |
| 2 | `.env*` anywhere | deny `D-SECRET-ENVFILE` |
| 3 | Outside the repo | ask `K-OUTSIDE` |
| 4 | Approver source `tools/approver/**` | ask `K-SELF-SRC` (story 9.1) |
| 5 | Ask list: `.github/**`, `ops/**`, any `package.json`, lockfiles, `db/schema.sql`, `db/migrations/**`, `Dockerfile*`, `*.plist`, any `CLAUDE.md` | ask `K-PATH` |
| 6 | Branch unknown, `main` or `master` | ask `K-BRANCH` |
| 7 | Otherwise | allow `L-EDIT` |

Missing path, wrong type, unknown key in `tool_input`, or an unresolvable path is ask.

### 3.7 Protected paths (self-protection, story 9)

Deny for writes and execution, ask for reads:

- the install dir, the log dir, and every file in them;
- any `.claude/` directory anywhere, `~/.claude/**`, any `settings*.json` under a `.claude` dir, the managed settings dir `/Library/Application Support/ClaudeCode/`;
- `.git/**` inside the repo † (git hooks and git config are code the approver and git run; see F6);
- the realpath of every symlink is used, so a repo symlink to a protected path is that path (story 9.4).

### 3.8 Policy files and integrity

| File | Purpose |
|---|---|
| `policy.json` | Machine rules: `policy_version`, rule ids and messages, command lists, regexes, ask-list paths, secret patterns, protected path list (install and log dirs are filled in at install). Unknown `policy_version` is ask for everything. |
| `policy.md` | Appendix A verbatim. Used only as text in the model prompt and for humans. |
| `install.json` | `approver_version`, `repo_root`, `repo_visibility`, `node_path`, `install_dir`, `log_dir`, model settings, Keychain service and account names, sha256 of every installed file. |
| `mode` | One word: `shadow`, `enforce-deny` or `enforce`. |

Every hook call hashes `policy.json` and `policy.md` (they are read anyway) and compares them with `install.json`. A mismatch is ask for every request, logged with `error: "policy_checksum_mismatch"`, and no model call. `verify` also checks the code files.

The checksum is tamper evidence, not protection: whoever can write the install dir can also rewrite `install.json`. Protection comes from four layers: (1) files `0444`, dirs `0555`, and the user-immutable flag `chflags uchg` on everything except `mode`, set by the install script without sudo; (2) the pre-filter `D-SELF` deny; (3) the owner's own Edit/Write deny rules for the two dirs, which the install script prints; (4) the owner-only `mode` script, which refuses to run without an interactive TTY and a typed confirmation, so an agent's Bash (no TTY) cannot use it.

### 3.9 Locations

| What | Path (Q3, Q4 defaults) | Perms |
|---|---|---|
| Install dir | `~/Library/Application Support/claude-approver/` (`src/`, `policy.json`, `policy.md`, `install.json`, `mode`) | dir 0555 + `uchg`; files 0444 + `uchg`; `mode` 0644 |
| Log dir | `~/Library/Logs/claude-approver/` | 0700 |
| Decision log | `decisions.jsonl` | 0600 |
| Model state | `spend-YYYY-MM-DD.jsonl`, `breaker.json`, `model.lock` | 0600 |

The path contains a space, so the printed hook command quotes both the node path and the script path. Whether permission-rule syntax handles the space in `Edit(...)` rules is UNCONFIRMED; the install doc tells the owner to test one deliberate Edit to that dir after pasting.

### 3.10 Decision log (story 7)

One JSON line per in-scope call, written with a single `fs.writeSync` on an `O_APPEND` fd (records capped at 8 KiB, so each is one atomic append). Fields: everything in story 7.2, plus `record_id` (random), `transcript_path`, `permission_mode`, `agent_id`/`agent_type` if present, `rule_id`, `undecided` (bool), `input_size`, `truncated`. `stage` is always `prefilter` in v1. The model writes a second linked record: `{type:"model", record_id, model, model_decision, model_reason (redacted, ≤ 200 chars), latency_ms, model_cost_usd, skipped (reason or null), error}`.

Redaction runs before writing, on every string field: story 7.3 patterns plus `sk-ant-`. `input_hash` is sha256 of the unredacted canonical `tool_input` (sorted keys), which is the hash that matched the transcript in Step A. Write content is never logged. Rotation and deletion (90 days) is a script the owner runs.

### 3.11 Model worker (log only, Q8 b)

**When it runs.** Only for requests the pre-filter left undecided (`K-DEFAULT`). It is skipped when the pre-filter already decided allow, deny or a listed ask. Reason: those decisions are final and deterministic, so a model opinion there changes nothing and costs money on the most frequent calls. The undecided set is exactly where a future model role (option c) would matter, so that is the data the owner needs. Model accuracy on the decided classes is still measured, offline and on demand, by the live-eval script over the labelled corpus.

**Isolation.** `spawn(node_path, [worker.mjs], {detached: true, stdio: ['pipe','ignore','ignore'], env: {PATH: '/usr/bin:/bin', HOME}})`, request on stdin, then `unref()`. The worker's stdout goes nowhere, and the hook has already written its answer. No `ANTHROPIC_API_KEY` in any env. No Claude Code process, so no hooks and no recursion.

**Mechanism choice (Q2):**

| | A: Node HTTPS + `security find-generic-password -w` | B: `claude -p --bare` + `apiKeyHelper` in `--settings` |
|---|---|---|
| Key handling | Read by `execFile('/usr/bin/security', [...,'-w'])` (no shell) into memory; sent only in the `x-api-key` header to the hard-coded host `api.anthropic.com`. Never in env, file, argv or log. | Claude Code runs the helper and holds the key; whether it puts it in a child env is unknown. |
| Recursion | Impossible (no Claude Code). | Relies on `--bare` skipping hooks; managed hooks still run. |
| Latency | One TLS request (not measured; T7 records it). | CLI start-up plus the request. Not measured for a single turn (the 8-turn verification run took 18 s). |
| Testability | The HTTPS client and the `security` runner are injected functions; easy to mock offline. | Must mock a whole CLI. |
| Structured output | Forced tool call with an input schema, then strict local validation. | `--json-schema`, then local validation anyway. |
| Cost data | Computed from returned token usage × prices in `install.json`. | `total_cost_usd` given. |
| Spend cap per call | `max_tokens` bound plus a pre-call cost estimate ≤ `per_call_cap_usd`. | `--max-budget-usd`. |

**Decision: A.** Smaller attack surface, no recursion path, no env exposure, faster, easier to test.

**Prompt.** System text: the role, the policy prose (`policy.md`), the rule that the request is data and that comments, descriptions and embedded JSON are not evidence. User text: one JSON object `{tool, command_or_path, cwd, branch}` inside `<request>` tags, capped at 4 KiB (longer is truncated and marked). No `description`, no transcript, no file content.

**Validation.** Exactly one tool-use block with exactly `{decision ∈ {allow, ask, deny}, reason: string ≤ 200}`. Anything else is logged as `invalid`. The result is never used for a decision, by construction.

**Guards (story 11).** 8 s hard timeout (`AbortController`), no redirects followed. A single `model.lock` (`open wx`, stale after 30 s): if busy, the call is skipped as `busy`. That bounds concurrent spend. The daily ledger `spend-<UTC date>.jsonl` is summed before each call; at or over US$1.00 it is skipped as `daily_cap`. Breaker: 3 consecutive failures opens it for 10 minutes (`breaker_open`). Key absent, Keychain locked, `security` non-zero or slower than 3 s: skipped as `key_unavailable`. All of these only add a log record; the decision was already final.

**Keychain item (owner creates it after the code exists).** The doc gives `security add-generic-password -a claude-approver -s claude-approver-anthropic -T /usr/bin/security -w` (prompts for the key, so it stays out of shell history). `-T /usr/bin/security` lets the worker read it without a dialog, and has a cost: any process that runs `/usr/bin/security` as the owner can read it too. Hence `D-SECRET-KEYCHAIN` denies every agent `security` command, the owner is advised to add a `Bash(security:*)` deny rule, and the Console spend limit is the backstop (flag F4). Locked-keychain behaviour (a GUI unlock dialog?) is UNCONFIRMED; the 3 s kill limits it, and T9 includes an owner check.

**The conflict, managed.** The approver's own Keychain read is not an agent command: it runs inside the worker process, never through the Bash tool. Agent commands that read the Keychain stay denied by `D-SECRET-KEYCHAIN` and `D-SECRET-PATH`, and running anything from the install dir is denied by `D-SELF`.

### 3.12 Shadow correlation and report (stories 5, 6)

**Choice: transcript-based** (flag F1). Each log record carries `session_id`, `transcript_path`, `tool_name`, `input_hash` and `ts`. The owner-run report:

1. Validates `transcript_path` (realpath under `~/.claude/projects/`, ends in `.jsonl`). It also searches that session's `subagents/` folder, because the path a subagent request reports is UNCONFIRMED.
2. Streams the transcript and keeps only: `tool_use` (`id`, `name`, hash of `input`, `timestamp`), and per `tool_result`: `tool_use_id`, `is_error`, `permissionDecision`, `toolDenialKind`, `entrypoint`, `isSidechain`. Content is never stored or printed.
3. Matches a record to the closest preceding `tool_use` with the same name and input hash, within 120 s. Two or more unmatched candidates mean `ambiguous`.
4. Maps the outcome:

| Transcript | `observed_outcome` | Detail |
|---|---|---|
| `decision: accept`, `source: user_*` | `ran` | owner approved |
| `decision: accept`, other source | `ran` | other |
| `decision: reject` or any `toolDenialKind` | `not_run` | the kind |
| `tool_use` but no `tool_result` | `unknown` | interrupted |
| transcript missing, unreadable, or markers absent | `unknown` | `format_unrecognized` (shown as a warning with the Claude Code version) |
| `entrypoint: sdk-cli` (`-p`) | `unknown` | no human (story 13.4) |
| repeated identical candidates | `ambiguous` | |

`auto_allowed` is reported as a separate count of in-repo tool calls in the same sessions whose `permissionDecision` has `source: config` and `reasonType: rule`. They never reached the hook. The report states plainly that `not_run` can also mean a block by another hook or a rule, not only a human "No" (story 5.5).

Why not PreToolUse/PostToolUse hooks: Step A showed the transcript gives an exact join (by input hash, then `tool_use_id`) and distinguishes the owner's answer from rule decisions. Extra hooks would start Node on every tool call, including every Read and Grep (~0.1 s each), and still only see "ran / did not run". Cost of this choice: the transcript format is internal and may change, and transcripts are cleaned up after `cleanupPeriodDays` (default 30). Mitigation: unknown format becomes `unknown` with a warning, and the report is run at least weekly.

**Report contents:** story 6.1 to 6.6, plus the Q14 top-10 most frequent asks (by `rule_id` and redacted command shape), the split interactive / `-p` / subagent, and a model section: model would-be decision vs the final pre-filter decision vs the observed outcome, for undecided requests, with skip-reason counts and total cost. Read-only, no network, no model.

### 3.13 Hook configuration the install script prints (owner pastes it into `~/.claude/settings.json`)

```json
{"hooks":{"PermissionRequest":[{"matcher":"Bash|Edit|Write|NotebookEdit","hooks":[
  {"type":"command","command":"'<node_path>' '<install_dir>/src/approver.mjs'","timeout":5}]}]}}
```

No `async`, no `onFailure`. Timeout 5 s, not the 12 s default of story 11.2: the hook no longer waits for the model, and the model's own 8 s limit is unchanged and lives in the worker. The hook also checks `tool_name` itself and is silent for any other tool, so a matcher grammar surprise cannot widen its effect.

It also prints the recommended deny rules for the owner to consider (not applied): `Edit(...)`/`Write(...)` for the install and log dirs, `Bash(security:*)`, and `permissions.disableBypassPermissionsMode: "disable"`.

### 3.14 Code layout (`tools/approver/`)

```
tools/approver/
  README.md                 install, verify, mode switch, report, rotate, uninstall/rollback,
                            -p and subagent behaviour, stage exit criteria, "what this does not protect"
  policy/policy.sample.json  machine rules (version 1)
  policy/policy.md           Appendix A verbatim
  src/approver.mjs           hook entry (orchestration only)
  src/hook-io.mjs            bounded stdin, output builders, the only stdout writer
  src/config.mjs             install.json, mode, policy load, checksums
  src/paths.mjs              realpath resolution, scope check, protected/secret/ask-list matching, branch
  src/shell/normalize.mjs    NFKC, confusables, quote/backslash stripping
  src/shell/parse.mjs        bash-subset tokenizer and parser, wrapper unwrapping
  src/rules/bash.mjs         deny/ask/allow per simple command, A8 git guard (injected runner)
  src/rules/files.mjs        Edit/Write/NotebookEdit table (3.6)
  src/prefilter.mjs          combine parts, strictest wins
  src/log.mjs                redaction, size caps, atomic append, perms
  src/model/worker.mjs       detached entry
  src/model/client.mjs       HTTPS call (injected transport), schema validation
  src/model/keychain.mjs     execFile /usr/bin/security (injected)
  src/model/budget.mjs       ledger, lock, breaker
  bin/install.mjs  bin/uninstall.mjs  bin/verify.mjs  bin/mode.mjs  bin/report.mjs
  bin/rotate-log.mjs  bin/live-eval.mjs (refuses to run without --i-understand-this-costs-money)
  test/*.test.mjs
  test/fixtures/requests.json      labelled corpus
  test/fixtures/transcripts/*.jsonl synthetic transcripts built from the 2.2 shape
```

`install`, `uninstall` and `mode` refuse to run without an interactive TTY. `install` copies files, fills in the dirs, writes `install.json`, sets perms and `uchg`, starts in `shadow`, and **prints** the hook config. It never edits a settings file. `uninstall` prints the hook entry to remove, then clears `uchg` and deletes the install dir; the log is kept unless `--delete-logs`.

### 3.15 Tests and CI

- `node:test` + `node:assert/strict`, offline, model mocked (STANDARDS §2). macOS-only pieces (`security`, `chflags`) are injected, so the suite runs on the Ubuntu CI runner.
- **CI without a workflow edit:** the root job already runs `npm test`. Change the root `package.json` test script to `node --test 'scripts/lib/*.test.mjs' 'tools/approver/test/*.test.mjs'`. No dependency change. This replaces story 10.9's assumption that `.github/workflows/test.yml` must change, and so removes that owner-approval item. The `package.json` edit is itself in the policy's ask list and is reviewed by Sec.
- Corpus target: about 100 requests (minimum 70 by the story 10.2 category minimums). Each item has `id, tool, input, cwd, branch, repo_visibility, expected, expected_stage, category, ambiguity` (A1 to A16 tagged once each at least).
- The corpus runner checks: expected decision per item; every injection case equals its clean twin (story 10.4); the "no allow output" fault matrix (story 1.8); a mocked always-allow, invalid-JSON, extra-field and hanging model never changes stdout (story 10.6); the 80 % pre-filter share (reported, not a gate); and pre-filter p95 latency (reported).
- Test repos are temporary directories with a fake `.git/HEAD`, plus one real `git init` for the A8 guard (git exists on the runner).

## 4. Tasks (one Developer, one PR, one commit per task)

| # | Task | Files | Done when | Covers |
|---|---|---|---|---|
| T1 | Hook skeleton and fail-closed shell: bounded stdin, shape check, `install.json`, mode, policy load and checksum, scope check, branch from `.git/HEAD`, watchdog, uncaught handlers, output by mode, stdout lint test | `src/approver.mjs`, `hook-io.mjs`, `config.mjs`, `paths.mjs` (scope, branch), `test/io.test.mjs`, `test/config.test.mjs`, root `package.json` test script | Fault matrix (bad/empty/oversized stdin, unknown tool, bad `tool_input`, missing/bad/mismatched policy, bad mode, out of scope, crash, hang) gives empty stdout, exit 0; mode table 3.2 holds; out of scope writes no log | S1.1–1.5, 1.7–1.8; S5.1, 5.8; S8.5; S12.1–12.4, 12.6; Q9 |
| T2 | Logging and redaction | `src/log.mjs`, `bin/rotate-log.mjs`, `test/log.test.mjs` | Fake-secret test finds none of them in the file; caps and `truncated`; 0600/0700; concurrent appends (20 child processes) give valid lines; log failure keeps stdout empty | S7.1–7.8; S5.7 |
| T3 | Shell normaliser and parser | `src/shell/*.mjs`, `test/shell.test.mjs` | All story 2.2 forms produce the inner commands; 2.5 cases flagged "not fully parsed"; 2.6 normalisation cases | S2.2, 2.5, 2.6 |
| T4 | Policy file and Bash rules | `policy/policy.sample.json`, `policy/policy.md`, `src/rules/bash.mjs`, `src/prefilter.mjs`, `test/bash-rules.test.mjs` | Every row of table 3.5; deny messages contain no arguments; A1–A6, A8, A9, A11–A16 cases; A8 guard via injected runner plus one real temp repo | S2.1, 2.3, 2.4, 2.7; S3.1–3.3, 3.7; Q10 |
| T5 | File rules and self-protection | `src/rules/files.mjs`, `src/paths.mjs` (resolution, protected/secret lists), `test/files.test.mjs` | Table 3.6 in order; symlink to `.env`, to the install dir and to `~/.claude` (temp dirs); `..` and `~` cases; A7, A10; Bash write forms on protected paths deny | S9.1–9.6; S1.3 |
| T6 | Labelled corpus and runner | `test/fixtures/requests.json`, `test/corpus.test.mjs` | ≥ 70 items meeting every category minimum; injection twins equal; prints the pre-filter share and p95 | S10.1–10.4, 10.7; S3.8; S11.1 |
| T7 | Model worker | `src/model/*.mjs`, spawn in `approver.mjs`, `bin/live-eval.mjs`, `test/model.test.mjs` | Mocked transport: valid, invalid, extra fields, always-allow, hang (killed at 8 s, test uses a short injected timeout); key absent; lock busy; daily cap; breaker open and close; no env var holds the key (spawn env asserted); worker output never reaches the hook's stdout; skipped when pre-filter decided; live-eval refuses without its flag | S4.1–4.8 (as re-scoped by Q8 b); S5.2; S10.5, 10.6, 10.8; S11.2–11.6; Q2 |
| T8 | Report with transcript correlation | `bin/report.mjs`, `test/report.test.mjs`, `test/fixtures/transcripts/` | Synthetic transcripts give each outcome row of 3.12; ambiguous and unknown excluded from the rate; complete would-allow-but-not-run list; top-10 asks; model section; empty log message; no network (asserted by stubbing `net`/`https`) | S5.4, 5.5; S6.1–6.6; S13.3, 13.4; Q14 |
| T9 | Install, verify, mode, uninstall scripts and docs | `bin/install.mjs`, `verify.mjs`, `mode.mjs`, `uninstall.mjs`, `tools/approver/README.md`, `test/install.test.mjs` (temp HOME, `chflags` injected), `docs/architecture.md` new §7.10, README command row | Install into a temp HOME prints the hook JSON and deny-rule suggestions, sets perms, writes checksums, mode `shadow`; `verify` prints versions, mode, checksums, log path; non-TTY refusal; README has the owner checklist below | S8.1–8.4, 8.6–8.8; S12.2, 12.5; S13.1; NFR docs |

Owner checklist in the README (T9), after merge: create the Keychain item; run `install` with `--repo-visibility`; paste the hook entry; optionally add the printed deny rules; run `verify`; **self-check**: in an interactive session, deliberately press "No" on one in-repo prompt, then run `report --selfcheck` and confirm it shows `not_run` with the observed marker; test one Edit to the install dir is refused; leave `shadow` for at least 7 days and 200 records (Q6).

## 5. Reviews needed

- **QA:** always. Focus: the corpus, the fault matrix, the mode table, the report on synthetic transcripts.
- **Security: required.** The change is a security control. It parses untrusted agent input, handles an API key in the Keychain, makes an outbound HTTPS call, writes logs that could hold secrets, sets file permissions, and changes the root `package.json`. Sec should also attempt bypasses of the parser and of the scope check.

## 6. Flags for the owner

None of these changes a product requirement. F1–F3 change a mechanism the requirements described. F4–F10 are Lead interpretations or residual risks the owner should know before enforcing.

| # | Item | Default in this plan |
|---|---|---|
| F1 | Shadow outcome comes from the session transcript, not from PreToolUse/PostToolUse hooks (story 5.4 wording). More exact, no extra hooks. Depends on an internal format; the interactive "No" marker is UNCONFIRMED until the owner's self-check. | Transcript. |
| F2 | The model runs in a detached background worker, so it never delays a prompt. Hook timeout 5 s instead of 12 s; the model keeps its 8 s limit. | As planned. |
| F3 | Direct HTTPS API call, not `claude -p --bare`. | As planned. |
| F4 | `-T /usr/bin/security` on the Keychain item: any process running `security` as the owner can read the key without a dialog. Without it, macOS would show a dialog on every background read. | Use `-T`, deny all agent `security` commands, recommend a `Bash(security:*)` deny rule and a low Console limit. |
| F5 | A8 compares `package.json` with `origin/main`, not with `HEAD`, because the agent can commit. Stricter than A8's wording. Any `package.json` change on a feature branch makes `npm test` ask until merged (including this PR's own). | `origin/main`. |
| F6 | Hard denies beyond the literal policy words: `ssh`/`scp`/`sftp`/`rsync`/`nc`/`telnet` (as "posts data out"); every `security` subcommand; writes to `.git/**`; env-dump forms (`set`, `export -p`, `declare -p`, `ps e`); expanding secret-named variables (`$*_KEY`). Any of these can be moved to ask before enforcing. | Deny. |
| F7 | A14 taken literally: `.env.example` matches `.env*`, so `cat .env.example` and edits to it are deny. | Deny (owner may carve out `.env.example` as ask). |
| F8 | Silent outside the repo (Q9) means another project's session gets no approver protection for the install dir. The owner's deny rules (printed by install) are the cover. | As chosen by the owner. |
| F9 | Literal push (A15): `git push -u origin feat/x` is ask. Likely a top ask in the report. | Ask; widen after shadow if wanted. |
| F10 | A7 literal: `node --test scripts/lib/x.test.mjs` and `tools/approver/test/...` are ask; only `test/` and `worker/test/` paths allow. | Ask. |
| F11 | CI coverage through the root `package.json` test glob, so no `.github/workflows/` edit is needed. | As planned. |
| F12 | Existing `.claude/settings.json` allow rules (`git branch:*`, `git checkout -b:*`, `pytest:*`) pre-approve calls before the hook ever sees them (Q12). Unchanged by M7. | Owner follow-up. |

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A parser gap turns a deny into an allow. | Allow requires a full parse and an exact match; dynamic constructs are never allow; deny scan also runs on raw text; large obfuscation set; Sec bypass attempts; shadow first. |
| R2 | Transcript format changes in a Claude Code update. | Unknown markers become `unknown` with a version warning; the report rate excludes them; self-check after each Claude Code upgrade (README). |
| R3 | Node start-up (~0.12 s) plus work misses the 200 ms p95 target. | Few small modules, no heavy imports, git only for the A8 guard; measured in T6; it is a target, not a gate. |
| R4 | Locked Keychain shows a dialog from the background worker. | 3 s kill, `key_unavailable` logged; owner check in T9. |
| R5 | Allowed commands (`npm test`, `node --test`, the drills, `git commit` running git hooks) still run agent-written code. | A7, A8 (vs `origin/main`), `.git/**` writes denied; "what this does not protect" section. |
| R6 | `cwd` matches the repo while a relative path name exists both in and out of the repo. | `cwd` comes from Claude Code and follows `cd` (verified); read paths must exist inside the repo after realpath. |
| R7 | Subagent payloads differ (`agent_id`, transcript path). | Fields optional; report searches `subagents/`; unexpected shape is ask. |
| R8 | Install path with a space breaks a printed rule or command. | Quoting in the printed command; owner tests one deliberate Edit after install. |

## Handoff

- **Done:** Step A verification against Claude Code 2.1.318 (5 nested `-p` sessions, US$0.0136; payload shapes, event order, transcript denial markers, plain-text stdout, `async`, detached child, `cwd` after `cd`). Wrote the plan.
- **Files created:** `docs/plans/M7-permission-approver.md`. Scratch only: `/private/tmp/claude-501/-Users-jayprox-pro-Documents-Projects-git-ai-application-nba/4aea983d-bbc6-4d98-8d2c-164828f19465/scratchpad/m7-verify/`. A transcript folder for the scratch session was created under `~/.claude/projects/` by the nested run (needed for item 2). Nothing committed.
- **Open questions for the owner:** flags F1–F12 in section 6, mainly F1 (transcript correlation), F5 (A8 vs `origin/main`), F6 (extra hard denies) and F7 (`.env.example`). UNCONFIRMED: the interactive "No" transcript marker, subagent payload fields, locked-Keychain behaviour, and the `Edit(...)` rule syntax with a space in the path. Each fails safe, and each has a check in T9.
- **Recommended next role:** Coordinator, to put section 6 to the owner, then Developer for T1–T9 on this branch; QA and Security review after.
