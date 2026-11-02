# Security review: M3-backup (PR #4)

`VERDICT: READY WITH CONDITIONS`

## 1. Scope and tools

- **Branch:** `feat/db-backup`. **Head:** `20b7b5983966d3cbef675b3f983e0034eefa56c7`. **Base:** `main`.
- **Commits:** `4626a83` (M3) and `20b7b59` (fix cycle 1, prod guard).
- **Files reviewed (all 15 in the diff):**
  - `scripts/backup-db.mjs`, `scripts/lib/backup.mjs`, `scripts/lib/backup.test.mjs`
  - `scripts/backup-db.sh`, `scripts/backup-drill.sh`, `scripts/fixtures/fake-railway.sh`
  - `ops/launchd/com.chalkthat.nba.backup.plist`, `ops/launchd/README.md`
  - `docs/backup-restore.md`, `docs/architecture.md`, `docs/plans/M3-backup.md`, `docs/STATUS.md`
  - `README.md`, `package.json`, `db/tests/backup_drill_seed.sql`
- **Also read:** PR #4 body (incident disclosure, drill results), CI rollup (root, backend, worker and frontend all SUCCESS), and `db/schema.sql` for `api_keys` and `refresh_tokens`.
- **Requirements checked against:** the "Mission M3-backup" section of `docs/STATUS.md`, the owner's `BACKUP_CONFIRM_PROD=1` opt-in, and plan §2 (D-a to D-i) and §12.

**Tools run**
- `npm test` (root): 44/44 pass, including 13 backup tests.
- `npm audit --omit=dev` (root): 0 vulnerabilities.
- Regex secret scans over `git diff main...HEAD` and `git log -p main..HEAD`. Patterns: credential URLs, private-key headers, `sk-ant`, AKIA, `ghp_`, Slack tokens, Railway or proxy hostnames, IPv4 addresses, and added `.env`, `.pem`, `.key` or `pgpass` files.
- `node` probes of `prodGuard` and `fs.realpathSync`. These only resolve paths. Nothing was executed.
- `ls -l` and `stat` on the Railway symlink and the log directory.

**Not available:** gitleaks, trufflehog, semgrep, trivy and osv-scanner are not installed.

**Not run, per the hard rules:** the real `railway` binary (not even `--help`), `db:backup`, the drill, and anything under `/Volumes/TM-Prism` or `/Volumes/DB-Backups`.

## 2. Findings

Confidence is High unless stated otherwise. "Confirmed" means verified by code read, a test or a probe.

### 1. Major: the drill's guard test turns the production flag on and can fall back to the real Railway CLI

- **Status:** Confirmed by code read. Medium likelihood of being triggered; high impact if it is.
- **Location:** `scripts/backup-drill.sh:175-185`, `scripts/backup-db.mjs:150-155`.
- **What happens:**
  - `guard_run BACKUP_CONFIRM_PROD=1` removes `BACKUP_RAILWAY_BIN` and relies on `PATH=$SHADOW:$PATH` to reach a shadow `railway` script.
  - `resolveRailway()` runs `/usr/bin/which railway`. If that fails, it falls back to the hard-coded `/opt/homebrew/bin/railway`.
  - The drill never checks that the shadow was actually created (`mkdir -p`, `printf` and `chmod` are unchecked) or that it wins the PATH lookup.
  - If the shadow is missing or not executable, `which` returns the real `/opt/homebrew/bin/railway`, and it runs with `BACKUP_CONFIRM_PROD=1` already set.
- **Impact:** if the shadow is missing, a local test run would do the following:
  - run real `railway whoami`;
  - open `railway connect Postgres --tunnel-only -e production` from the linked repo;
  - `pg_dump` production (emails, password hashes) into the drill's temp disk image.

  This is the same class of mistake as the disclosed incident, now inside the harness that agents run routinely. The comment "the real CLI is never reachable" is not guaranteed by the code.
- **Fix (any one):**
  - Point the case at the shadow by absolute path: `BACKUP_RAILWAY_BIN=$SHADOW/railway`. The guard treats a binary named `railway` as real, so the flag is still exercised, and a missing file gives ENOENT instead of a fallback. The unset-variable case is already covered by the `prodGuard({})` unit test.
  - Or, before any `guard_run`, abort the drill unless `[[ -x $SHADOW/railway && "$(PATH=$SHADOW:$PATH /usr/bin/which railway)" == "$SHADOW/railway" ]]`.

  Optionally, add the same "must resolve to the shadow" assertion before the flag=1 case only.

### 2. Minor: the guard's "test binary" exemption is name-based and can be sidestepped

- **Status:** Confirmed by probe and code read.
- **Location:** `scripts/lib/backup.mjs:120-130`.
- **What the probe showed:** pointing the variable at `/opt/homebrew/bin/railway`, `.../Railway` or `.../RAILWAY` is guarded. The case variants are only caught because Homebrew's symlink resolves to a file named `railway`.
- **What still skips the flag:** any path whose name, and whose symlink target's name, is not `railway`. That includes:
  - a copy or hard link of the real CLI under another name;
  - a wrapper script that `exec`s `railway`;
  - a case-variant name on an install where `railway` is a regular file rather than a symlink. Then `realpathSync` keeps the given case, but APFS opens the real binary.
