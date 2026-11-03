# Postgres backups and restore

Added in M3 (`docs/plans/M3-backup.md`). Off-Railway `pg_dump` backups of the
production database, plus how to restore them.

## What is backed up, and where

- The whole production `railway` database (all tables, including `users` with
  bcrypt hashes and emails, `refresh_tokens` and `api_keys`). **The drive is
  therefore sensitive**; encrypting the APFS volume is recommended.
- Written to `/Volumes/DB-Backups/db-backups/chalk-that-nba_<YYYYMMDDTHHMMSSZ>.dump`
  (UTC), `pg_dump --format=custom --no-owner`, file mode 0600, directory 0700.
- Never written to `/Volumes/TM-Prism` (the Time Machine volume); the script
  refuses that path.
- Retention: the 14 newest `chalk-that-nba_*Z.dump` files (`BACKUP_KEEP`).
  Rotation runs only after a new dump was validated and renamed into place, and
  touches only files with that exact name pattern.

## The weekly job and backups

Since M5 the weekly job (`scripts/weekly.mjs`) takes a backup before it writes to
production. It reuses a validated dump under 24 h old (the dump exists under its final name
and `backup.log` has its `OK` line), waits up to 10 minutes if a backup is running (the lock is
held), and otherwise runs `scripts/backup-db.mjs` itself. If that fails the weekly run aborts
before opening its own tunnel. It uses a different tunnel port (55434) and lock (`weekly.lock`),
so neither job can reap the other's tunnel. A production weekly run refuses to start if
`BACKUP_RAILWAY_BIN` is set (to anything), so its backup always comes from the real CLI.

## How it runs

`BACKUP_CONFIRM_PROD=1 npm run db:backup` (or daily 03:17 via launchd, whose
plist sets the flag; `ops/launchd/README.md`):

0. **Production guard.** Anything but the repo's own test fake needs
   `BACKUP_CONFIRM_PROD=1` (exactly `1`). The only exemption is
   `BACKUP_RAILWAY_BIN` resolving (realpath) to `scripts/fixtures/fake-railway.sh`.
   Unset, a binary named `railway` or `Railway`, copies, hard links and wrapper
   scripts are all treated as the real CLI. Without the flag the run stops with
   `FAIL stage=preflight reason="production run not confirmed (set BACKUP_CONFIRM_PROD=1)"`
   before any CLI call, so a bare `npm run db:backup` can't reach production.
1. Checks the drive is a real mount point and the path is safe. If not: `FAIL stage=preflight`, and Railway is never contacted.
2. Checks `pg_dump` is version 18+ (Homebrew libpq), the Railway CLI is logged in, and the local tunnel port (default 55432) is free.
3. Starts `railway connect Postgres --tunnel-only -P 55432 -e production`
   (no public TCP proxy is needed). It reads the credentials from the CLI's
   output **in memory**, checks the host is `127.0.0.1` and the port is the
   requested one, and runs `pg_dump` with the password only in that process's
   environment. Credentials never go to the log, console, a file, or argv.
4. Stops the tunnel (railway and its ssh child), validates the dump (`pg_restore --list` works and contains
   `public.teams`), renames it into place, then rotates.

Tunnel output format (railway CLI v5.71.0, `src/commands/connect.rs`
`print_tunnel_info`; printed to **stderr**; a CLI upgrade can change it, in which
case the run fails closed with `stage=tunnel`):

```
PostgreSQL tunnel open — point an external client at:
  Host:     127.0.0.1
  Port:     <port>
  User:     <user>
  Password: <redacted>
  Database: <db>
  URL:      postgres://<user>:<redacted>@127.0.0.1:<port>/<db>
Press Ctrl+C to close the tunnel.
```

### Settings (env, all optional)

`BACKUP_VOLUME`, `BACKUP_DIR`, `BACKUP_KEEP` (14), `BACKUP_LOG`
(`~/Library/Logs/chalk-that-nba/backup.log`), `BACKUP_PG_SERVICE` (`Postgres`),
`BACKUP_RAILWAY_ENV` (`production`), `BACKUP_TUNNEL_PORT` (55432),
`BACKUP_TUNNEL_TIMEOUT_S` (60), `BACKUP_DUMP_TIMEOUT_S` (1800),
`BACKUP_PG_BIN_DIR`, `BACKUP_RAILWAY_BIN` (test seam; must be an absolute path, and the script
runs its realpath, the file the guard approved; the drill points it at a fake), `BACKUP_NOTIFY=0` (no macOS notification; the drill sets it), `BACKUP_CONFIRM_PROD=1` (required for real runs, see above).

### Reading the log

One line per run in `backup.log`:

```
2026-11-02T03:17:05Z OK   file=chalk-that-nba_20261102T031705Z.dump size=12.3MB kept=14 deleted=1 duration=42s
2026-11-03T03:17:02Z FAIL stage=preflight reason="volume /Volumes/DB-Backups is not mounted" duration=0s
```

