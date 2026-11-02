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

## How it runs

`BACKUP_CONFIRM_PROD=1 npm run db:backup` (or daily 03:17 via launchd, whose
plist sets the flag; `ops/launchd/README.md`):

0. **Production guard.** Using the real Railway CLI requires
   `BACKUP_CONFIRM_PROD=1` (exactly `1`). The only exemption is
   `BACKUP_RAILWAY_BIN` pointing at an executable not named `railway` (the
   drill's fake; symlinks are resolved). Otherwise the run stops with
   `FAIL stage=preflight reason="production run not confirmed (set BACKUP_CONFIRM_PROD=1)"`
   before any CLI call. A bare `npm run db:backup` therefore can't reach production.

1. Checks the drive is a real mount point and the path is safe. If not: `FAIL stage=preflight`, and Railway is never contacted.
2. Checks `pg_dump` is version 18+ (Homebrew libpq), the Railway CLI is logged in, and the local tunnel port (default 55432) is free.
3. Starts `railway connect Postgres --tunnel-only -P 55432 -e production`
   (no public TCP proxy is needed). It reads the credentials from the CLI's
   output **in memory**, checks the host is `127.0.0.1` and the port is the
   requested one, and runs `pg_dump` with the password only in that process's
   environment. Credentials never go to the log, console, a file, or argv.
4. Stops the tunnel, validates the dump (`pg_restore --list` works and contains
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
`BACKUP_PG_BIN_DIR`, `BACKUP_RAILWAY_BIN` (test seam; the drill points it at a
fake), `BACKUP_NOTIFY=0` (no macOS notification; the drill sets it), `BACKUP_CONFIRM_PROD=1` (required for real runs, see above).

### Reading the log

One line per run in `backup.log`:

```
2026-11-02T03:17:05Z OK   file=chalk-that-nba_20261102T031705Z.dump size=12.3MB kept=14 deleted=1 duration=42s
2026-11-03T03:17:02Z FAIL stage=preflight reason="volume /Volumes/DB-Backups is not mounted" duration=0s
```

Stages: `preflight | tunnel | dump | validate | rename | rotate`. A `rotate`
failure exits 2 and keeps the new dump. Railway output is never logged.

## Restore

Always restore into a **new** database first.

```
# (a) list what is in a dump
/opt/homebrew/opt/libpq/bin/pg_restore --list /Volumes/DB-Backups/db-backups/chalk-that-nba_<stamp>.dump | head

# (b) restore into a throwaway local server (password via env, not argv)
docker run -d --name restore-test -e POSTGRES_PASSWORD -p 127.0.0.1:55433:5432 postgres:18   # export POSTGRES_PASSWORD first
export PGPASSWORD="$POSTGRES_PASSWORD"
/opt/homebrew/opt/libpq/bin/createdb -h 127.0.0.1 -p 55433 -U postgres restored
/opt/homebrew/opt/libpq/bin/pg_restore --no-owner --no-acl -h 127.0.0.1 -p 55433 -U postgres -d restored <dump>
DATABASE_PUBLIC_URL=postgres://postgres:$PGPASSWORD@127.0.0.1:55433/restored npm run db:test   # constraints came back
docker rm -fv restore-test
```

`npm run db:backup:drill` does exactly this end to end against two throwaway
containers and a disk image, and compares per-table row counts and the
schema-only dump.

(c) **Production restore is a separate, owner-approved operation.** Preferred
path: restore into a new Railway Postgres service through its own
`--tunnel-only` tunnel, verify, then repoint `DATABASE_URL`. Never use
`--clean` into the live database without owner approval.

A Railway Pro plan upgrade adds native volume backups (daily/weekly/monthly) and point-in-time recovery; they are deleted with the volume, so this off-platform dump stays useful.

## Setup on a Mac

`brew install libpq` (keg-only; the script uses `/opt/homebrew/opt/libpq/bin`
directly), `railway login`, `railway link` in the repo, and a `DB-Backups`
APFS volume. Confirm the Railway service name is `Postgres` (else set
`BACKUP_PG_SERVICE`). The first production run is done by hand with owner
approval.
