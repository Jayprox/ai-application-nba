# M3: Off-Railway Postgres backups + restore drill

- **Status:** Plan ready for Dev. No owner decision blocks implementation (see §9 for items the owner should confirm before the first production run).
- **Requirement source:** "Mission M3-backup" in `docs/STATUS.md`: the mission text and the owner approvals of 2026-11-01 (Gate 1, storage, native-backup decision, retention/schedule, and the `DB-Backups` volume resolution). There is no `docs/requirements/` file.
- **Branch:** `feat/db-backup` (`feat/*` push is pre-approved in `.claude/settings.json`). One PR. The Developer commits this plan with the change, as in M1.
- **Reviews:** QA (always) **and Security** (required: production credentials pass through the script, the dumps hold production data including `users` password hashes, and the change adds a new local tool and an unattended job).
- **Hard rule for every role:** nothing in this mission runs against production. No `railway connect`, `railway run`, `railway variables`, `railway ssh`, or `pg_dump` against the Railway project. All testing uses throwaway local `postgres:18` containers and a fake `railway` binary (§5). The first production run is task T6, after a separate owner approval.

## 1. Facts the plan depends on

| Fact | Source |
|---|---|
| Postgres service is listed as **"Postgres (18)"**, Railway template, private only. The service *name* is assumed to be `Postgres`. It cannot be confirmed without querying Railway, so the name is configurable (`BACKUP_PG_SERVICE`, default `Postgres`) and T6 confirms it. | `docs/architecture.md` §8 table, line 690 |
| Project `chalk-that-nba`, environment `production`. | `docs/architecture.md` §8, line 685 |
| The public TCP proxy was removed on 2026-11-01, so the only path is the CLI SSH tunnel. | `docs/architecture.md` §8, line 698 |
| `railway connect [SERVICE] --tunnel-only -P <port> -e <env>`: implies `--ssh`, prints host/port/user/password/URL to stdout, and holds the tunnel until it is killed. The help text says "Non-interactive runs must pass the database service name." | `railway connect --help` (CLI 5.71.0, run 2026-11-01) |
| The exact stdout format of `--tunnel-only` is **not documented**. It was added in railwayapp/cli PR #1018. The source (`src/commands/connect.rs`) is public. | GitHub railwayapp/cli #1018, docs.rs `railwayapp` source |
| Public reports exist of SSH forwarding failing for some services ("unknown channel type"). The first real run may fail for reasons outside our code. | station.railway.com thread (§10 R2) |
| No `pg_dump`/`psql` on this Mac. Docker 29.9 and Railway CLI are at `/opt/homebrew/bin`. | `which` output, 2026-11-01 |
| Root scripts are plain ESM `.mjs`; `node:test` unit tests in `scripts/lib/*.test.mjs` run in CI via root `npm test` (glob, no list to edit). Unattended jobs follow `scripts/weekly.sh` + `ops/launchd/` (`/bin/zsh -l`, Full Disk Access granted to `/bin/zsh`). | `package.json`, `.github/workflows/test.yml`, `ops/launchd/README.md` |
| Root scripts load `.env` (with `DATABASE_PUBLIC_URL`) through `scripts/lib/env.mjs`. | `scripts/lib/env.mjs` |

## 2. Decisions (Lead, routine, inside the approved requirements)

**D-a. Language: Node (`scripts/backup-db.mjs`), not a pure shell script.** It must start a long-running child, read its stdout *in memory*, parse a secret out of it, wait for a port, run a second child with a custom env, and always kill the first child. That is reliable in Node (`child_process.spawn`, pipes, signal handlers) and fragile in zsh. The pure parts (config, filename, parsing, redaction, rotation, path guards) go in `scripts/lib/backup.mjs` and get unit tests that CI already runs. This matches the existing root-script convention. **No new npm dependencies.**

