# M5 Security review: weekly job through the Railway CLI tunnel (PR #6)

`VERDICT: READY WITH CONDITIONS`

No Blocker or Major findings. The production guard, the test-hook gate, the credential flow and the process control all hold up under static review, the unit tests, adversarial probes and a full local drill. There are four Minor findings. Two of them (1 and 2) let a non-production backup count as the "pre-write backup" for a real run. Both need deliberate misconfiguration or a manual ad-hoc fake run, but they weaken the owner's Gate 1 rule, so the condition is: fix 1 before the first real run, or have the owner accept it at Gate 2. Findings 2-4 can be follow-ups.

## 1. Scope and tools

- **PR:** #6. **Branch:** `feat/weekly-tunnel`. **Head:** `b49fcc3b1fb566563c255d4c8188b11b09e4df4d` (local and origin match). **Base:** `main`. Six commits; T1 (`e4a1abc`) is the tunnel extraction.
- **Read:** `CLAUDE.md`, "Mission M5" in `docs/STATUS.md`, `docs/plans/M5-weekly-tunnel.md`, `docs/reviews/M4/security.md`, and the full diff. Read fully: `scripts/weekly.mjs`, `scripts/weekly.sh`, `scripts/lib/weekly.mjs`, `scripts/lib/tunnel.mjs`, the `backup-db.mjs` and `backup.mjs` diffs, both fixtures, the plist and package.json. Also read the guard harness of `scripts/weekly-drill.sh`, `scripts/lib/env.mjs`, and the DB access of the four step scripts.
- **Commands (all local; prod flags unset; real `railway` CLI never invoked; no plist loaded):**
  - `npm test`: **76/76 pass**.
  - `zsh scripts/weekly-drill.sh` (throwaway `postgres:18`, `hdiutil` image, fake railway): **153 passed, 0 failed, rc=0**. Before the run, no listener on 55432-55434.
  - Ad-hoc probes of `weeklyGuard`, `loadWeeklyConfig` (port and season), `stepEnv`, `stepArgv` and `lineRedactor`, with adversarial inputs (results below).
  - Ran `ps eww` / `ps -E` against a same-user child that had an env marker set. The env was **not** visible on this host (Darwin 27).
  - `gh pr checks 6`: backend, frontend, root and worker all pass (run 41683723531).
  - Secret-pattern grep over `git log -p main..HEAD`, plus a check for added `.env`, key or pem files. Matches were only templated (`$PW`) or test strings (`u:p`). No real secret found.
- **Scanners:** `gitleaks`, `semgrep`, `trivy` and `osv-scanner` are not installed, so none were run. `npm audit` was not needed because no dependency changed (§3).

## 2. Findings

### Confirmed properties (verified, high confidence)

- **The production guard is strict, off by default, and runs first.** At `scripts/weekly.mjs:241-243`, the guard runs after config parsing and before the lock, `which`, `whoami`, the backup or any child. `confirmGuard` (`scripts/lib/backup.mjs`) accepts the flag only if it is exactly `"1"`.
  - Probe results: unset, `true` and `"1 "` are refused. `WEEKLY=1` alone is refused. `WEEKLY=1 BACKUP=1` passes.
  - Fake weekly with a real backup is refused, with or without `BACKUP_CONFIRM_PROD=1`.
  - A **copy** of the fake is refused. A symlink to the fake, and a `..` path to the fake, are exempt. This is correct, because the realpath is the repo fixture.
  - Fake weekly with `WEEKLY_CONFIRM_PROD=1` and a real backup is still refused.
  - The guard reads only env; argv carries only the season. The drill's W1/W2/W23 cases passed, and the shadow `railway` was never called.
- **The `WEEKLY_STEP_FIXTURE` hook cannot reach production.**
  - It is honoured only if `isFakeBin(WEEKLY_RAILWAY_BIN)` (`weekly.mjs:243`). The guard then also forces the backup bin to be the fake (`lib/weekly.mjs:76-79`).
  - It swaps in one fixed relative path (`FIXTURE_STEP`, cwd = repo), not a caller-supplied command. `status` always stays the real read-only script.
  - W23 confirmed this: shadow bin, both flags and the hook gave `FAIL stage=preflight`, before the lock and any CLI call.
