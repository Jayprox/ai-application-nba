# M5: Weekly job through the Railway CLI tunnel (plan)

- **Status:** Plan ready for Dev. No owner decision blocks the start. §9 has four items for the owner to confirm or override at Gate 2.
- **Requirement source:** "Mission M5" in `docs/STATUS.md`: the mission text plus the owner's Gate 1 answers (2026-11-03): (1) back up before writing, reuse a validated backup under 24 h old, wait up to 10 min for a running backup, abort if the backup fails; (2) keep `db:positions`, in the order schedule -> positions -> backfill -> status; (3) the weekly plist sets the production opt-in flag, and the team never installs or reloads it.
- **Hard rules:** no role runs anything against production. Dev, QA and Sec run only `npm test`, `npm run db:backup:drill` and the new `npm run db:weekly:drill`, using throwaway local `postgres:18` containers and `scripts/fixtures/fake-railway.sh`. The owner does the first real run by hand after merge. Nobody on the team runs `launchctl`.
- **Branch / PR:** `feat/weekly-tunnel` (push to `feat/*` is pre-approved). One PR, one commit per task in §7, so reviewers can check the T1 refactor on its own. Commit this plan with T1.
- **Reviews:** QA, and **Security: yes**. The PR changes process control (it signals the ssh child and orphans, and forwards signals to child jobs), adds a production guard, passes a credential to child processes, changes launchd config, and adds a test-only hook to production code.

## 1. Where things stand (evidence)