**D-b. Postgres client: Homebrew `libpq` (v18), not `docker run postgres:18 pg_dump`.**
- launchd runs at a fixed time, maybe right after a wake or reboot. Docker Desktop is often not running then, and starting it unattended is slow and unreliable. A missing Docker would turn every unattended run into a failure.
- With Docker, the tunnel would have to be reached via `host.docker.internal`, and the password would have to go to `docker run -e`. `-e NAME=value` puts it on argv, and `-e NAME` alone still exposes it through `docker inspect`. libpq keeps it in one child process env.
- `pg_dump` refuses to dump a newer server major version, so the client must be 18+. The script checks `pg_dump --version` major >= 18 before opening the tunnel.
- libpq is keg-only: binaries are at `/opt/homebrew/opt/libpq/bin` and are not on `PATH`. The script uses `BACKUP_PG_BIN_DIR` (default `/opt/homebrew/opt/libpq/bin`) and absolute paths, so the launchd `PATH` does not matter.
- Docker is still used, but only by the restore drill (§5) for throwaway servers.
- Installing `libpq` is a machine tool, not a repo dependency. It is listed for the owner in §9.

**D-c. Credentials: parse the tunnel's stdout in memory, pass them by env to `pg_dump`.**
1. Spawn `railway connect <service> --tunnel-only -P <port> -e <env>` with `stdio: ['ignore', 'pipe', 'pipe']`, `detached: true` (own process group; **M4 correction:** this does NOT take the SSH child, which the CLI puts in its own group, see `docs/plans/M4-backup-ssh-child.md`), cwd = repo root (where the project is linked).
2. Buffer stdout and stderr in memory only. **Never** write them to the log, the console, or a file, even on failure. Cap the buffer (64 KB) and keep draining the pipes after parsing, so the child never blocks on a full pipe.
3. Parse the first `postgres://` or `postgresql://` token with `new URL()`. Take user, password (percent-decoded), and database. If the stdout shows the URL with a different shape, the Dev adapts the parser to what `connect.rs` at tag v5.71.0 prints (read the public source; do not run it). Write unit tests from that format. **Fail closed:** if parsing fails, log `FAIL stage=tunnel reason="could not parse tunnel output (output withheld)"`.
4. **Identity check:** the parsed host must be `127.0.0.1` or `localhost`, and the parsed port must equal the requested `-P` port. Otherwise fail. This guarantees the dump never goes over some other route.
5. Wait for readiness: TCP connect to `127.0.0.1:<port>` succeeds (poll every 500 ms). Overall tunnel timeout `BACKUP_TUNNEL_TIMEOUT_S` (default 60).
6. Run `pg_dump` with argv holding **no secret**: `-h 127.0.0.1 -p <port> -U <user> -d <db> --format=custom --no-owner --file=<partial>`. The user and db names on argv are not secrets. The env is built **from scratch**: `PATH`, `HOME`, `LANG`, `PGPASSWORD`, `PGCONNECT_TIMEOUT=15`, `PGAPPNAME=chalk-backup`. No inherited `PG*`, `DATABASE_*`, or `.env` values. The script must **not** import `scripts/lib/env.mjs` and must not read `.env`.
7. Before spawning the tunnel, the script checks that `<port>` is free (bind test). If something already listens there (for example a local Postgres), it fails: otherwise the readiness probe would pass and the script would dump the wrong database.
8. After the dump, `PGPASSWORD` and the parsed URL are dropped (variables overwritten and set to null). They never go into an `Error` message (errors are built from fixed strings plus redacted stderr).

Rejected: `PGPASSFILE` or `~/.pgpass` (writes the secret to disk); a URL on argv (`ps`-visible); `railway variables --json` (a second secret path, and it needs the very credential we're avoiding); `railway run pg_dump` (injects the internal URL, which isn't reachable from the Mac anyway).