- **Credential flow.**
  - The URL is built in memory (`buildTunnelUrl`) and passed **only** in the step child's env (`weekly.mjs:269`, `stepEnv`, which strips both prod flags).
  - `railway`, `whoami` and the backup child get `process.env`, which never holds the URL.
  - argv is `[script, --season, S]`. The W5 ps sampler found no password in any argv.
  - `tunnel.json` holds pids, lstart, the port and the bin path only, mode 0600 in a 0700 dir, under `umask 077`.
  - Log lines and the notification text are fixed. The `Fail` reasons are fixed strings or error codes, never the error message.
  - `url`, `secrets` and `creds` are cleared in `finally`. The drill's `secret_scan` passed on every case, including W22 (the fixture prints the URL to stdout and stderr).
- **Step env precedence.** `loadEnv()` lets the process env win over `.env` (`env.mjs:16`). All four steps take their DB only from `publicDbUrl()`, so a stale `.env` URL cannot redirect the writes.
- **Process control is unchanged from M4.**
  - `tunnel.mjs` is a line-for-line move of the M4 functions: `sshTargets`, `stopSsh`, `reapOrphans`/`reapDecision`, `doKill`, `killSync`, `reapStale` and `open`. They keep the same-uid check, `isRailwaySshForward` with the exact port, a listener on exactly `127.0.0.1:<port>`, PPID 1 or a verified recorded railway, and lstart re-checks before SIGKILL.
  - The factory has no module globals, so each caller has its own port and lock dir.
  - The ports cannot overlap. `loadWeeklyConfig` rejects 55432, 55433 and the effective `BACKUP_TUNNEL_PORT` (the probe confirmed it). `weekly.lock` can never equal `backup.lock` because the names differ.
  - The weekly job only **reads** `backup.lock` (`backupLockState`).
  - W16, W17 and W18 passed: neither job's reaper touched the other's orphaned or live tunnel, and both live tunnels coexisted.
- **No injection.**
  - Season must match `^\d{4}-\d{2}$`. The probe rejected `;rm`, a newline, `../x` and a trailing space.
  - The port must be a plain decimal integer within 1024-65535.
  - Every spawn uses an argv array with no shell.
  - `osascript` is absolute (`/usr/bin/osascript`), with fixed text.
  - `weekly.sh` uses `exec node scripts/weekly.mjs "$@"`.
  - The fixture's `sed "s/%p/$PORT/g"` runs only after a digits-only check.
- **Plist.** It contains only the two opt-in flags (not secrets) and no URL. The launchd log paths moved from world-readable `/tmp` into `~/Library/Logs/chalk-that-nba`, which is `drwx------` on this machine. W24 `plutil -lint` passed. I did not load it.
- **Backup volume.** `/Volumes/DB-Backups` has ownership enabled, and `db-backups` is `drwx------`. Other local users therefore cannot plant a dump that `findFreshBackup` would reuse.

### Numbered findings

**1. Minor (condition): a real weekly run with a fake backup bin passes the guard.**
- **Location:** `scripts/lib/weekly.mjs:73-81` (line 80)
- **Evidence:** `weeklyGuard({WEEKLY_CONFIRM_PROD:'1', BACKUP_CONFIRM_PROD:'1', BACKUP_RAILWAY_BIN:<fake>})` returns `null`. Weekly is real here (`WEEKLY_RAILWAY_BIN` is unset), so the steps write to production. The backup child, however, dumps whatever local Postgres the fake points at, or fails.
- **Impact:** the owner's Gate 1 rule ("back up before writing, abort if it fails") can be met by a non-production dump. This takes deliberate misconfiguration, such as a left-over `BACKUP_RAILWAY_BIN` export from drill work in the owner's shell. The plan blocks the reverse mix (fake weekly with a real backup) but not this one.
- **Fix:** if weekly is not fake-exempt, also refuse when `isFakeBin(env, 'BACKUP_RAILWAY_BIN')` is true, and refuse when `BACKUP_RAILWAY_BIN` is set to anything other than the real CLI. Add a unit case and a drill case.