- `scripts/weekly.sh:15-21` is a zsh `&&` chain of `npm run db:schedule/positions/backfill/status`, writing to `logs/weekly.log` and sending an `osascript` notification. It has no tunnel, no guard and no signal handling.
- The four step scripts get their connection only from `publicDbUrl()` (`scripts/load-schedule.mjs:27`, `load-positions.mjs:14`, `backfill.mjs:303`, `db-status.mjs:6`). `loadEnv()` gives the **process env precedence over `.env`** (`scripts/lib/env.mjs:16`). TLS is off for `127.0.0.1` (`env.mjs:31`), which is correct for a port forwarded over SSH.
- The tunnel lifecycle lives as module globals in `scripts/backup-db.mjs`: `sshTargets`, `stopSsh`, `reapOrphanedSsh`, `killTunnel`/`doKillTunnel`, `writeTunnelRecord`, `reapStaleTunnel`, `openTunnel`, `checkPortFree`, `canConnect` (L69-143, 145-152, 205-245, 326-360). The pure decision functions are in `scripts/lib/backup.mjs` (`isRailwaySshForward`, `isRailwayTunnelCmd`, `reapDecision`, `parseTunnelRecord`, `parseTunnelOutput`, `redact`, `prodGuard`, `loadConfig`).
- **Backup reaper scope today:** it only touches (a) the railway pid named in `<backup lockDir>/tunnel.json`, verified with `isRailwayTunnelCmd(args, rec.port, bin)`, which requires the exact `-P <port>`; and (b) ssh listeners on exactly `127.0.0.1:<cfg.port>` whose argv has exactly one `-L 127.0.0.1:<cfg.port>:...` (`backup.mjs:216-227, 271-279`; `backup-db.mjs:105-117`). So any tunnel on a different port with a different lock dir is invisible to the backup, and the reverse holds for the weekly job (§3).
- **What "validated" means in `backup-db.mjs`:** the dump is written as `<name>.partial` (L364). Only after `pg_restore --list` succeeds **and** lists `TABLE DATA public teams` (L373-381) does `commit()` rename it to the final `chalk-that-nba_<UTC>.dump` name (L386-397). The run then rotates, checks the port is free, and writes `"<iso> OK   file=<name> size=... kept=... deleted=... duration=..."` to `backup.log` (L426). The name's timestamp is taken **before** the tunnel opens (L415).
- The backup lock is `dirname(BACKUP_LOG)/backup.lock`, with a `pid` file inside (`backup.mjs:34`, `backup-db.mjs:247-267`). Lock held by a live pid gives `FAIL stage=preflight reason="another backup is running"` on stderr and in the log.
- Port 55433 is used only by the restore example (`docs/backup-restore.md:92-97`).
- CI (`.github/workflows/test.yml`) runs root `npm test` (`node --test 'scripts/lib/*.test.mjs'`) on Ubuntu. The backup drill is **not** in CI (it needs macOS `hdiutil` and Docker; `docs/architecture.md:773`).
- The backup drill pins `postgres:18` by **tag**, not digest (`scripts/backup-drill.sh:57`; the M3 follow-up F5(6) is still open).
- **Could not determine:** I could not read `.env.example` (blocked by this session's permission settings). Dev updates it per §8. Also not determined: whether two real `railway connect --tunnel-only` sessions can run at the same time (see §9, item 4).

## 2. Decision 1: reuse the tunnel code by extracting `scripts/lib/tunnel.mjs`

**Decision:** move the tunnel I/O lifecycle out of `backup-db.mjs` into a new module, `scripts/lib/tunnel.mjs`, built as a factory with no module globals. Both `backup-db.mjs` and the new `weekly.mjs` call it. The pure helpers stay in `scripts/lib/backup.mjs`, unchanged; `tunnel.mjs` imports them.

```
createTunnel({ railwayBin, service, railwayEnv, port, timeoutS, lockDir, cwd, env, myUid })
  -> { open() -> creds, kill() -> Promise, killSync(), reapStale() -> bool,
       reapOrphans() -> n, portFree() -> bool, waitPortFree(tries), get portStillHeld, get pid }
```

- `open()` throws `TunnelError { stage: 'tunnel', reason }` using **the exact reason strings used today**. `backup-db.mjs` maps that to `new Fail('tunnel', reason)`.
- These stay in `backup-db.mjs`: `Fail`, the `stage` variable, `takeLock` (it calls `tunnel.reapStale()`), `preflight` order, signal handlers, `finishFail`, and the `process.on('exit')` handler (it calls `tunnel.killSync()`). Log lines, stage names, exit codes, timeouts and the kill sequence (ssh SIGTERM -> railway SIGINT -> SIGTERM -> SIGKILL -> stopSsh -> port check -> one orphan sweep) must be **byte-for-byte the same behavior**.

**Why not the alternatives:**
- *Weekly imports the pure helpers and re-implements the I/O.* That makes a second copy of the most error-prone code in the repo. M4 was exactly a bug in this code (ssh in its own group). Two copies would drift, and the next fix would have to be made twice.
- *Weekly calls `backup-db.mjs` in a "tunnel only" mode.* That changes backup behavior and its CLI surface. It also makes signal and credential handoff across processes harder.
- Sharing code between files of the **same** package is fine. `docs/STANDARDS.md` §1 forbids sharing only across the four packages.

**Guardrail for "backup behavior unchanged":** T1 is a pure refactor commit. Definition of done: `scripts/backup-drill.sh`, `scripts/lib/backup.test.mjs` and both fixtures are unchanged in that commit; `npm run db:backup:drill` gives **108 PASS / 0 FAIL**; `npm test` is green; and every `FAIL stage=`/`NOTE`/`OK` string in `backup-db.mjs` can still be found by grep, either in it or in `tunnel.mjs`. M4's hardening follow-ups (Sec 1/2, note 6) are **not** folded in. They change backup behavior and stay a separate follow-up.

## 3. Decision 2: weekly port, lock, and reaper scoping

- **Port:** `WEEKLY_TUNNEL_PORT`, default **55434**, integer 1024-65535. It is rejected (`FAIL stage=preflight reason="WEEKLY_TUNNEL_PORT must not be 55432, 55433 or the backup tunnel port"`) when it equals 55432, 55433, or the **effective** backup port (`loadConfig(env).port` from `backup.mjs`, so a custom `BACKUP_TUNNEL_PORT` is covered too). This check runs before the lock, any CLI call or any child.
- **Lock:** `WEEKLY_STATE_DIR` (default `~/Library/Logs/chalk-that-nba`) + `/weekly.lock`, a mkdir lock with `pid` and `tunnel.json`, mode 0700/0600, like the backup's. It is not under the repo's `logs/` (only `*.log` is gitignored there). The code asserts that `weekly.lock` is never the backup's `lockDir`. If the lock is held by a live pid: `FAIL stage=preflight reason="another weekly run is in progress"`. If the lock is stale: `tunnel.reapStale()` with **the weekly record only**, then remove the lock.
- **Reaper scoping (both directions):** each script's `createTunnel` gets its own `port` and `lockDir`. Stale-tunnel reaping reads only its own `tunnel.json` and requires `isRailwayTunnelCmd(..., -P <own port>)`. Orphan reaping looks only at listeners on `127.0.0.1:<own port>` whose argv forwards that exact port. Ports and lock dirs are different by construction (rule above), so neither job can ever pick the other's processes. The drill proves both directions (§7, cases W16-W17).
- The weekly job **never** creates, removes or reaps `backup.lock`. It only reads it (§4, step 3).

## 4. Decisions 3 and 4: credential flow and run order

### 4.1 How the tunnel URL reaches the steps
- `open()` returns `{ user, password, database }` (in memory, from the CLI output, as the backup does). `weekly.mjs` builds `postgres://<enc user>:<enc pw>@127.0.0.1:<port>/<enc db>` with `encodeURIComponent`.
- That URL is set as `DATABASE_PUBLIC_URL` **only in each step child's env**: `{ ...process.env, DATABASE_PUBLIC_URL: url }`, minus `WEEKLY_CONFIRM_PROD` and `BACKUP_CONFIRM_PROD`. `process.env` of `weekly.mjs` is never changed. So `railway`, `db:backup` and the notifier never see it. Because the process env wins over `.env`, a stale `DATABASE_PUBLIC_URL` left in the owner's `.env` is overridden.
- The URL is never put in argv, a file, `tunnel.json` or a log. The password is cleared after the last step.
- **Child output is redacted before it is written.** Step and backup stdout/stderr are piped through a line-buffered redactor (`redact(line, [password])` from `backup.mjs`, which also masks any `postgres://...` token). Line buffering keeps a secret split across chunks from slipping through. Steps print `127.0.0.1:<port>` as the host (`db-status.mjs:14`), which is not secret.
- `weekly.mjs` must not import `scripts/lib/env.mjs` or read `.env`, the same rule as `backup-db.mjs`. The step scripts read `.env` themselves for their API keys.

### 4.2 Run order (`scripts/weekly.mjs`)
Exit codes: 0 OK, 1 failure, 2 `stage=cleanup` (port still held after close), 130/143/129 for SIGINT/SIGTERM/SIGHUP.

1. **Config.** Season arg (default `2026-27`, must match `^\d{4}-\d{2}$`), port rules (§3), `WEEKLY_BACKUP_WAIT_S` (default 600, allowed **1-600**, so it can only shorten the owner's 10 minutes), `WEEKLY_STEP_TIMEOUT_S` (default 3600, 1-14400), `WEEKLY_TUNNEL_TIMEOUT_S` (default 60), `WEEKLY_PG_SERVICE` (default `Postgres`), `WEEKLY_RAILWAY_ENV` (default `production`), `WEEKLY_RAILWAY_BIN` (absolute if set), `WEEKLY_LOG` (default `<repo>/logs/weekly.log`), `WEEKLY_NOTIFY` (`0` disables). Bad config gives `FAIL stage=preflight`.
2. **Production guard (first check, before the lock, the backup drive, any CLI call or any child).** New flag **`WEEKLY_CONFIRM_PROD`**, which must be exactly `"1"`. It is off by default; `true`, `yes`, `01` and ` 1` are refused. Same allow-list as `prodGuard`: exempt only when `WEEKLY_RAILWAY_BIN` resolves (realpath) to this repo's `scripts/fixtures/fake-railway.sh`. Implemented as a generic `confirmGuard(env, flagName, binVar)` in `backup.mjs`. `prodGuard` becomes a one-line call to it, with the same message and the same unit tests. Two more rules:
   - **Real weekly needs `BACKUP_CONFIRM_PROD=1` as well** (the pre-write backup hits production). It refuses up front instead of failing later inside the backup child. Lead default; see §9, item 1.
   - **Fake weekly needs a fake backup:** if weekly is exempt, then `prodGuard(env without BACKUP_CONFIRM_PROD)` must also return null (`BACKUP_RAILWAY_BIN` is the fake). Otherwise it refuses. This way a test run of the weekly job can never start a real backup.
   - Refusal: `FAIL stage=preflight reason="production run not confirmed (set WEEKLY_CONFIRM_PROD=1 and BACKUP_CONFIRM_PROD=1)"`.
3. **Preflight.** Take the weekly lock (stale -> weekly-scoped reap), resolve railway (same as `resolveRailway`), run `railway whoami`, check the weekly port is free (an orphan on the **weekly** port may be reaped; any other listener gives `FAIL stage=preflight reason="tunnel port <p> is already in use"`, untouched). Doing this before the backup avoids spending a backup on a run that cannot open its tunnel.
4. **Pre-write backup (`stage=backup`).** `bcfg = loadConfig(env)` from `backup.mjs`, so the dir, log and lock are the same ones the backup uses. Loop until `deadline = now + WEEKLY_BACKUP_WAIT_S`:
   - a. **Backup lock held by a live pid** (same liveness test as `takeLock`: `kill(pid,0)`, where EPERM counts as alive): log `NOTE waiting for a running backup` once, poll every 2 s. At the deadline: `FAIL stage=backup reason="backup still running after <n>s"`. A stale lock (dead pid) is ignored here; the backup script cleans it up itself.
   - b. **Fresh validated backup?** `findFreshBackup()` (pure, in `scripts/lib/weekly.mjs`). It returns the newest name that meets **all** of these:
     - The volume is a mount point (`isMountPoint`), and `bcfg.dir` is read-only listed.
     - The name matches `DUMP_RE`, the entry is a **regular file** (lstat, not a symlink), and its size is > 0.
     - Its UTC name timestamp satisfies `0 <= now - stamp < 24 h` (a stamp more than 5 min in the future is rejected).
     - `backup.log` (last 1 MB) contains a line matching `^\S+Z OK +file=<exactly that name> `.

     The name alone proves `pg_restore --list` + `teams` passed (rename happens only after validation). The OK line proves the run finished rotate and port cleanup. A dump from a run that ended `FAIL stage=rotate|cleanup` is **not** reused, which is conservative. If a backup is found: log `NOTE using backup <name> (age <h>h)` and go on.
   - c. **Otherwise run `scripts/backup-db.mjs`** (`process.execPath`, cwd = repo, `env = process.env`, own process group, output redacted into the weekly log, tracked as the active child). No weekly-level timeout applies (the backup has its own 60 s tunnel and 1800 s dump limits).
     - Exit 0: call `findFreshBackup()` again; it must now find a dump, or `FAIL stage=backup reason="backup reported OK but no validated dump found"`.
     - Non-zero: if the child's last stderr line is exactly `... FAIL stage=preflight reason="another backup is running"` (a fixed string, safe to match) and time is left before the deadline, go back to (a). This is the race where launchd's backup took the lock first. Any other non-zero exit: `FAIL stage=backup reason="db:backup failed (exit <n>)"`. **No tunnel is opened and nothing is written.**
5. **Open tunnel (`stage=tunnel`)**: `tunnel.open()` on the weekly port, record kept in `weekly.lock/tunnel.json`.
6. **Steps, in order, stop at first failure:** `schedule` (`scripts/load-schedule.mjs --season S`), `positions` (`scripts/load-positions.mjs`), `backfill` (`scripts/backfill.mjs --season S`), `status` (`scripts/db-status.mjs`). Each is spawned as `process.execPath <script>` in its own process group with the env from §4.1. Spawning node directly instead of `npm run`: one less process layer for signals, and no npm error output. A unit test asserts that the step table matches the `db:schedule/positions/backfill/status` entries in `package.json`. Results:
   - Non-zero exit: `FAIL stage=<step> reason="exit <n>"`.
   - Timeout: SIGTERM to the group, 10 s, SIGKILL, then `FAIL stage=<step> reason="timed out after <n>s"`.
   - The rollback of a killed step depends on each script's own transactions. That is pre-existing: backfill is one transaction per season (`backfill.mjs:9-10`).
7. **Close tunnel on every exit path:** `tunnel.kill()` (ssh child first, then railway, the M4 sequence), then **port-free verification**. If the port is still held after the orphan sweep: `FAIL stage=cleanup reason="tunnel port <p> still in use after run"`, exit 2, even if all steps passed (same rule as the backup).
8. **Finish:** one result line, `=== exit N ===`, notification, release the lock.
- **Signals (SIGINT/SIGTERM/SIGHUP):** SIGTERM the active child's group. For the backup child, wait up to 30 s so it closes **its own** tunnel through its own handler, then SIGKILL. Then `tunnel.kill()`, release the lock, log `FAIL stage=<current> reason="interrupted by <SIG>"`, and exit 130/143/129. A `finishing` latch makes a second signal wait for the cleanup already running. The `process.on('exit')` last resort calls `tunnel.killSync()` and SIGKILLs the active child's group.
- **Backup and weekly firing together at wake:**
  - Backup first: weekly waits in 4a, then reuses that dump in 4b.
  - Weekly first: its backup child takes the lock. launchd's backup then fails with "another backup is running"; that is a known side effect, see §9, item 3.
  - Both see no lock at once: the loser either gets the retry in 4c (weekly) or the backup's own lock refusal.
  - Weekly reuses an older fresh dump while the daily backup runs at the same time: two tunnels on different ports, scoped as in §3.

## 5. Decision 5: zsh wrapper around a node orchestrator; log and notification

- **`scripts/weekly.sh` stays as the entry point**, so the plist's `ProgramArguments` and `npm run db:weekly` don't change. It shrinks to: `cd` to the repo, `mkdir -p logs`, then `exec node scripts/weekly.mjs "$@"`. With `exec`, launchd's SIGTERM reaches node directly (zsh does not reliably forward signals to a foreground child). Fallback: if `node` is not on PATH, zsh appends a FAIL line to `logs/weekly.log` and sends the notification itself.
- **Log:** `logs/weekly.log` stays the human log (gitignored via `*.log`). `weekly.mjs` creates and appends it with mode 0600:
  - header `=== YYYY-MM-DD HH:MM weekly run, season S ===`
  - `NOTE` lines
  - redacted child output
  - one result line, `<iso> OK season=S backup=<reused|new>:<name> duration=Ns` or `<iso> FAIL stage=<preflight|backup|tunnel|schedule|positions|backfill|status|cleanup> reason="..." duration=Ns`
  - `=== exit N ===`
- **Notification:** sent from node through absolute `/usr/bin/osascript` (M4 Sec note 6), with the same texts as today ("Weekly NBA.com run OK" / "... FAILED — see logs/weekly.log"). `WEEKLY_NOTIFY=0` turns it off for the drill.

## 6. Decision 6: plist

`ops/launchd/com.chalkthat.nba.weekly.plist`:
- add `EnvironmentVariables` with `WEEKLY_CONFIRM_PROD=1` and `BACKUP_CONFIRM_PROD=1`, plus a comment that these are opt-ins, not secrets
- move `StandardOutPath`/`StandardErrorPath` from `/tmp/chalk-that-nba-weekly.*` to `~/Library/Logs/chalk-that-nba/weekly.launchd.{out,err}` (absolute `/Users/jayprox_pro/...`, like the backup plist)
- keep the schedule (Mon 09:07) and `zsh -l` as they are

The team checks it only with `plutil -lint` (drill). **Nobody on the team copies, loads, unloads or starts it.** The README tells the owner to install it after the first good manual run.

## 7. Tasks (one PR, one commit each)

| # | Task | Files | Definition of done |
|---|---|---|---|
| T1 | Pure refactor: extract `scripts/lib/tunnel.mjs` (§2); `backup-db.mjs` uses it. Add `confirmGuard` and make `prodGuard` a wrapper. | `scripts/lib/tunnel.mjs` (new), `scripts/backup-db.mjs`, `scripts/lib/backup.mjs` | `backup-drill.sh`, `backup.test.mjs` and fixtures unchanged in this commit; backup drill **108/0**; `npm test` green; all backup log strings still present |
| T2 | Fixtures: `fake-railway.sh` replaces `%p` in `FAKE_RAILWAY_PIDFILE`/`FAKE_RAILWAY_SSH_PIDFILE` with the `-P` port (backward compatible), so weekly's and the backup's fakes keep separate pidfiles. New `scripts/fixtures/fake-weekly-step.mjs <name> [args]`: uses `publicDbUrl()` (proves the plumbing through `env.mjs`), inserts `(step, args)` into the drill table `weekly_drill_marks`, and supports `FAKE_STEP_FAIL=<name>` (exit 3), `FAKE_STEP_HANG=<name>` (connects, then sleeps), `FAKE_STEP_SLOW=<name>:<s>`, `FAKE_STEP_PRINT_URL=1` (prints its URL to stdout and stderr, to prove redaction). | `scripts/fixtures/*` | backup drill still 108/0 |
| T3 | Pure helpers + unit tests: `loadWeeklyConfig`, port rules, `weeklyGuard` (both flags, mixed-mode refusal), `findFreshBackup`, `buildTunnelUrl`, `stepEnv`, `lineRedactor`, `STEPS` table, `backupLockState`. | `scripts/lib/weekly.mjs`, `scripts/lib/weekly.test.mjs` | `npm test` green, cases in §8.1 |
| T4 | Orchestrator + wrapper. Test hook: `WEEKLY_STEP_FIXTURE=1` swaps schedule/positions/backfill for `fake-weekly-step.mjs`; `status` stays the **real** `db-status.mjs` (DB-only, read-only). The hook is honored **only** when weekly is fake-exempt (realpath check); otherwise `FAIL stage=preflight reason="step fixture requires the fake railway"`. Add `db:weekly:drill` to `package.json`; `db:weekly` unchanged. | `scripts/weekly.mjs` (new), `scripts/weekly.sh`, `package.json` | runs green in the drill |
| T5 | `scripts/weekly-drill.sh` (§8.2) | new | all cases PASS; record the count; backup drill still 108/0 |
| T6 | Plist + docs (§6, §10) | plist, `ops/launchd/README.md`, `README.md`, `.env.example`, `docs/architecture.md`, `docs/backup-restore.md` | `plutil -lint` OK; no `DATABASE_PUBLIC_URL` guidance left for the weekly job |
| T7 | PR: link M5 + this plan, list both drill counts, state "no production runs" | — | CI green |

## 8. Decision 7: test strategy

### 8.1 Unit (`scripts/lib/weekly.test.mjs`, runs in CI through the existing root job, no workflow change)
- **Port:** default 55434. 55432, 55433 and `BACKUP_TUNNEL_PORT`'s value are each rejected; non-integer, <1024 and >65535 are rejected. Wait-s 0 and 601 rejected; season `2026-2027` rejected.
- **Guard:**
  - unset, `""`, `true`, `yes`, `01` and `" 1"` are refused; `"1"` with `BACKUP_CONFIRM_PROD=1` passes
  - `"1"` without the backup flag is refused
  - the fake (by realpath) is exempt; a copy, or a symlink to another file, is not
  - fake weekly with the backup bin unset (real) is refused
  - `prodGuard`'s existing tests are unchanged and still pass
- **`findFreshBackup`:**
  - 1 h old + OK line -> reused; 23 h 59 m -> reused; 24 h -> not
  - file without an OK line -> not; OK line for a different name -> not
  - future stamp -> not; `.partial` -> not; symlink -> not; size 0 -> not; `chalk-that-nba_manual.dump` -> not
  - picks the newest of several; volume not mounted -> none
- **Credential handling:**
  - `buildTunnelUrl` round-trips a password with `@:/%#?` in it
  - `stepEnv` adds the URL, strips both flags, and leaves the input object unchanged
  - `lineRedactor` masks a password split across two chunks, and any `postgres://` token
- **Step table:** `STEPS` matches the `package.json` scripts.

### 8.2 Weekly drill (`npm run db:weekly:drill`, local only)
**Setup:** same harness as `backup-drill.sh`:
- one throwaway `postgres:18` container (same tag as the backup drill; the digest pin is the open F5(6) follow-up for both), seeded with `db:apply` + `db/tests/backup_drill_seed.sql` + a `weekly_drill_marks` table
- an `hdiutil` disk image as the backup volume (the real `backup-db.mjs` runs, using the fake railway)
- random passwords and ports, `WEEKLY_LOG`/`WEEKLY_STATE_DIR`/`BACKUP_LOG` under `$WORK`, `WEEKLY_NOTIFY=0 BACKUP_NOTIFY=0`

**Safety:**
- every launch goes through `env -i` + `build_env`, which aborts the drill unless `WEEKLY_RAILWAY_BIN` and `BACKUP_RAILWAY_BIN` are the verified fake
- a production flag is never combined with a PATH lookup
- a shadow `railway` wins the PATH and records any call

**Cases** (each also checks: the weekly fake railway and its ssh-like forwarder are dead, the weekly port is free, the weekly lock is released, and no password appears in the log or stdout/stderr):
- **W1 Guard refusal:** no flag (shadow on PATH), and the flag set to `true`/`01`. Exit 1, `FAIL stage=preflight`, shadow never called, backup log unchanged, no lock, 0 marks.
- **W2 Mixed mode:** fake weekly + `BACKUP_RAILWAY_BIN` unset is refused.
- **W3 Port config:** `WEEKLY_TUNNEL_PORT` set to 55432, to 55433, and to the drill's `BACKUP_TUNNEL_PORT` is refused before anything else runs.
- **W4 Port conflict:** a plain node listener on the weekly port gives `FAIL stage=preflight ... already in use`, the listener is still alive, and no backup ran.
- **W5 Happy path, no backup yet:**
  - exit 0; exactly one new dump and one new backup `OK` line
  - marks schedule, positions, backfill in that order, with `--season 2026-27`
  - the real `db:status` output appears in the weekly log
  - `=== exit 0 ===`
  - a ps sampler shows no password in any argv
- **W6 Fresh reuse:** run again right away. No new dump, no new backup log line, `NOTE using backup`, exit 0.
- **W7 Stale backup:** the dir holds only a synthetic dump stamped 25 h ago, with a matching OK line. A new backup runs.
- **W7b** Recent dump without an OK line: a new backup runs.
- **W8 Backup failure aborts:** no fresh dump and the image detached. `FAIL stage=backup`, the weekly tunnel was never started (no `fake.<WTP>.pid`), 0 new marks.
- **W9-W12 Each step fails:** `FAKE_STEP_FAIL` = schedule / positions / backfill, and real `status` made to fail (rename `ingestion_runs`, then restore it). Each gives `FAIL stage=<step>`, later steps not marked, and the tunnel and ssh closed.
- **W13 Step timeout:** `FAKE_STEP_HANG=backfill`, `WEEKLY_STEP_TIMEOUT_S=3`. `FAIL stage=backfill ... timed out`, the step's group is dead, status was not run.
- **W14 Signals:**
  - SIGINT and SIGTERM to weekly's node pid during a hung step give exit 130/143; the step, railway and ssh are dead.
  - SIGTERM while the **backup child** runs (`FAKE_RAILWAY_MODE=silent`; only the backup's tunnel exists at that point, `BACKUP_TUNNEL_TIMEOUT_S=30`): the backup logs FAIL interrupted, the backup's fake and ssh are dead, the backup port is free, weekly exits 143, 0 marks.
- **W15 Crash recovery:** SIGKILL weekly mid-step. The next weekly run reaps its own stale tunnel and exits 0.
- **W16 Weekly never touches backup tunnels:** an orphaned backup-port ssh forwarder (PPID 1) plus a live backup-port fake tunnel. A weekly run (fresh reuse) exits 0, and both backup-port processes are still alive afterwards.
- **W17 Backup never touches weekly tunnels:** an orphaned weekly-port forwarder. `db:backup` exits 0, and the forwarder is still alive.
- **W18 Live concurrency:** weekly running a slow step with its tunnel open while `db:backup` runs with its own tunnel. Both exit 0, weekly's ssh is alive right after the backup finishes, and both ports are free at the end.
- **W19 Lock wait success:** a synthetic `backup.lock` with a live `sleep` pid, `WEEKLY_BACKUP_WAIT_S=20`; release it after 3 s. Exit 0 and `NOTE waiting`.
- **W19b Both fire at wake:** start a real `db:backup` in the background, start weekly once the backup's lock exists. Weekly waits, then reuses that dump (exactly one new dump), exit 0.
- **W20 Lock wait timeout:** a held lock, `WEEKLY_BACKUP_WAIT_S=3`. `FAIL stage=backup ... still running after 3s`, the lock dir and the `sleep` are untouched, no tunnel, 0 marks.
- **W21 Stale backup lock (dead pid):** the backup runs and cleans it up, then weekly exits 0.
- **W22 Redaction:** `FAKE_STEP_PRINT_URL=1`. The password and the URL are absent from the weekly log and from stdout/stderr.
- **W23 Test hook outside fake mode:** `WEEKLY_STEP_FIXTURE=1` with a non-fake (shadow) bin and the flags set is refused at preflight. The shadow bin is used through an absolute `WEEKLY_RAILWAY_BIN`, and `build_env` allows the shadow only in this case.
- **W24 Plist:** `plutil -lint` passes on the weekly plist, which contains both flags set to exactly `1`.
- **Regression:** `npm run db:backup:drill` stays 108/0. Run both drills before the PR.

**CI:** the backup drill is not in CI (it needs macOS `hdiutil` and Docker), so the weekly drill is local only as well, and `docs/architecture.md` §9.3 records it the same way. The new unit tests run in CI automatically through the existing `scripts/lib/*.test.mjs` glob.

## 9. Owner decisions / flags (none block Dev; confirm or override at Gate 2)

1. **Two flags.** Lead default: a real weekly run needs `WEEKLY_CONFIRM_PROD=1` **and** `BACKUP_CONFIRM_PROD=1` (the plist sets both). Each guard keeps one meaning, and neither flag implies the other. Manual run: `WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1 npm run db:weekly`. Alternative: weekly passes `BACKUP_CONFIRM_PROD=1` to its backup child on its own.
2. **The weekly job now depends on the `DB-Backups` drive** (a consequence of Gate 1 answer 1). With the drive unmounted there is no fresh backup to find, and the backup fails, so the weekly run aborts with `stage=backup` and a notification.
3. **Known noise at wake:** if the weekly job's backup takes the lock first, the launchd daily backup logs `FAIL stage=preflight reason="another backup is running"` and sends a failure notification, even though a backup was taken. Removing this would change backup behavior, which is out of scope for M5. Possible follow-up: the backup exits 0 with a `SKIP` line when the lock is held.
4. **Not verified on the real CLI:**
   - Two `railway connect --tunnel-only` sessions at once (the `~/.railway` lock files were noted in the M3 incident). This happens only when weekly reuses a dump while the daily backup runs.
   - The T1 refactor touches the backup's production path. The M4 owner check (a real backup run, then `lsof`/`pgrep` empty) should happen before or together with the M5 first run. That first run takes a new backup unless one under 24 h exists, so it exercises the refactored backup path.

   If the first real weekly run ends `FAIL stage=cleanup`, report it; do not retry (same rule as M4).

Not significant architecture changes, in the Lead's view: the shared module stays inside the root package; the orchestrator moves from zsh to node with the same entry point, log and notification; steps are spawned directly instead of through npm. These are routine and inside the approved requirement.

## 10. Decision 8: docs

- **`docs/architecture.md`:**
  - §7.5.1 weekly bullet: tunnel, positions step, pre-write backup, flags.
  - §8 L696-703: the weekly job uses the CLI tunnel on 55434 and needs no public proxy. One-off root scripts (`db:seed`, full `db:backfill`, `db:standings`, `db:review`, backend `create-user`) still read `DATABASE_PUBLIC_URL`. For a manual session, open a tunnel by hand on another port (for example `railway connect Postgres --tunnel-only -P 55435`) and set `DATABASE_PUBLIC_URL` in that shell only. Never 55432-55434: the reapers treat orphans on those ports as theirs.
  - §9.2 connection bullet; §9.3 add a weekly drill row and the new unit-test count.
- **`ops/launchd/README.md` weekly section:**
  - steps and order, pre-write backup and 10-min wait, both flags
  - first manual run, then install
  - new launchd log paths
  - failure modes: railway login, drive unmounted, port 55434 in use
  - the "another backup is running" note
- **`README.md`:**
  - L146: `DATABASE_PUBLIC_URL` is no longer needed for the weekly job
  - L152: command table gets the flags and positions
  - add `db:weekly:drill` to the commands
  - L138 (`create-user`) still uses `DATABASE_PUBLIC_URL`: add "via a manual tunnel"
- **`.env.example`:** reword the `DATABASE_PUBLIC_URL` comment as "optional, manual one-off scripts only; the weekly job uses the Railway CLI tunnel". Lead could not read this file (permission); Dev checks it for any other weekly reference.
- **`docs/backup-restore.md`:** one paragraph: the weekly job may trigger a backup or wait for one.
- `docs/plans/M3-backup.md`, `docs/plans/M4-backup-ssh-child.md`: historical records, **not edited**.
- **`backend/scripts/dev.js`: out of scope, unchanged.** It still falls back to `DATABASE_PUBLIC_URL` (L2, L14) for the local backend against Railway, which needs a manual tunnel now. Follow-up note in architecture §8 only.

## 11. Risks

- **Refactor regression in the backup.** Mitigation: T1 isolated, drill 108/0 with an unchanged harness, string grep, reviewers diff T1 alone.
- **Real CLI argv or timing differs from the fixture.** Fails closed (`stage=tunnel` or `stage=cleanup`), and the owner's first run checks it.
- **The test hook in production code** (`WEEKLY_STEP_FIXTURE`) is a bypass risk. It is gated on the fake realpath; W23 and Sec review cover it.
- **Long backfill vs `WEEKLY_STEP_TIMEOUT_S=3600`.** The weekly single-season run is normally minutes (a full 23-season run is about 10 min, per the README), so the default leaves a wide margin.
- **Children keep running if node is SIGKILLed.** Steps run in their own groups; the exit handler cannot run on SIGKILL. The tunnel is reaped by the next run (W15). An orphaned step process could keep writing until it finishes; its own transaction rules apply. This is the same class of risk as today's zsh job.