Stages: `preflight | tunnel | dump | validate | rename | rotate | cleanup`. A `rotate`
or `cleanup` failure exits 2 and keeps the new dump. Railway output is never logged.

## Restore

Always restore into a **new** database first.

```
# (a) list what is in a dump
export PGBIN=/opt/homebrew/opt/libpq/bin
DUMP=/Volumes/DB-Backups/db-backups/chalk-that-nba_<stamp>.dump    # pick a real file
$PGBIN/pg_restore --list "$DUMP" | head
```

```
# (b) restore into a throwaway local server (password via env, never on a command line)
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export PGPASSWORD="$POSTGRES_PASSWORD"
docker run -d --rm --name restore-test -e POSTGRES_PASSWORD -p 127.0.0.1:55433:5432 postgres:18
until $PGBIN/pg_isready -q -h 127.0.0.1 -p 55433; do sleep 1; done; sleep 3   # first start restarts once
$PGBIN/createdb -h 127.0.0.1 -p 55433 -U postgres restored
$PGBIN/pg_restore --no-owner --no-acl -h 127.0.0.1 -p 55433 -U postgres -d restored "$DUMP"
# constraints came back (from the repo root):
DATABASE_PUBLIC_URL="postgres://postgres:$PGPASSWORD@127.0.0.1:55433/restored" npm run db:test
docker stop restore-test            # --rm removes the container
unset POSTGRES_PASSWORD PGPASSWORD
```

`npm run db:backup:drill` does exactly this end to end against two throwaway
containers and a disk image, and compares per-table row counts and the
schema-only dump.

(c) **Production restore is a separate, owner-approved operation.** Preferred
path: restore into a new Railway Postgres service through its own
`--tunnel-only` tunnel, verify, then repoint `DATABASE_URL`. Never use
`--clean` into the live database without owner approval.

A Railway Pro plan upgrade adds native volume backups (daily/weekly/monthly) and point-in-time recovery; they are deleted with the volume, so this off-platform dump stays useful.

## The ssh child, and if a run was killed hard (SIGKILL, power loss)

`railway connect --tunnel-only` (CLI v5.71.0) starts `ssh -N -L 127.0.0.1:55432:...`
as a child in its **own process group** and stops it only on a graceful Ctrl+C. So
killing railway's group is not enough: the ssh child would be left listening on
`127.0.0.1:55432` and the next run would fail with `tunnel port ... is already in use`
(the M4 bug). The script therefore finds the ssh child while railway is still its
parent, and on every exit path (success, any failure, timeout, SIGINT/SIGTERM/SIGHUP):
SIGTERMs the ssh child, SIGINTs railway (escalating to SIGTERM/SIGKILL), SIGKILLs a
surviving ssh, then checks that the port is free. If it is still held, the run
reports `FAIL stage=cleanup reason="tunnel port ... still in use after run"` (exit 2;
a good dump is still saved and rotated first) and sends a notification.

A SIGKILL can't be handled, so railway and ssh may both stay alive. The script records
their pids in `backup.lock/tunnel.json` (pids, port and binary path only) next to the
log. The next run reaps leftovers in two places, and signals a process only if every
check passes:

- Stale lock: kills railway's group only if the recorded pid still runs exactly
  `<railway> connect ... --tunnel-only -P <port>`; stops the recorded ssh pids (same
  start time) and railway's ssh descendants; logs `NOTE reaped an orphaned tunnel left by a crashed run`.
- Port busy at preflight (no lock needed, which is the situation after a clean run that
  leaked ssh): kills the listener on `127.0.0.1:<port>` only if it is yours, its argv is
  exactly the CLI's forward (`ssh ... -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<port>:127.0.0.1:<n> user@ssh.railway.com`),
  and its parent is gone (PPID 1). Logs `NOTE reaped an orphaned ssh tunnel on port <port>`.
  Anything else on the port (another database, a tunnel whose `railway` is still running)
  is never touched and the run fails with `tunnel port ... is already in use`.

Note: this also kills your own manual tunnel on 55432 if its `railway` is already gone.
Use another `-P` for manual TablePlus sessions.

To check or clean up by hand:

```
lsof -nP -iTCP:55432 -sTCP:LISTEN          # who holds the port (empty = free)
pgrep -fl 'ssh .*-L 127.0.0.1:55432'       # a leftover ssh child
pgrep -fl 'railway connect'                # a leftover railway
```

Kill by PID only what you are sure is ours. A future CLI version that changes the ssh
argv makes the matcher miss: nothing is killed wrongly, and the run reports
`stage=cleanup` or `already in use` (the unit tests pin the v5.71.0 argv).

## Setup on a Mac

`brew install libpq` (keg-only; the script uses `/opt/homebrew/opt/libpq/bin`
directly), `railway login`, `railway link` in the repo, and a `DB-Backups`
APFS volume. Confirm the Railway service name is `Postgres` (else set
`BACKUP_PG_SERVICE`). The first production run is done by hand with owner
approval.