- **Impact:** low. Each of these takes a deliberate act. The incident class (default config, nothing set) is fully blocked: `prodGuard({})` refuses, and the guard runs before the drive check, the lock and any CLI call (`backup-db.mjs:159`).
- **Fix:** invert the rule so test mode is an allow-list. Example: test mode only when `realpath(BACKUP_RAILWAY_BIN)` equals `realpath(<repo>/scripts/fixtures/fake-railway.sh)`, or is under a `mktemp` work dir the drill passes in. Also compare names case-insensitively.

### 3. Minor: the TM-Prism deny is a string prefix check that the `/System/Volumes/Data` firmlink path avoids

- **Status:** Confirmed by probe, medium-high confidence. TM-Prism itself was not touched.
- **Location:** `scripts/lib/backup.mjs:13,161-171`.
- **What happens:** `fs.realpathSync('/System/Volumes/Data/Volumes')` (JS and native) returns that path unchanged. It does not canonicalize to `/Volumes`. So setting `BACKUP_VOLUME=/System/Volumes/Data/Volumes/TM-Prism` would:
  - pass `deniedPath` both before and after realpath;
  - pass `isMountPoint`, because the device differs from the Data volume.

  A rename or remount of the TM volume (for example `TM-Prism 1`) also escapes the deny.
- **Impact:** only reachable through an explicit and unusual env override, so this is misconfiguration rather than an attack. The owner's rule is "never write into Time Machine's own folders".
- **Fix (any one):**
  - Allow-list the volume: require `realpath(BACKUP_VOLUME) === '/Volumes/DB-Backups'` unless in drill mode (see finding 2).
  - Or also deny by device ID: compare `stat(dir).dev` with the dev of the TM destination, looked up once via `tmutil destinationinfo` or the mount table.
  - Or add `/system/volumes/data/volumes/tm-prism` to the deny list as a stop-gap.

### 4. Minor: if the backup process is SIGKILLed, the tunnel is orphaned

- **Status:** Confirmed by code read.
- **Location:** `scripts/backup-db.mjs:77-82,199-200`.
- **What happens:** the tunnel is spawned `detached: true`, so it gets its own session and process group. That is right for the group kill. But a SIGKILL of node can't be handled, for example from a launchd job kill, a force-quit or OOM. launchd also won't reap the tunnel, because it is outside the job's process group. Every other exit path is covered: normal exit, every `Fail` stage, timeouts, SIGINT, SIGTERM, SIGHUP, and the synchronous `exit` hook.
- **Impact:** an authenticated SSH forward to production Postgres stays listening on `127.0.0.1:55432` until it is killed by hand. A DB password is still required to use it. Later runs fail with "tunnel port already in use", which fails safe.
- **Fix:** write the tunnel PGID to a pid file next to the lock. On the next start, kill a still-alive stale group if its command line matches `railway connect`. Document the manual check (`pgrep -fl 'railway connect'`) in `docs/backup-restore.md`.

### 5. Minor: owner follow-ups from the disclosed incident (condition)

- **Status:** Suspicion only. It can't be verified statically.
- **Evidence:** PR body, "INCIDENT".
- **What happened:** a real `railway connect --tunnel-only` ran once. `--tunnel-only` implies `--ssh`, so the CLI may have generated or registered an SSH key on the Railway account. Every future real run will rely on that key and on the long-lived CLI session in `~/.railway/config.json`. Both become standing production credentials on this Mac.
- **Recommended:** the owner reviews the SSH keys on the Railway account and keeps only expected ones. The owner also checks `~/.ssh` for a newly created key and confirms it is `0600`. No code change is needed.

### 6. Note: removable-volume permissions

- **Location:** `docs/backup-restore.md:8-12`, plan §9.3.
- **What happens:** the dump is `0600` (`umask 077`, plus `chmod` at `backup-db.mjs:256`), and new dirs are `0700`. On a pre-existing directory, the mode is not tightened. More important, external APFS volumes often have "Ignore ownership" enabled. Then modes don't stop another account on any Mac the drive is plugged into.
- **Data at risk:** the dumps hold user emails and bcrypt hashes. `api_keys.key_hash` and `refresh_tokens.token_hash` are hashes only (`db/schema.sql:324-344`), which is good.
- **Recommended (owner):** encrypt `DB-Backups`, as plan §9.3 already recommends. Check `diskutil info /Volumes/DB-Backups` for "Owners: Enabled". Optionally `chmod 700` the dir in preflight.

### 7. Note: same-user exposure of `PGPASSWORD` and executable seams (accepted risk)

- **Location:** `backup.mjs:103-112`, `loadConfig` (`BACKUP_PG_BIN_DIR`, `BACKUP_RAILWAY_BIN`); `backup-db.sh` (`zsh -l` PATH).
- **What happens:**
  - The password exists only in node memory and in `pg_dump`'s environment. On macOS, another process's env is readable only by the same UID or root.
  - Whoever controls the env can point `BACKUP_PG_BIN_DIR` at a binary that receives `PGPASSWORD`. The same applies to the PATH lookup of `railway` under the login shell.