**2. Minor: a fake-mode backup can land in the real backup dir and then be reused by a real weekly run.**
- **Location:** `scripts/lib/weekly.mjs:107-124` (`findFreshBackup`). The backup's fake mode has no dir restriction (`scripts/lib/backup.mjs` `prodGuard`/`loadConfig`).
- **What happens:** with the fake bins but the default `BACKUP_VOLUME`/`BACKUP_LOG` (for example a manual ad-hoc `db:backup` or `db:weekly` test run outside the drill), `backup-db.mjs` writes a dump of the throwaway DB to `/Volumes/DB-Backups/db-backups` and logs a normal `OK file=` line. For 24 h, a real weekly run would treat that file as a validated production backup and skip the real one. Rotation could also push out a real dump. The drill is safe, because it sets all `BACKUP_*` paths under `$WORK` (`weekly-drill.sh:69`).
- **Impact:** the pre-write backup is silently not a production backup. The rotation half of this predates M5 (backup fake mode); the reuse half is new.
- **Fix (pick one):**
  - Fake-exempt runs (backup or weekly) refuse the default backup volume and log.
  - The backup writes its mode into the OK line (for example `src=fake`), and `findFreshBackup` requires that marker to be absent.

**3. Minor: `lineRedactor` can split a secret at its 64 KB cap.**
- **Location:** `scripts/lib/weekly.mjs:162`
- **Evidence:** a probe pushed one chunk with no newline: 65000 bytes, then the password, then 1012 bytes. The redactor emitted `...aaSup3rS3cre` and then `tPassw0rdXYZbb...`, so the password reached the writer in two unredacted halves. A `postgres://` URL split at the same point would leak the same way.
- **Impact:** low. A step would have to print the password inside a single line longer than 64 KB. The log is 0600 when weekly.mjs creates it.
- **Fix:** when flushing at the cap, keep a tail at least as long as the longest secret, plus the URL form. Better, mask the whole buffer first, then cut on a redacted boundary, or drop the overflow and write `[line truncated]`. Add a unit case.

**4. Minor: the ports are checked only against the weekly process's own view of the backup port.**
- **Location:** `scripts/lib/weekly.mjs:39-40`; `scripts/lib/backup.mjs` `loadConfig` (it does not reserve 55434)
- **What happens:** the two launchd jobs have separate envs. If the owner sets `BACKUP_TUNNEL_PORT=55434` in the backup plist only, the weekly job (which sees the default 55432) accepts 55434. Each job's orphan reaper would then treat the other's PPID-1 forwarder on 55434 as its own.
- **Impact:** live tunnels stay safe (the PPID gate). Orphans could be reaped by the "wrong" job, and runs would fail with `port in use`. It needs a manual config change; today's plists do not set it.
- **Fix:** `backup.mjs loadConfig` also rejects the weekly default (55434) and `WEEKLY_TUNNEL_PORT`. Alternatively, document the 55432-55434 reservation in the plist comments.

**5. Note: stale reaping trusts `rec.port` from `tunnel.json`, not the configured port.**
- **Location:** `scripts/lib/tunnel.mjs:167-176`
- **What happens:** plan §3 says the stale reaper requires `-P <own port>`. The code (unchanged from M4 `backup-db.mjs:234-243`) uses the port written in the record. Only this job writes that record, mode 0600 in a 0700 dir, so a mismatch needs a same-user write or a port change between a crash and the next run.
- **Fix (optional):** skip the record unless `rec.port === port`.

**6. Note: the lock-takeover race and other inherited patterns.**
- **Lock race:**
  - In `takeLock` (`weekly.mjs:156-176`), a second process that runs between another process's `mkdirSync` and its pid write reads `pid=0`, treats the lock as stale and removes it. The window is microseconds; this is the same pattern as the backup lock.
  - The impact is bounded. The second run's tunnel fails on the busy port, and its reaper leaves the live tunnel alone (parent alive). However, its cleanup then removes the shared lock dir.
  - **Fix (optional):** treat a missing or unreadable pid file as "live" if the lock dir's mtime is under about 5 s old.
- **Group signals:** `sigGroup` after a child exits (`weekly.mjs:146`, `:76`, `:90`) signals `-pid` of a group that may already be empty. This is the same accepted risk as M4 note 5.
- **Weekly SIGKILLed mid-step:** if weekly itself is SIGKILLed during a step, the step and the tunnel both keep running until the next run reaps the tunnel. Plan §11 already discloses this.

