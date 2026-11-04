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