- **Assessment:** all of this requires same-user code execution, which already owns the Railway session. libpq offers no better non-disk channel (PGPASSFILE must be a regular file). Accepted. No change requested.

### 8. Note: lock race and PID reuse

- **Location:** `backup-db.mjs:129-148`.
- **What happens:** two runs that both see a stale lock can both remove it and proceed. PID reuse can also make a stale lock look alive.
- **Impact:** the first case is limited, because the port-free check and the 2nd tunnel bind largely serialize the runs. The second case fails closed and blocks backups until the lock is removed. Accept, or note in the docs how to clear a stale lock.

### 9. Note: other things checked with no issue found

- **Credential flow:**
  - Tunnel stdout and stderr are piped and buffered in memory, capped at 64 KB and still drained after the cap. The buffer is cleared after parsing and never logged.
  - Every tunnel-stage error is a fixed string.
  - `pg_dump` and `pg_restore` stderr goes through `redact()`, which strips the raw password, the `encodeURIComponent` form, any `postgres(ql)://` URL and `password=` pairs. Redaction happens before truncation.
  - The unexpected-error path logs only `e.code` or `e.name`.
  - `pg_dump` argv has no secret (host, port, user, db, file). The env is an allow-list.
  - The script does not import `env.mjs` or read `.env`.
  - `whoami` output (the account email) is captured and discarded.
- **Parser:** takes the first URL. It requires `127.0.0.1`/`localhost` and the requested port, and fails closed on anything else.
- **Injection:** every `spawn` uses an argv array (no shell). `osascript` gets only fixed strings.
- **Rotation:** deletes only names matching `^chalk-that-nba_\d{8}T\d{6}Z\.dump$`. It never deletes the file just written, uses `rmSync` without `recursive` (symlinks are unlinked, not followed), and runs only after validate and rename.
- **Mount check:** the device-ID mount check runs before any network access and is re-checked after `mkdir`. Symlinked and dangling-symlink escapes are covered by `realpathLoose` plus the unit tests.
- **Log:** `~/Library/Logs/chalk-that-nba` is `drwx------` and `backup.log` is `-rw-------` (verified). Log lines carry stage, reason, file name, size and duration only.
- **Plist:**
  - No secrets. `BACKUP_CONFIRM_PROD=1` is an intentional opt-in, not a credential. Absolute paths throughout.
  - PATH comes from `zsh -l`, and libpq is called by absolute path.
  - It embeds the local username and home path, the same as the existing weekly plist.
  - Installing it means daily production runs, and `launchctl start` then also runs production. That matches owner intent.
- **Fake-railway fixture:** no network calls beyond a localhost forwarder, and it handles only `whoami` and `connect`. Its password comes from the drill's random per-run value and is never on argv. The containers bind `127.0.0.1` only, and the work dir is `0700` and removed by the trap.
- **Docs:** no Railway hostname, proxy host or port, or credential. `127.0.0.1:55432` and `55433` are local. The restore example uses `PGPASSWORD` and env, never argv.
- **Git history (2 commits):** no secrets, no `.env`, `.pem` or `.key` files, and no Railway host. The only diff hit was pre-existing STATUS context that refers to a redacted port, not a value.

## 3. Dependency review

- `package.json`: no dependency changes, only two new scripts. `npm audit --omit=dev` (root) reports 0 vulnerabilities.
- **New machine tools (not repo deps):**
  - Homebrew `libpq` 18.6, from the official keg-only formula.
  - Docker image `postgres:18`, official, tag not digest-pinned. It is drill-only and throwaway, so this is a Note. Pin a digest if reproducibility matters.
  - Railway CLI 5.71.0, which was already in use.
- No new npm packages, so there is no typosquat surface.

## 4. Verdict

`VERDICT: READY WITH CONDITIONS`

**Requirements check:**
- The production opt-in requirement is met. With default configuration, no flag and no seam, the script refuses in preflight before the drive check, the lock or any Railway CLI call. So the incident's class of mistake (a bare `node scripts/backup-db.mjs` reaching production) is prevented.
- Credential handling meets D-c and D-h. No path writes the password to disk, the log, the console, argv or error text.
- Process-group cleanup covers every catchable exit.
- Path guards, rotation and file modes are sound for the approved target.

**Conditions:**
1. **Before merge:** fix finding 1. The drill must not be able to reach the real CLI while `BACKUP_CONFIRM_PROD=1` is set. Use an absolute shadow path via `BACKUP_RAILWAY_BIN`, or abort if the shadow doesn't resolve.
2. **Before the first production run (T6):** owner completes finding 5 (Railway SSH key review) and decides on finding 6 (encryption and ownership on `DB-Backups`).

Findings 2, 3 and 4 are recommended hardening and can go in a follow-up. Findings 7-9 need no action.

---