**7. Note: credentials in the step child's environment.**
- The URL is in each step's initial `environ`. On this host, `ps eww` and `ps -E` do not show another process's env (tested). Root or a debugger with `task_for_pid` could still read it.
- This is a net improvement over the old flow, where the URL sat in plaintext in `.env` on disk. No fix needed. The alternative would be a pipe or fd handoff, which means changing the four step scripts.

**8. Note: permissions on an existing `logs/weekly.log`.**
- `appendFileSync(..., {mode: 0o600})` sets the mode only when it creates the file (`weekly.mjs:47`). A `logs/weekly.log` left by the pre-M5 zsh job is probably 0644 under a 0755 `logs/`. Its content is redacted, and the DB host is `127.0.0.1`.
- **Fix (optional):** `fs.chmodSync(logPath, 0o600)` once per run, or a README line asking the owner to `chmod 600 logs/weekly.log`.

**9. Note: test-environment observation, not a code finding.**
- After my drill, `pgrep` showed one live `fake-railway.sh` (port 55390) and its `fake-ssh-forward.mjs`. Both run from `.../scratchpad/mutA/scripts/fixtures/`, a mutation copy made by another agent (probably QA's negative check).
- They are not from my run: my drill used the repo paths, and no weekly-port listeners were left from it. I did not signal them. Whoever owns `mutA` should clean them up.

## 3. Dependency review

- `package.json` adds only the `db:weekly:drill` script. No packages were added or changed, and the lockfiles are unchanged.
- `fake-weekly-step.mjs` imports `pg`, which is already a dependency.
- OS binaries are called by absolute path: `/usr/bin/osascript`, `/usr/bin/which`, and, via the existing helpers, `/bin/ps` and `/usr/sbin/lsof`.
- The drill uses `postgres:18` pinned by tag, not digest. That is the open M3 F5(6) follow-up, unchanged.

## 4. Verdict

`VERDICT: READY WITH CONDITIONS`

- **Rationale:**
  - The guard is exact-match, off by default and runs first.
  - The test hook works only with the fake (by realpath) and runs one fixed fixture path.
  - The URL exists only in the step children's env and in memory, and the drill's secret scans and argv sampler were clean.
  - The M4 process-identification rules move over unchanged into a factory with no shared state, and the ports and lock dirs cannot overlap within one env.
  - Unit tests 76/76, weekly drill 153/0, CI 4/4 green.
- **Condition:** fix finding 1 (refuse a real weekly run when `BACKUP_RAILWAY_BIN` is the fake, or is set at all) before the owner's first real run, or have the owner explicitly accept it at Gate 2.
- **Recommended follow-ups:** findings 2-4. Findings 5-9 are notes.

## Handoff

- **Done:**
  - A static review of the PR #6 diff and the code paths it touches.
  - Ran `npm test` (76/76), the full local weekly drill (153/0, throwaway container, fake railway, no prod flags) and adversarial probes of the guard, config, redactor and step env. Checked CI (4/4 green) and ran a secret-pattern scan (clean). No scanners were installed.
- **Files created:** `docs/reviews/M5/security.md` (not committed). No source, config or `docs/STATUS.md` edits. Probe scripts are in the session scratchpad only.
- **Open questions:**
  - Owner or Lead: fix finding 1 now, or accept it at Gate 2?
  - Lead: findings 2-4 as follow-ups?
- **Recommended next role:** Dev, for finding 1 (a small guard change plus unit and drill cases), then Lead review. Coordinator: the orphaned `mutA` fixture processes (note 9) belong to another agent's run.

---

## Re-check (fix cycle 1)

`VERDICT: READY WITH CONDITIONS`

### R1. Scope and tools

- **Head:** `dac36c36bc7c9677459b4b2dffc329689928d7af` (local and origin match). **Previous head:** `b49fcc3`. **Reviewed:** `git diff b49fcc3..dac36c3` only (7 files: `scripts/lib/weekly.mjs`, `scripts/weekly.mjs`, `scripts/lib/weekly.test.mjs`, `scripts/weekly-drill.sh`, three docs). Also read the "Fix in this PR" section of `docs/reviews/M5/lead.md`.
- **Commands (all local; prod flags confirmed unset in the shell; real `railway` never invoked; no plist loaded):**
  - `npm test`: **80/80 pass**.
  - `zsh scripts/weekly-drill.sh` (throwaway `postgres:18`, fake railway): **155 passed, 0 failed, rc=0**. No listener on 55432-55434 before or after, and no fake-railway or forwarder processes left.
  - Ad-hoc probe script (session scratchpad only) covering `lineRedactor`, `weeklyGuard`, `fakeIsolationError` and `loadWeeklyConfig`.
  - `gh pr checks 6`: backend, frontend, root and worker all pass (run 41709082436).
  - Secret-pattern grep over `git log -p b49fcc3..dac36c3`: no hits. The only secret-like strings are unit-test literals.
- **Scanners:** gitleaks, semgrep, trivy and osv-scanner are still not installed. `npm audit` was not needed because no dependency changed.

### R2. Earlier findings

**Finding 1 (guard accepted a fake backup bin on a real run): CLOSED.** High confidence.
- `weeklyGuard` (`scripts/lib/weekly.mjs:83-86`) now refuses a real-weekly run whenever `BACKUP_RAILWAY_BIN` is non-empty.
- Probe results:
  - Both flags plus the fake backup bin are refused.
  - Both flags plus another absolute path are refused.
  - Both flags plus `" "` are refused.
  - A real `WEEKLY_RAILWAY_BIN` plus the fake backup bin is refused.
  - Both flags with the backup bin empty or unset pass. Empty is consistent with `backup.mjs:41` (`|| ''`), which then resolves from PATH.
  - The earlier refusals still hold: unset, `"1 "`, weekly-only, and fake weekly with a real backup (with or without flags).
- The guard still runs first, before the lock and before any CLI call or child. Drill W25 confirmed this: no shadow call, no lock, no new dump and no new backup log line.

**Finding 2 (fake backup reused as a real one): CLOSED for the weekly half, as scoped by Lead.** One residual gap (R3-1). The backup half is still an agreed follow-up.
- `fakeIsolationError` runs right after the guard at `stage=preflight` (`scripts/weekly.mjs:243-244`), before the lock, `findFreshBackup` or any child.
- Probe results:
  - Defaults are refused.
  - Overriding only `BACKUP_VOLUME` is refused, because the default log path is still real.
  - A `//Volumes/...` path and a `..` path in the log are refused.
  - `$WORK`-style paths pass.
- Not fixed, as agreed: an ad-hoc fake `npm run db:backup` with default paths still writes a throwaway dump and an `OK` line into the real folder, and a real weekly run would reuse it for 24 h. This is the logged follow-up (for example a `src=fake` marker).

**Finding 3 (redactor split a secret at 64 KB): CLOSED.** High confidence.
- **Original repro** (65000 `a` + password + 1012 `b`, one chunk): the output is only `[output line over 64 KB truncated]`. No 5-character substring of the password appears.
- **Sweep:**
  - Inputs: the password and the full `postgres://` URL.
  - Prefix lengths: 65500, 65520, 65530, 65536−len, 65536, 65537 and 70000.
  - Chunk sizes: 1, 7, 1024, 4096 and a single chunk.
  - Result: 0 leaks. Every case resumed at the next line, and no written line was over 64 KB.
- **Other checks:**
  - A URL pushed one character at a time comes out as `[redacted-url]`.
  - 128 MB with no newline gives one marker, and memory stays bounded.
  - `flush()` while dropping writes nothing.
- The marker is fixed text and is written without input content.

### R3. New observations on the delta

**R3-1. Minor (follow-up): the isolation check compares paths by string, so a different spelling of the real volume gets past it.**
- **Location:** `scripts/lib/weekly.mjs:91-99`
- **Evidence:** the boot volume is case-insensitive APFS, and `ls -ld /volumes/db-backups` resolves to the real volume. With a fake weekly bin, these probes return `null` (accepted):
  - `BACKUP_VOLUME=/volumes/db-backups`
  - `BACKUP_DIR=/volumes/DB-Backups/db-backups`
  - `BACKUP_LOG=~/library/logs/chalk-that-nba/backup.log`
  - A symlink to the real folder would also get past it, though I did not probe that case.
- **Impact:** low. It needs a deliberately unusual spelling in a manual fake run. The default paths and the drill's paths are handled correctly. The result is the same as the remaining backup-half gap of finding 2: a throwaway dump could be reused as a "fresh" backup.
- **Fix:** compare with `fs.realpathSync.native` on the nearest existing ancestor, plus case folding (or compare `stat` dev/ino against the real volume root and log). Add unit cases for case variants and symlinks. Can be bundled with the finding 2 backup-half follow-up.

**R3-2. Note: W25 and the revised W23 now exercise the same path.** Both use the shadow weekly bin, both flags and the fake backup bin, and both stop at the new guard. The drill count went up by 2, but only one new behaviour is covered. This is a coverage note, not a defect.

### R4. Developer deviation: W23 no longer reaches the `WEEKLY_STEP_FIXTURE` check

- **Reachability:** after this PR, the check at `scripts/weekly.mjs:245` can only matter on a real-weekly run with both flags and `BACKUP_RAILWAY_BIN` unset. Every other combination is stopped by the guard, or is a fake run where the check passes anyway.
- **A drill variant is the wrong tool.** `build_env` (`scripts/weekly-drill.sh:99-100`) deliberately aborts ("production flag with a PATH-resolved railway") whenever a prod flag is set and either bin is unset. If the check ever regressed, such a case would proceed to the real backup through PATH `railway`. The harness's PATH shadow would catch that, but you would be relying on a single safety layer. I recommend **not** adding a W23 variant that removes the backup bin, and not weakening that abort.
- **Impact if the check regressed:** low. The fixture swap needs `WEEKLY_STEP_FIXTURE=1` in the prod env (the plist does not set it). Even then, `fake-weekly-step.mjs` only inserts into `weekly_drill_marks`, which does not exist in prod, so the step fails. Its URL output goes through the redactor. The real effect is that schedule, positions and backfill are skipped, and the run fails.
- **Recommendation: follow-up, not a merge blocker.** Move the condition into a pure helper in `scripts/lib/weekly.mjs` (for example `stepFixtureError(cfg, env)` returning a fixed reason or null). Unit-test it with: fixture plus a real or unset weekly bin refused; fixture plus the repo fake allowed; fixture plus a copy of the fake refused; no fixture allowed. Medium-high confidence that this is enough: it is one line of logic and needs no process-level test.

### R5. Dependency review

No changes in the delta: no package or lockfile edits, and `scripts/lib/backup.mjs` and `backup-db.mjs` are unchanged.

### R6. Verdict

`VERDICT: READY WITH CONDITIONS`

- **Rationale:**
  - My earlier condition (finding 1) is fixed and verified by unit tests, adversarial probes and drill W25.
  - Finding 3 is fixed with no leak across a broad sweep.
  - Finding 2's weekly half is fixed as scoped, with one low-severity spelling bypass (R3-1).
  - Unit tests 80/80, drill 155/0, CI 4/4 green. No new Blocker, Major or secret.
- **Conditions (none block merge):**
  - Log these follow-ups in `docs/STATUS.md`: finding 2 backup half plus R3-1 (realpath/case-insensitive isolation), finding 4 code check, and R4 (extract and unit-test the step-fixture check).
  - The owner's first manual real run remains the real verification of the production path (Lead finding 8).

## Handoff (re-check)

- **Done:**
  - Re-reviewed `b49fcc3..dac36c3`.
  - Verified findings 1 and 3 closed and finding 2 closed for the weekly half (as scoped by Lead).
  - Re-ran the redactor repro plus a sweep, the guard probes and the isolation probes, all clean except R3-1.
  - Ran `npm test` (80/80) and the local weekly drill (155/0, throwaway container, fake railway, prod flags unset, no plist loaded). Checked CI (4/4 green).
  - Judged the W23 deviation as a follow-up (unit test via an extracted helper; no drill variant).
- **Files touched:** appended this section to `docs/reviews/M5/security.md` (not committed). No source or config edits. The probe script is in the session scratchpad.
- **Open questions:** Lead/Coordinator: accept R3-1 and R4 as follow-ups alongside the finding 2 backup half?
- **Recommended next role:** Lead final pass, then Coordinator readiness report.