**D-d. Mount check before anything touches the network.**
- `BACKUP_VOLUME` (default `/Volumes/DB-Backups`), `BACKUP_DIR` (default `$BACKUP_VOLUME/db-backups`).
- The volume must be a **real mount point**: `stat(volume).dev !== stat(dirname(volume)).dev`. A plain `existsSync` is not enough: if the drive is unplugged and something has created `/Volumes/DB-Backups` as a directory, a write would silently land on the boot disk.
- `realpath(BACKUP_DIR)` must be inside `realpath(BACKUP_VOLUME)`. It must **not** be under `/Volumes/TM-Prism` (hard-coded deny, checked after `realpath`, case-insensitive), and not inside the repo.
- If `BACKUP_DIR` doesn't exist on a mounted volume, create it with mode `0700`.
- Any failure here: log `FAIL stage=preflight ...`, notify, exit 1. **The tunnel is never started.**

**D-e. Write, validate, rename, then rotate.**
- Filename: `chalk-that-nba_<YYYYMMDDTHHMMSSZ>.dump` (UTC, so names sort by time). Temp: same name + `.partial`. `umask 077`; files `0600`.
- Validate the `.partial`: size > 0; `pg_restore --list <file>` exits 0; the list contains `TABLE DATA public teams` (proves it's this app's database, not an empty or wrong one). On failure, delete the `.partial`, log `FAIL stage=validate`, keep all old dumps.
- `fsync` the file, `rename()` to the final name (same directory, so it's atomic), `fsync` the directory.
- Rotation runs only after a successful rename. It considers **only** names matching `^chalk-that-nba_\d{8}T\d{6}Z\.dump$`, sorts them descending, keeps `BACKUP_KEEP` (default 14, integer >= 1), and deletes the rest. It never deletes the file just written, and never touches any other name (including `*.partial` from other tools, manual copies, and `.DS_Store`).
- At start (after taking the lock), delete leftover `chalk-that-nba_*.dump.partial` files from crashed runs.
- If rotation fails after a good dump: keep the dump, log `FAIL stage=rotate` (with the new file name), exit 2.

**D-f. Tunnel lifecycle.** One `cleanup()` kills the tunnel's process group (`SIGTERM`, then `SIGKILL` after 5 s) and deletes any `.partial`. It runs on normal exit, on any thrown error, and on `SIGINT`/`SIGTERM`/`SIGHUP` (the handlers call cleanup and then exit 130/143). Also, a synchronous `process.on('exit')` sends `SIGKILL` to the group as a last resort. `pg_dump` has its own timeout `BACKUP_DUMP_TIMEOUT_S` (default 1800). When it fires, kill `pg_dump` and then clean up. `railway` stdin is `ignore`, so a login prompt can't hang the run (the tunnel timeout catches it).

**D-g. Single run at a time.** A lock directory `~/Library/Logs/chalk-that-nba/backup.lock` is created with `mkdir`, which is atomic, and holds the PID. If the lock exists and its PID is alive: `FAIL stage=preflight reason="another backup is running"`. If the PID is dead, remove the stale lock.

**D-h. Logging.** `BACKUP_LOG` (default `~/Library/Logs/chalk-that-nba/backup.log`, dir `0700`). This is outside the repo and off the backup drive, so a missing drive is still recorded. Append one line per run:
```
2026-11-02T03:17:05Z OK   file=chalk-that-nba_20261102T031705Z.dump size=12.3MB kept=14 deleted=1 duration=42s
2026-11-03T03:17:02Z FAIL stage=preflight reason="volume /Volumes/DB-Backups is not mounted" duration=0s
```
Stages: `preflight | tunnel | dump | validate | rename | rotate`. `pg_dump`/`pg_restore` stderr may be appended (trimmed to 500 chars) **only after** `redact()`, which removes the password string, anything matching `postgres(ql)?://\S+`, and `password=\S+`. Railway output is never logged. The console prints the same single line (launchd `StandardOut/ErrorPath` capture it, so console output has the same rules). On failure, a macOS notification via `osascript` (as in `weekly.sh`) is sent, with no detail beyond "see backup.log".

**D-i. Railway session.** `railway connect` uses the CLI login in `~/.railway/config.json` and the project linked to the repo directory. Preflight runs `railway whoami` (local session check, reads no project data). If it fails: `FAIL stage=preflight reason="railway CLI not logged in"`. A project token (`RAILWAY_TOKEN`) is **not** used: it would have to live in the plist or an env file. The owner keeps an interactive `railway login`. Expired sessions show up as logged failures (§9).

## 3. Configuration (env only, no secrets, all with defaults)

| Var | Default | Notes |
|---|---|---|
| `BACKUP_VOLUME` | `/Volumes/DB-Backups` | must be a mount point |
| `BACKUP_DIR` | `$BACKUP_VOLUME/db-backups` | must resolve inside `BACKUP_VOLUME`; never under `/Volumes/TM-Prism` |
| `BACKUP_KEEP` | `14` | integer >= 1 |
| `BACKUP_LOG` | `~/Library/Logs/chalk-that-nba/backup.log` | |
| `BACKUP_PG_SERVICE` | `Postgres` | Railway service name (confirm at T6) |
| `BACKUP_RAILWAY_ENV` | `production` | passed as `-e` |
| `BACKUP_TUNNEL_PORT` | `55432` | must be free before start |
| `BACKUP_TUNNEL_TIMEOUT_S` | `60` | |
| `BACKUP_DUMP_TIMEOUT_S` | `1800` | |
| `BACKUP_PG_BIN_DIR` | `/opt/homebrew/opt/libpq/bin` | `pg_dump`, `pg_restore` |
| `BACKUP_RAILWAY_BIN` | `railway` resolved via `PATH`, else `/opt/homebrew/bin/railway` | **test seam**: the drill points it at a fake (§5) |

`BACKUP_RAILWAY_BIN` is the only test seam. There is no "skip the tunnel" or "skip the mount check" flag: the drill runs the real code path against a fake tunnel and a real (disk-image) mount, so no test-only branch can be left on in production.

## 4. Files

| File | New/changed | What |
|---|---|---|
| `scripts/lib/backup.mjs` | new | pure helpers: `loadConfig(env)`, `dumpName(date)`, `DUMP_RE`, `parseTunnelOutput(text, port)`, `redact(text, secrets)`, `selectForDeletion(names, keep)`, `isMountPoint`, `assertSafeBackupDir`, `buildPgEnv` |
| `scripts/lib/backup.test.mjs` | new | unit tests (§6.1); runs in CI via root `npm test` |
| `scripts/backup-db.mjs` | new | orchestrator (D-c to D-i) |
| `scripts/backup-db.sh` | new | thin launchd wrapper: `#!/bin/zsh -l`, `cd` to repo root, `exec node scripts/backup-db.mjs` (same Full Disk Access model as `weekly.sh`) |
| `scripts/backup-drill.sh` | new | local end-to-end harness (§5) |
| `scripts/fixtures/fake-railway.sh` | new | fake tunnel for the drill (§5) |
| `db/tests/backup_drill_seed.sql` | new | small sample data that satisfies every CHECK in `db/schema.sql` |
| `ops/launchd/com.chalkthat.nba.backup.plist` | new | daily template |
| `ops/launchd/README.md` | changed | backup section: install, test, permissions |
| `docs/backup-restore.md` | new | how it works, how to restore, Pro note |
| `docs/architecture.md` | changed | §8 short "Backups" paragraph linking the doc; §9.3 row for the drill |
| `README.md` | changed | command table: `db:backup`, `db:backup:drill` |
| `package.json` | changed | scripts `"db:backup": "node scripts/backup-db.mjs"`, `"db:backup:drill": "zsh scripts/backup-drill.sh"` (no dependency changes) |

`.github/workflows/test.yml`: **no change**. The new unit test file is picked up by the root glob. The drill needs macOS `hdiutil`, Docker, and libpq, so it stays local, as the backend data tests do.

## 5. Restore drill (`npm run db:backup:drill`)

Local only, macOS, needs Docker running and libpq installed. Everything goes into a `mktemp -d` work dir that a `trap` always removes. Container names get a random suffix, and the trap removes them too.

1. **Throwaway servers:** two `postgres:18` containers, `src` and `dst`. Each gets a random password generated per run (`openssl rand -hex 16`, never printed) and DB name `backup_test`. `src` publishes on `127.0.0.1:<random free port P>`, `dst` on another free port. Wait with `pg_isready`.
2. **Seed `src`:** `DATABASE_PUBLIC_URL=postgres://...@127.0.0.1:P/backup_test npm run db:apply` (schema + constraint tests). Then load `db/tests/backup_drill_seed.sql` via `docker exec -i ... psql`. The seed covers at least `teams`, `players`, `games`, a box-score/stat table, and `users`, and includes one non-ASCII name (for example `Dončić`).
3. **Fake mount:** `hdiutil create -size 64m -fs APFS -volname DRILL` in the work dir, then `hdiutil attach -nobrowse -mountpoint <work>/vol`. Set `BACKUP_VOLUME=<work>/vol`, `BACKUP_DIR=<work>/vol/db-backups`, and `BACKUP_LOG=<work>/backup.log`. This tests the real mount-point check.
4. **Fake tunnel:** `BACKUP_RAILWAY_BIN=scripts/fixtures/fake-railway.sh`, `BACKUP_TUNNEL_PORT=P`. The fake answers `whoami` with exit 0. For `connect ... --tunnel-only -P P`, it prints connection details in the **same format as the real CLI** (copied from `connect.rs` v5.71.0), with the `src` credentials and `127.0.0.1:P`, writes its PID to `<work>/fake.pid`, and then `sleep`s until killed. `FAKE_RAILWAY_MODE` selects failure modes: `silent` (prints nothing), `wrong-host` (URL points to a non-local host), `exit` (exits 1 at once).
5. **Happy path:** run `node scripts/backup-db.mjs`. While it runs, a background loop records `ps -axww -o args=` every 0.1 s into `<work>/ps.txt`. Then check:
   - exit 0; exactly one `chalk-that-nba_*Z.dump` in `BACKUP_DIR`, mode `0600`; no `.partial` left
   - the log's last line starts with `<timestamp> OK`
   - the fake tunnel PID is no longer alive
   - the drill password appears in **none** of: `backup.log`, the script's captured stdout/stderr, `ps.txt`, any file under `BACKUP_DIR` other than the dump. Check with `grep -F`; the harness prints only "found/not found", never the value.
6. **Restore + compare:** `pg_restore --no-owner --no-acl -d <dst url via PGPASSWORD env> <dump>`, exit 0. For every table in `information_schema.tables where table_schema='public'`, compare `count(*)` between `src` and `dst`; all equal, and the seeded tables are > 0. Compare `pg_dump --schema-only --no-owner` of `src` and `dst` after dropping `\restrict`/`\unrestrict` lines and comments; no diff. Run `DATABASE_PUBLIC_URL=<dst> npm run db:test`; it passes, so constraints were restored.
7. **Rotation:** with `BACKUP_KEEP=3`, add decoys to `BACKUP_DIR`: `notes.txt`, `chalk-that-nba_manual.dump`, `other_20250101T000000Z.dump`, and a stale `chalk-that-nba_20200101T000000Z.dump.partial`. Run the script 4 more times, at least 1 s apart. Expect exactly the 3 newest pattern-matching dumps; all decoys still present except the stale `.partial`, which is removed.
8. **Failure paths** (each exits non-zero, writes a `FAIL stage=<x>` line, leaves the existing dumps unchanged, and leaves no fake-tunnel process alive):
   - drive missing: `hdiutil detach`, then run → `stage=preflight`, and `fake.pid` was **never written** (the tunnel never started). Re-attach afterwards.
   - `BACKUP_DIR` under `/Volumes/TM-Prism/...` (string only; nothing is created there) → `stage=preflight`
   - port already in use (`nc -l` on P2, with `BACKUP_TUNNEL_PORT=P2`) → `stage=preflight`
   - `FAKE_RAILWAY_MODE=silent`, `BACKUP_TUNNEL_TIMEOUT_S=3` → `stage=tunnel`
   - `FAKE_RAILWAY_MODE=wrong-host` → `stage=tunnel`
   - `FAKE_RAILWAY_MODE=exit` → `stage=tunnel`
   - fake prints a valid URL with a wrong password → `stage=dump`, no `.partial` left, and the log line does not contain the password
   - validate failure: fake points to a DB with **no** `teams` table (a third empty DB `empty_test` on `src`) → `stage=validate`
   - `SIGTERM` sent to the script during the dump → exit 143; fake tunnel dead; no `.partial`
9. Summary: one `PASS`/`FAIL` line per check; exit 0 only if all pass. Cleanup detaches the image and removes the containers and the work dir, on every exit path.

## 6. Test strategy

### 6.1 Unit (`scripts/lib/backup.test.mjs`, runs in CI)
- `dumpName` gives UTC `chalk-that-nba_YYYYMMDDTHHMMSSZ.dump`, and names sort in time order.
- `DUMP_RE` matches only the script's own names (rejects `.partial`, `_manual`, other prefixes, extra suffixes).
- `selectForDeletion`: keeps the N newest; with fewer than N files deletes nothing; ignores non-matching names; `keep` < 1 or not an integer throws.
- `parseTunnelOutput`: parses the real format (fixture string modelled on `connect.rs` v5.71.0, with a fake password containing `@`, `:`, `/`, `%`); rejects a non-local host, a wrong port, and missing or garbled output. Error messages never contain the input text.
- `redact`: removes the password, `postgres://` and `postgresql://` URLs, and `password=` pairs.
- `assertSafeBackupDir`: rejects paths under `/Volumes/TM-Prism` (including `/volumes/tm-prism`, `..` traversal, and symlinks into it), outside the volume, and inside the repo.
- `buildPgEnv`: output has no keys other than the allow-list; inherited `PGHOST`, `PGDATABASE`, `DATABASE_PUBLIC_URL` are dropped.
- `loadConfig`: defaults as in §3; bad `BACKUP_KEEP` and bad port numbers are rejected.

### 6.2 End to end
`npm run db:backup:drill` (§5). The Dev runs it and pastes the summary into the PR. QA re-runs it.

### 6.3 Regression
All four suites stay green in CI. Root `npm test` count rises by the new unit tests.

## 7. Tasks for the Developer (one PR, in order)

| # | Task | Done when |
|---|---|---|
| T1 | `brew install libpq` locally; confirm `/opt/homebrew/opt/libpq/bin/pg_dump --version` reports 18.x. Read `src/commands/connect.rs` at railwayapp/cli tag v5.71.0 (public source, **read only, do not run against the project**). Record the exact `--tunnel-only` output format in the PR description, with the password shown as `<redacted>`. | Version and format recorded |
| T2 | `scripts/lib/backup.mjs` + `scripts/lib/backup.test.mjs` (§6.1) | `npm test` (root) green |
| T3 | `scripts/backup-db.mjs` + `scripts/backup-db.sh` + `package.json` scripts (D-c to D-i) | Manual run with defaults and no drive mounted → `FAIL stage=preflight` in the log, exit 1, no `railway` process started |
| T4 | `scripts/fixtures/fake-railway.sh`, `db/tests/backup_drill_seed.sql`, `scripts/backup-drill.sh` (§5) | Drill prints all PASS and exits 0; summary in the PR |
| T5 | `ops/launchd/com.chalkthat.nba.backup.plist` + README section (§8) | `plutil -lint` passes. **The Dev does not load it.** |
| T6-docs | `docs/backup-restore.md`, `docs/architecture.md` §8/§9.3, README table | Restore steps match what the drill does |
| — | Open the PR: links M3 + this plan, drill summary, the "never run against prod" statement | CI green on all 4 jobs |

## 8. launchd template and docs content

**Plist `com.chalkthat.nba.backup`:** `ProgramArguments` = `/bin/zsh -l /Users/jayprox_pro/Documents/Projects/git/ai-application-nba/scripts/backup-db.sh`, the same absolute-path pattern as the weekly plist. `StartCalendarInterval` daily at **03:17** (a Mac asleep at that time runs the job on the next wake; a Mac that is off skips that day). `StandardOutPath`/`StandardErrorPath` = `~/Library/Logs/chalk-that-nba/backup.launchd.out/.err` written as absolute paths (launchd doesn't expand `~`). No `EnvironmentVariables` holding anything secret. Defaults cover everything.

**`ops/launchd/README.md` backup section must cover:**
- Install/unload commands, and test with `launchctl start com.chalkthat.nba.backup` only **after** the owner-approved manual first run (T6 in STATUS).
- PATH: launchd's PATH is minimal. `zsh -l` loads the login PATH (for `node` and `railway`), and the script uses absolute paths for libpq, so it doesn't depend on PATH.
- Railway session: the job uses the owner's `railway login` session and the repo directory's `railway link`. If the session expires, runs log `FAIL stage=preflight reason="railway CLI not logged in"` until the owner runs `railway login` again. Check `backup.log` weekly, or rely on the failure notification.
- macOS privacy: background access to `/Volumes/...` (Removable Volumes) and `~/Documents` is blocked without a prompt under launchd. Fix: Full Disk Access for `/bin/zsh` (already granted for the weekly job). If the log shows `EPERM`/"Operation not permitted" on the volume, that's the cause.
- Only one Mac should have it loaded (same as weekly).

**`docs/backup-restore.md` must cover:** what is backed up and where; the file format; retention; how to read the log; how to run it by hand. **Restore:** (a) list a dump: `pg_restore --list`; (b) restore into a **new** throwaway or local DB: `createdb` + `pg_restore --no-owner --no-acl -d ...`, with the password via `PGPASSWORD`, not on the command line; (c) production restore is a separate owner-approved operation. Preferred: restore into a new Railway Postgres service through its own `--tunnel-only` tunnel, verify, then repoint `DATABASE_URL`. Never `--clean` into the live DB without owner approval. Plus the one line: *"A Railway Pro plan upgrade adds native volume backups (daily/weekly/monthly) and point-in-time recovery; they are deleted with the volume, so this off-platform dump stays useful."* Also note that dumps contain `users` rows (bcrypt hashes, emails) and API-key data, so the drive is sensitive (§9 item 3).

## 9. For the owner (Coordinator relays; none blocks the PR)

1. **Install `brew install libpq`** on the Mac that runs the job (a machine tool, not a repo dependency). The Dev installs it on this Mac for T1.
2. **Railway service name:** the plan assumes `Postgres` (from `docs/architecture.md` §8). Confirm it in the dashboard before the first run, or set `BACKUP_PG_SERVICE`.
3. **Recommended:** make the `DB-Backups` APFS volume encrypted (Finder → right-click → Encrypt, or create it with `diskutil apfs addVolume ... -passprompt`). The dumps hold user emails and password hashes. Not required by the mission; the owner decides.
4. **First production run (STATUS T6, separate approval):** the owner runs `npm run db:backup` by hand with the drive mounted. If the tunnel format differs from `connect.rs`, the script fails closed with `stage=tunnel` and prints nothing secret; the Dev then adjusts the parser. After one good run, the owner does `pg_restore --list` on the file (optionally a restore into a local container per the doc), then installs the plist.

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Real `--tunnel-only` output differs from the source/fixture, or differs when stdout is not a TTY | Parser built from the v5.71.0 source; fails closed without echoing; T6 is the first real check. Pin the CLI version note in the doc; a CLI upgrade can change it |
| R2 | Railway SSH forwarding fails for the Postgres service (public reports of "unknown channel type") | Out of our control; logged as `stage=tunnel`. Fallback (owner decision): temporarily re-add a TCP proxy for a manual run |
| R3 | A wrong DB gets dumped (port collision, mis-parse) | Port-free check, local-host/port identity check, `teams` table check in validation |
| R4 | Secret leak via log, argv, env inheritance, error text | D-c/D-h; drill greps log, stdout, and `ps`; unit tests on `redact`/`buildPgEnv`; Sec review |
| R5 | Silent writes to the boot disk when the drive is missing | Mount-point check by device ID, not existence; drill detaches the image to test it |
| R6 | Expired Railway session → silent daily failures | `whoami` preflight, FAIL line, macOS notification |
| R7 | Rotation deletes something it shouldn't | Strict regex, deletes only after a new valid dump, decoy test in drill |
| R8 | libpq major lags the server after a Railway Postgres upgrade | Version check; `pg_dump` itself refuses a newer server; the failure is logged |
| R9 | Dumps hold sensitive data on a removable drive | Files `0600`, dir `0700`; encryption recommended (§9.3) |

## 11. Acceptance criteria (QA)

- **AC1** No credentials in the repo: `git grep -nIE 'postgres(ql)?://[^ <$]*:[^ <$@]*@'` on the PR branch shows only the drill's localhost URL templates, built from variables with no literal password. No `.env` changes.
- **AC2** `npm test` (root) passes, including the new `backup.test.mjs`. CI is green on all four jobs.
- **AC3** `npm run db:backup:drill` exits 0 and every check in §5 prints PASS (QA re-runs it locally).
- **AC4** Drive not mounted (default config, `/Volumes/DB-Backups` absent) → exit non-zero, a `FAIL stage=preflight` line with a UTC timestamp in `~/Library/Logs/chalk-that-nba/backup.log`, and no `railway` process started (drill §5.8 + manual run).
- **AC5** No path can write under `/Volumes/TM-Prism` (unit test + drill §5.8). A code read finds no write path that skips `assertSafeBackupDir`.
- **AC6** A successful run gives one file `chalk-that-nba_<UTC>.dump`, mode 0600, custom format (`pg_restore --list` succeeds), and no `.partial`.
- **AC7** Restore into a second throwaway container matches the source: equal row counts for every public table, an identical schema-only dump (minus `\restrict` lines), and `npm run db:test` passes on the restored DB.
- **AC8** Retention keeps exactly `BACKUP_KEEP` (default 14) newest own-pattern dumps, deletes only own-pattern dumps, and never rotates after a failed run.
- **AC9** The tunnel is killed on success, on every failure stage, on timeout, and on SIGTERM (no fake-tunnel PID alive after each drill case).
- **AC10** The password appears in no log line, no stdout/stderr, and no `ps` argv during the run (drill §5.5 and the wrong-password case).
- **AC11** The script does not read `.env` or import `scripts/lib/env.mjs`. `pg_dump` gets the allow-listed env only.
- **AC12** `ops/launchd/com.chalkthat.nba.backup.plist` passes `plutil -lint`, runs daily, uses absolute paths, has no secrets, and the README covers PATH, Railway login, Full Disk Access, and install/unload.
- **AC13** `docs/backup-restore.md` has restore steps matching the drill, the production-restore approval rule, and the Railway Pro native backups/PITR line. `docs/architecture.md` §8/§9.3 and the README table are updated.
- **AC14** Nothing was run against production: the PR description says so, and no new Railway resources, variables, or proxies exist (owner confirms).

## 12. Security review focus
Credential flow D-c (parse, env-only, no disk, no argv, buffer handling, error messages); `redact` coverage; process-group kill (no orphaned tunnel holding an open authenticated port); path guards and TOCTOU around `realpath`/rename; file and dir modes; the lock; the fake-railway seam can't be abused in production (it's just an executable path the owner controls); launchd plist; sensitivity of dump contents and drive encryption advice; `brew install libpq` as a new local tool.