## Handoff

- **Done:** static security review of PR #4 at `20b7b59`, root unit tests (44/44), `npm audit`, secret and host scans of the diff and branch history, and path-resolution probes of `prodGuard`. Real `railway`, `db:backup`, the drill and the TM-Prism and DB-Backups volumes were not touched.
- **Files created:** `docs/reviews/M3-backup/security.md` (not committed).
- **Open questions:**
  - Owner: Railway account SSH keys after the incident (finding 5).
  - Owner: whether `DB-Backups` is encrypted and has ownership enabled (finding 6).
  - Dev or Lead: whether to adopt the allow-list guard and volume allow-list (findings 2 and 3) now or in a follow-up.
- **Recommended next role:** Dev, to fix finding 1 (fix cycle 2; drill-only, so a small change). Then QA re-runs the drill, and Lead reviews.

---

# Re-review (cycle 2, 1f3a027)

`VERDICT: READY WITH CONDITIONS`

## R1. Scope and tools

- **Head:** `1f3a027e3da999da027f2d44b2799919186b3ff7` (PR #4, OPEN). Confirmed with `gh pr view` and `gh run view 41480681670`. Run 41480681670 shows `success` on this SHA, and all four checks (root, backend, worker, frontend) passed.
- **Diff reviewed:** `git diff 20b7b59..1f3a027` (8 files).
  - Read in full: `scripts/backup-db.mjs`, `scripts/lib/backup.mjs`, `scripts/backup-drill.sh` lines 1-110 and the changed hunks, `scripts/fixtures/fake-railway.sh`, the new unit tests, and the README and docs hunks.
- **Tools run:**
  - `npm test` (root): **47/47 pass**.
  - `npm audit --omit=dev`: **0 vulnerabilities**.
  - Regex scan for secrets and hosts over the added lines (credential URLs, private keys, `sk-ant`, AKIA, `ghp_`, Slack tokens, Railway hosts, IPv4 other than 127.0.0.1): **no hits**. No `.env`, `.pem`, `.key` or `pgpass` files were added.
- **Local probes (scratchpad only):**
  - Node probes of `prodGuard` and `assertSafeBackupDir`. These only call realpath and stat; they never execute the binary path being checked.
  - A zsh simulation of the drill's `build_env` (lines 82-103 copied verbatim) that runs only `/usr/bin/env`.
  - `ls -ld` on `/System/Volumes/Data/System{,/Volumes}`.
- **Not run:** the real `railway` (not even `--help`), `db:backup`, the backup script and the drill (QA runs it). Nothing under `/Volumes/TM-Prism` or `/Volumes/DB-Backups` was touched.
- gitleaks, semgrep and trivy are still not installed.

## R2. Status of the cycle-1 findings

### Finding 1 (Major): drill could fall back to the real CLI with the flag set. **CLOSED** for the defect as reported. One residual gap is filed as R3.1.

Confirmed by code read, high confidence:
- **The flag=1 case no longer uses PATH.** It now passes `BACKUP_RAILWAY_BIN=$SHADOW/railway`. `backup-drill.sh:101` requires `-x` and `${bin:A}` equal to `${FAKE:A}` or `${SHADOW:A}/railway`, or the drill aborts with exit 99.
  - `resolveRailway()` (`backup-db.mjs:168-169`) returns `cfg.railwayBin` as given, with no `which` and no Homebrew fallback.
  - So a missing shadow now means ENOENT. It cannot fall back to the real CLI.
- **The flag is never combined with a PATH lookup inside the drill's own assignments.** In `backup-drill.sh:96-97`, an empty `bin` with `flag == 1` aborts. The scan in `:95` takes the last assignment, which matches how `env` resolves duplicates, so a later override cannot get past it.
- **The shadow is checked before any case runs:**
  - `:86`: the fake is the repo fixture.
  - `:87`: the marker string is present and the file is executable.
  - `:88`: the shadow wins `which`.
  - `:98`: the shadow still wins `which` on each PATH-lookup case.
- **Every launch goes through `build_env`:** `:104`, `:204`, `:221` and `:242`. Grep finds no other `node scripts/backup-db.mjs` call.
- **Defence in depth:** `prodGuard` now short-circuits only on the exact `'1'`. Any other value requires the fixture realpath.

### Finding 2 (Minor): name-based exemption. **CLOSED**

`prodGuard` (`backup.mjs:128-138`) now exempts only when `realpathSync.native(bin)` equals the realpath of `<lib repo root>/scripts/fixtures/fake-railway.sh`.
- **Repo-root computation:** it is derived from the library's own `import.meta.url`, not from env or cwd, so it cannot be redirected by configuration. The probe showed a different `repoRoot` is not exempt.
- **Refused without the flag** (probe and unit tests):
  - a copy, a hard link, or a wrapper;
  - `railway`, `Railway` or `RAILWAY`;
  - a symlink to a file named `railway`;
  - a missing file, a directory, `/bin/sh`, or `/opt/homebrew/bin/railway`.
- **Exempt:** a case variant of the fixture name. `realpath.native` returns the canonical on-disk name, and it is the same file.
- **Bypass hunt (residuals, all Note):** see R3.2 (bare relative name) and R3.3 (symlink swap between guard and spawn).

### Finding 3 (Minor): TM-Prism deny avoided via firmlink spelling or rename. **CLOSED**

- **Name check:** `normDeny` lowercases the path, then strips a leading `/system/volumes/data`. It is applied both to `path.resolve` output and to the realpath. The probe denied all of these:
  - `//Volumes/TM-Prism/x`
  - `/Volumes/./TM-Prism`
  - `/Volumes/TM-Prism/../TM-Prism/x`
  - `/System/Volumes/Data//Volumes/TM-Prism`
  - `/private/../Volumes/TM-Prism`
  - the uppercase and mixed-case firmlink forms
- **One spelling passes the name check:** the doubled firmlink `/System/Volumes/Data/System/Volumes/Data/Volumes/TM-Prism`. It is not a real bypass. `/System/Volumes/Data/System/Volumes` does not exist on this Mac (`ls`), so the path cannot resolve to a mount.
- **Device check:** `timeMachineDevices()` collects the `dev` of `/Volumes/TM-Prism`, its firmlink spelling, and every `Mount Point` reported by `tmutil destinationinfo`. Each path is only `stat()`ed (no listing, read or write). `assertSafeBackupDir` rejects if `nearestDev` of the realpath of the directory or the volume matches.
  - This covers a renamed TM volume while it is mounted, and every path spelling.
  - It fails closed. A stale empty `/Volumes/TM-Prism` directory on the boot volume would only add the boot volume's dev, which the mount-point check already excludes.
- **Owner awareness:** each run now `stat()`s the TM mount point and runs `tmutil destinationinfo` (read-only, 10 s timeout). This does not write into Time Machine's folders.

### Finding 4 (Minor): orphaned tunnel after SIGKILL. **CLOSED**, with a hardening note (R3.4)

- **How it works:** the PGID is written to `backup.lock/tunnel.pgid` right after spawn (`backup-db.mjs:228`). `reapStaleTunnel` runs only when the lock is stale, meaning the holder PID is dead and did not return EPERM.
- **Conditions before it kills anything:**
  - pgid is greater than 1 and is not the script's own PID;
  - the group is alive;
  - `ps -p <pgid> -o command=` matches `/railway/i`, `\bconnect\b` and `--tunnel-only`.
- **PID reuse:** POSIX does not reuse a PID while a process group with that ID exists. So if the group is alive and `ps -p pgid` finds a process, that process is the original leader. If the leader has exited but the group lingers, `ps` returns nothing and the reaper does nothing. That fails safe: an orphan can remain, but nothing unrelated is killed.
  - Reuse is only possible after the old group has fully died. The new owner of that PID would also have to be a group leader, run by the same user (other UIDs give EPERM, which is caught), and have argv containing all three tokens.
  - In practice that means a `railway connect … --tunnel-only` the owner started by hand in a terminal, which job control makes a group leader.
  - Likelihood is very low. The impact is closing the owner's own tunnel.
- **Truncation:** BSD `ps` does not truncate the command when its output is not a terminal, so argv matching works against the full command line.
- **Lock isolation:** the drill's lock dir comes from its `BACKUP_LOG` (`$WORK`), so the drill cannot reap a production tunnel, and production cannot reap a drill tunnel.
- **Fixture change:** the fixture no longer uses `exec`, and its trap kills its `node` child. A group kill still takes both. No new network surface.

### Findings 5-6 (owner items): **still OPEN.** Cycle 2 did not change them. They remain conditions before the first production run.

### Findings 7-9 (Notes): unchanged. No action needed.

## R3. New findings (cycle 2)

### R3.1 Minor: the drill trusts the caller's environment for `BACKUP_RAILWAY_BIN` and `BACKUP_CONFIRM_PROD`

- **Status:** Confirmed by simulation. High confidence in the mechanism, low likelihood.
- **Location:** `scripts/backup-drill.sh:90-104` and `:204`. The `guard_run --no-bin` call is at `:205`.
- **What happens:**
  - `build_env` inspects only the assignments it builds (`LE`).
  - `--no-bin` removes `BACKUP_RAILWAY_BIN` from `LE`, and the first no-bin case sets no flag.
  - `env $LE …` then inherits both variables from the invoking shell.
- **Simulation:** I ran `BACKUP_RAILWAY_BIN=/nonexistent/…/railway BACKUP_CONFIRM_PROD=1 zsh sim.zsh`. `build_env --no-bin` passed its checks, because `LE` had neither variable. The child env still contained both inherited values.
- **Impact:** if someone runs the drill from a shell where both variables are exported, with `BACKUP_RAILWAY_BIN` pointing at the real CLI, the first `guard_run --no-bin` passes `prodGuard`. It then runs the real `railway whoami`, then `railway connect … -e production`, and `pg_dump`s production into the drill's disk image. This is the incident class again.
  - Either variable alone is safe. With only the flag, the PATH shadow catches the call. With only the bin, `prodGuard` refuses.
  - The docs use only the inline form (`BACKUP_CONFIRM_PROD=1 npm run …`) and never suggest exporting `BACKUP_RAILWAY_BIN`, which is why likelihood is low.
  - This means the invariant "every reachable railway is a verified fake" holds only for a clean caller environment.
- **Fix (one line, either option):**
  - Near the top of the drill: `unset BACKUP_RAILWAY_BIN BACKUP_CONFIRM_PROD BACKUP_PG_SERVICE BACKUP_RAILWAY_ENV`.
  - Or launch with `env -u BACKUP_RAILWAY_BIN -u BACKUP_CONFIRM_PROD $LE node …`.

  Optionally, abort early if either variable is set on entry.

### R3.2 Note: a bare relative name is exempt, but `spawn` resolves it through PATH

- **Status:** Confirmed by probe. Contrived to exploit.
- **What happens:** with cwd at `scripts/fixtures`, `BACKUP_RAILWAY_BIN=fake-railway.sh` is exempt, because `realpath` resolves it against cwd. But `spawn('fake-railway.sh')` has no slash, so it searches PATH and never uses cwd.
- **Impact:** the guard approves one file and the script executes another. To be harmful, someone would have to plant a `fake-railway.sh` on PATH that runs the real CLI. Otherwise the result is ENOENT.
- **Fix:** require `path.isAbsolute(bin)` for the exemption. Better, spawn the realpath that the guard approved.

### R3.3 Note: TOCTOU between the guard's realpath and the later spawns

- **Location:** `prodGuard` at preflight; `resolveRailway` returns the unresolved `cfg.railwayBin`, which is spawned for `whoami` and again for `connect`.
- **Impact:** a symlink at that path could be retargeted between the check and the spawn. Doing so requires a concurrent same-user actor, who already owns the Railway session. Accepted.
- **Fix:** the same as R3.2. Resolve once in `prodGuard` and spawn that resolved path.

### R3.4 Note: the reaper's argv match could be stricter

- **Location:** `backup-db.mjs:139`.
- **What happens:** the three-token match would also accept a hand-started `railway connect … --tunnel-only` that happened to reuse the recorded PID (see the PID-reuse analysis under Finding 4).
- **Fix (optional):**
  - also require `-P <cfg.port>` and `-e <cfg.railwayEnv>`;
  - or compare the process start time (`ps -o lstart=`) against the mtime of `tunnel.pgid`.
- **Docs:** the manual `pkill -f 'railway connect'` in `docs/backup-restore.md` is broad. It already says "only if you are sure".

### R3.5 Note: docs and secrets in the cycle-2 diff

- **Restore example:**
  - generates a throwaway random `POSTGRES_PASSWORD`;
  - passes it to Docker by env name (`-e POSTGRES_PASSWORD`);
  - binds to `127.0.0.1` only;
  - unsets the password variables at the end.
- **Elsewhere:** no Railway host or credential in the docs. No new log lines carry secrets; the new `NOTE reaped…` line is a fixed string.
- **Production:** nothing new reaches production. The only new subprocesses are `/bin/ps` and `/usr/bin/tmutil destinationinfo`, both local and read-only.

## R4. Dependency review

There are no dependency changes in 20b7b59..1f3a027. `npm audit --omit=dev` reports 0 vulnerabilities. No new npm packages, images or tools.

## R5. Verdict

`VERDICT: READY WITH CONDITIONS`

**Assessment:**
- The cycle-1 Major is closed as reported. The drill's flag=1 case can no longer fall back to the real CLI. The drill aborts on any flag-plus-PATH combination in its own assignments, and on any `BACKUP_RAILWAY_BIN` that is not a verified fake.
- Findings 2-4 are closed with sound implementations: the realpath allow-list, the firmlink and device-based TM deny, and the PGID reaper. The reaper fails safe on PID reuse.
- CI is green on the head, unit tests are 47/47, and there is no new secret exposure and no new path to production.

**Conditions:**
1. **Recommended before merge (one-line, drill-only):** fix R3.1 by clearing or refusing an inherited `BACKUP_RAILWAY_BIN` or `BACKUP_CONFIRM_PROD` in the drill.
   - Severity is Minor because it needs both variables exported in the caller's shell.
   - It is listed here because it is the same harness and the same failure class as the incident.
   - If Lead or the owner prefer to merge first, track it as the first follow-up and run the drill only from a clean shell (`env | grep BACKUP_` shows nothing) until then.
2. **Before the first production run (T6), unchanged:** the owner completes finding 5 (Railway account SSH keys) and decides finding 6 (`DB-Backups` encryption and ownership).

R3.2 to R3.4 are optional hardening (spawn the guard-approved realpath; tighten the reaper match).

## Handoff (re-review, cycle 2)

- **Done:** static re-review of `20b7b59..1f3a027`; `npm test` 47/47; `npm audit` 0; secret and host scan of the diff; local probes of the guard and the TM deny; a `build_env` simulation that runs `/usr/bin/env` only; read-only `gh` checks of the PR head and CI. The real `railway`, the backup, the drill and the TM-Prism and DB-Backups volumes were not touched.
- **Files touched:** appended this section to `docs/reviews/M3-backup/security.md` (not committed).
- **Open questions:**
  - Lead or Owner: fix R3.1 now (it would be cycle 3, the last allowed) or as a follow-up.
  - Owner: findings 5 and 6 before T6.
- **Recommended next role:** Lead review, with QA's drill result. If R3.1 is fixed now, Dev makes the drill-only change and QA re-runs the drill.

---

# Re-review (cycle 3, 81113b9)

`VERDICT: READY`

## C1. Scope and tools

- Branch `feat/db-backup`, head `81113b965a90bc7f13b6ae6aac3c22975048fd87`. The delta reviewed is `git diff 1f3a027..81113b9`: `scripts/backup-drill.sh`, `scripts/backup-db.mjs`, `scripts/lib/backup.mjs`, `scripts/lib/backup.test.mjs` and `docs/backup-restore.md`. This is items A and B in `lead.md` §4. I also re-read the code paths the delta touches: `prodGuard`, `main()` config ordering, `preflight()`, `openTunnel()` and the reaper match.
- **Tools run:**
  - root `npm test`: 47/47 pass;
  - `npm audit --omit=dev`: 0 vulnerabilities;
  - a grep of the added lines for secrets and hostnames: no hits;
  - `gh run view 41485969944`: conclusion `success` on head SHA `81113b9`, and all 4 jobs (frontend, backend, worker, root) succeeded.
  - `gitleaks` and `semgrep` are not installed, so I did not run them.
- **Not run, per the rules:** the real `railway`, the backup script and the drill (QA runs the drill). Neither volume was touched.

## C2. Status of the cycle-2 findings

### R3.1 (Minor): the drill inherited the ambient environment. **CLOSED**

- `backup-drill.sh:106` defines `LAUNCH=(env -i HOME PATH TMPDIR LANG)`, and `:107` defines `launch_node() { $LAUNCH $LE node scripts/backup-db.mjs; }`.
- I enumerated every launch of `backup-db.mjs` with `grep -n "node scripts/backup-db"`. Only three lines launch it:
  - `:107`, the helper. `run_case`/`run_backup` (`:110`, `:112`) and `guard_run` (`:210`) use it.
  - `:232` (SIGTERM) and `:253` (SIGKILL), the inline `( exec $LAUNCH $LE node … ) &` launches. Both use `$LAUNCH`.
  - No `env $LE node` launch without the scrub is left.
- With `env -i`, the script sees only `HOME`, `PATH`, `TMPDIR`, `LANG` and the vetted `LE` assignments. That drops inherited `BACKUP_*`, `PG*`, `DATABASE_*`, `RAILWAY_*`, and also `NODE_OPTIONS` (a bonus: inherited `--require` or `--import` injection into the script is no longer possible from the drill).
- **PATH ordering:** `LAUNCH` carries the caller's `PATH`. In `--no-bin` cases, `build_env` appends `PATH=$SHADOW:$PATH` to `LE`, which comes after `LAUNCH`'s `PATH=` on the `env` command line. `env` applies assignments left to right, so the shadow-first PATH wins. That PATH is the same one `build_env:98` verified with `which`. In flag=1 cases, `build_env` still forces `BACKUP_RAILWAY_BIN` to be the fake or the shadow (`:97`, `:101`), so PATH is not consulted.
- **The new regression case at `:216-220`** exports `BACKUP_RAILWAY_BIN=$SHADOW/railway` and `BACKUP_CONFIRM_PROD=1`. It points only at the shadow, never the real CLI. It then runs `guard_run --no-bin` and asserts three things: rc=1, the "production run not confirmed" line, and no `shadow.calls`. It unsets both variables right after. This is a valid test of the scrub: without `env -i`, the script would have read the ambient flag=1 and invoked the shadow.
  - Residual: if the drill were killed between `:217` and `:219`, the exports would die with the drill's own process, so nothing persists to the caller.

### R3.2 (Note): a relative name was resolved through PATH. **CLOSED**

- `lib/backup.mjs:27` rejects a non-empty, non-absolute `BACKUP_RAILWAY_BIN` with a fixed message.
- `main()` (`backup-db.mjs:299-301`) maps the rejection to `FAIL stage=preflight reason="bad configuration: BACKUP_RAILWAY_BIN must be an absolute path"`. The message has no value echo, so nothing leaks.
- The rejection happens before `preflight()`, so no spawn of any kind occurs.
- Unit tests cover `railway` and `./fake-railway.sh` (rejected) and an absolute path (accepted) (`backup.test.mjs:108-110`).
- `path.isAbsolute` lets `..` segments through, for example `/x/../railway`. That is harmless, because R3.3 now executes the realpath.

### R3.3 (Note): TOCTOU between the guard's realpath and the spawns. **CLOSED** in the form the plan asked for, with a narrow residual (C3.1).

- `resolveRailway()` (`backup-db.mjs:171-172`) now returns `fs.realpathSync(cfg.railwayBin)` when the value is set.
- `cfg.railway` is computed once (`:212`), and both `whoami` (`:213`) and `connect` (`:222`) spawn that one resolved path. A symlink retargeted after `:212` no longer changes what `connect` runs.
- A resolution failure gives a fixed preflight message with no path echo.
- The unset (production) path is unchanged: `which railway`, else the Homebrew default. That path still requires `BACKUP_CONFIRM_PROD=1` from `prodGuard`.
- **Reaper:** the fixture's realpath (`…/scripts/fixtures/fake-railway.sh`) still matches `/railway/i` at `:139`, so the reaper case still works. QA's drill run confirms this behaviour.

### Findings 5 and 6: **CLOSED** on the owner's attestation (Railway SSH keys checked and clean; `DB-Backups` encrypted, with ownership enabled). I accept this as reported; I did not and could not verify it independently.

### Findings 7-9 and R3.4/R3.5: unchanged notes. No action needed.

## C3. New observations (cycle 3)

### C3.1 Note: the guard and `resolveRailway()` resolve the path separately

- **Location:** `lib/backup.mjs:133` (the guard, `realpathSync.native`) and `backup-db.mjs:172` (the spawn, `realpathSync`, not `.native` as the plan text suggested).
- **Description:** the guard approves realpath R1 at startup. `resolveRailway()` re-resolves later in preflight, after the pg_dump version check, and gets R2. If a same-user process retargets a symlink in that window, R2 is not the file the guard approved.
- **Impact:** this applies only when `BACKUP_RAILWAY_BIN` is set, and the attacker needs write access as the same user. That user can already run `railway` directly, so this crosses no privilege boundary (it is the same accepted risk as finding 7). The `.native` versus JS difference only affects canonical case and normalization; both resolve to the same file. Confidence that this is not exploitable across a trust boundary: high.
- **Optional hardening (follow-up, not a condition):** compute the realpath once, in the guard or in `loadConfig`, and pass that exact string on to spawn.

### C3.2 Note: the drill no longer forwards a caller's `BACKUP_PG_BIN_DIR`

- **Location:** `backup-drill.sh:11`, `:73-75`, `:106`.
- **Description:** the drill reads `PGBIN` from `BACKUP_PG_BIN_DIR` but does not add `BACKUP_PG_BIN_DIR=$PGBIN` to `BENV`. `env -i` now strips the inherited value, so the script falls back to `/opt/homebrew/opt/libpq/bin` while the drill's own psql and pg_restore calls use `$PGBIN`. Lead's item A asked for this pass-through.
- **Impact:** functional only, with no security impact. It fails closed: preflight reports "pg_dump 18 or newer required" if the default path is missing. It only matters on hosts with a non-default libpq location.
- **Fix:** add `BACKUP_PG_BIN_DIR=$PGBIN` to `BENV`. This is a Lead or QA call; it can be a follow-up.

### C3.3 Note: secrets and production reachability in the delta

- No credentials, hostnames or `.env` content were added.
- The new error strings are fixed and echo no values.
- The only new binary the drill references is `$SHADOW/railway` (a `chalk-drill-shadow` stub that exits 1) and only behind the existing `build_env` checks.
- Nothing in the delta adds a path to the real Railway CLI or to production. With `env -i`, the drill is strictly narrower than at `1f3a027`.

## C4. Dependency review

There are no changes to `package.json` or the lockfile in `1f3a027..81113b9`. `npm audit --omit=dev` reports 0 vulnerabilities, and there are no new packages, images or tools.

## C5. Verdict

`VERDICT: READY`

**Rationale:**
- R3.1 is closed. Every drill launch, including both inline backgrounded launches, goes through `env -i`, and a regression case proves the scrub.
- R3.2 and R3.3 are closed. A relative `BACKUP_RAILWAY_BIN` is refused before any spawn, and `whoami` and `connect` run one resolved realpath.
- Findings 5 and 6 are closed on the owner's attestation.
- CI is green on all 4 jobs at `81113b9`, and `npm test` passes 47/47.
- Nothing new leaks a secret or reaches production.
- C3.1 and C3.2 are Notes for the follow-up list. They are not merge conditions.
- The separate owner approvals for merge, the T6 first production run and any deploy still apply under CLAUDE.md.

## Handoff (re-review, cycle 3)

- **Done:** static re-review of `1f3a027..81113b9` and the code paths it touches; root `npm test` 47/47; `npm audit` 0; secret and hostname grep of the delta; read-only `gh` check of CI run 41485969944 (green, head SHA matches). The real `railway`, the backup and the drill were not run, and no volume was touched.
- **Files touched:** appended this section to `docs/reviews/M3-backup/security.md` (not committed).
- **Open questions:**
  - Lead: whether C3.2 (forwarding `BACKUP_PG_BIN_DIR` in the drill) goes on the follow-up list.
  - C3.1 is optional hardening.
- **Recommended next role:** Lead delta check (with QA's drill result), then the Coordinator readiness report to the owner.
