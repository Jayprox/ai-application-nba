# Weekly run on JD's Mac (launchd)

NBA.com blocks cloud IPs, so the weekly job runs from the Mac. Since M6 (`docs/plans/M6-highlightly-weekly.md`) it is Highlightly first, NBA.com best-effort. Since M5
(`docs/plans/M5-weekly-tunnel.md`) `scripts/weekly.sh` hands over to
`scripts/weekly.mjs`, which reaches the database through the Railway CLI tunnel
(local port 55434, set `WEEKLY_TUNNEL_PORT` to change) instead of
`DATABASE_PUBLIC_URL`. In order:

1. Production guard: `WEEKLY_CONFIRM_PROD=1` and `BACKUP_CONFIRM_PROD=1` are both needed.
2. Backup first (the run aborts if it fails): a validated backup under 24 h old is
   reused; if a backup is running (its lock is held) the weekly job waits up to
   10 minutes; otherwise it runs `scripts/backup-db.mjs`.
3. Open the tunnel, then `schedule` (one 15 s NBA.com probe, then the Highlightly schedule pass) -> `positions`
   (NBA.com) -> `backfill` (Highlightly box scores, then the NBA.com reconcile for `--season 2026-27`) -> `db:status`,
   stopping at the first failure, then close the tunnel (on every exit path, including failure and a signal).
4. The last log line is `OK`, `OK-DEGRADED` (exit 0; NBA.com was skipped, or the Highlightly 600-request cap or
   1,000-request reserve was reached: the line says `nba=down`, `skipped=...`, `stop=...`) or `FAIL stage=... reason="..."`
   (a Highlightly or database failure). The notification says "OK", "OK with warnings" or "FAILED".

Needs `npm --prefix worker ci` once (the Highlightly step runs from `worker/`). Optional variables (put them in the
plist only if you want them): `WEEKLY_NBA=0` (do not try NBA.com), `WEEKLY_HL_CAP`, `WEEKLY_HL_RESERVE`, `WEEKLY_HL_RPS`,
`WEEKLY_HL_DAYS_BACK`, `WEEKLY_HL_DAYS_AHEAD`, `WEEKLY_DRY_RUN=1`. **Do not set `WEEKLY_HL_FULL_SEASON=1` in the plist.**
It is a one-time sweep (about 505 requests on the first run) that only runs when more than 3,000 requests remain; first
check the Highlightly dashboard to see whether the 7,500 requests are per day or per month. Typical weekly use is about
80 requests (385 worst case). The plist is unchanged by M6.

Log: `logs/weekly.log` (+ a macOS notification). launchd's own output goes to
`~/Library/Logs/chalk-that-nba/weekly.launchd.{out,err}`.

Run it by hand any time: `WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1 npm run db:weekly`.
Without the flags it refuses before any Railway call. **Do the first run by hand (drive
mounted, `railway login` current), look at `logs/weekly.log`, and only then install the plist.**
If a run ends `FAIL stage=cleanup`, report it and do not retry.

As of 2026-10-15 it runs on the MacBook Pro (the plist path is `/Users/jayprox_pro/...`). Only one Mac should have it loaded; on the Air run the `unload` line below and delete its copy in `~/Library/LaunchAgents/`. If you move it again, change the path in the plist first.

## Install (once, after the first good manual run)

The plist sets both opt-in flags (not secrets) and holds no database URL.

```
cp ops/launchd/com.chalkthat.nba.weekly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chalkthat.nba.weekly.plist
```

Test it right away (runs now, same way launchd will on Mondays):

```
launchctl start com.chalkthat.nba.weekly
```

Then check `logs/weekly.log`. If it says `Operation not permitted`, macOS is
blocking background access to the Documents folder: System Settings →
Privacy & Security → Full Disk Access → add `/bin/zsh` (Cmd+Shift+G to type
the path), then run the test again.

## Change the day/time, or stop it

Edit the plist (Weekday 1 = Monday, Hour, Minute), then:

```
launchctl unload ~/Library/LaunchAgents/com.chalkthat.nba.weekly.plist
cp ops/launchd/com.chalkthat.nba.weekly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chalkthat.nba.weekly.plist
```

To stop: the `unload` line alone. If the Mac is asleep at the scheduled
time, launchd runs the job at the next wake; if it's off, that week is
skipped (run `npm run db:weekly` by hand).

## Weekly: things that make it fail

- **Railway session.** Not logged in: `FAIL stage=preflight reason="railway CLI not logged in"`. Run `railway login`.
- **Drive not mounted.** With no fresh backup to reuse, the backup step fails and the run aborts with
  `FAIL stage=backup reason="db:backup failed (exit 1)"` (see `backup.log` for the cause). Nothing is written to the database.
- **Port 55434 in use.** `FAIL stage=preflight reason="tunnel port 55434 is already in use"`. A leftover weekly tunnel is
  cleaned up automatically; anything else is left alone. Do not use 55432-55434 for manual tunnels.
  If `BACKUP_TUNNEL_PORT` or `WEEKLY_TUNNEL_PORT` is set in either plist, the two must differ and neither may be 55432 or 55433
  (the weekly job only checks this against its own environment).
- **NBA.com blocked** is not a failure any more: the run ends `OK-DEGRADED ... nba=down` and arenas, national TV, Cup stage,
  new games, standings rank and positions stay as they were until NBA.com answers again. Highlightly rejects the key:
  `FAIL stage=schedule reason="highlightly auth rejected (401)"`. Highlightly down: `... reason="highlightly unreachable (...)"`.
  `worker/node_modules` missing: `FAIL stage=preflight reason="worker dependencies missing (run: npm --prefix worker ci)"`.
- **Another backup is running** for more than 10 minutes: `FAIL stage=backup reason="backup still running after 600s"`.
- **Known noise at wake.** If the Mac wakes with both jobs due and the weekly job's backup takes the lock first, the daily
  backup logs `FAIL stage=preflight reason="another backup is running"` and notifies, even though a backup was taken.

---

# Daily Postgres backup (launchd)

`scripts/backup-db.sh` runs `scripts/backup-db.mjs` daily at 03:17: it dumps the
production Postgres through the Railway CLI SSH tunnel to the `DB-Backups`
drive and keeps the 14 newest dumps. How it works and how to restore:
`docs/backup-restore.md`. Log: `~/Library/Logs/chalk-that-nba/backup.log`.

Run by hand (production): `BACKUP_CONFIRM_PROD=1 npm run db:backup`. Without
`BACKUP_CONFIRM_PROD=1` the script refuses with
`FAIL stage=preflight reason="production run not confirmed (set BACKUP_CONFIRM_PROD=1)"`
before any Railway CLI call. The plist sets it, because the job is meant to hit
production. Do the first run by hand, with the drive mounted, before installing
the plist. Only one Mac should have it loaded.

## Install (once, after the first good manual run)

```
cp ops/launchd/com.chalkthat.nba.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chalkthat.nba.backup.plist
```

Test: `launchctl start com.chalkthat.nba.backup`, then read `backup.log`.
Stop: `launchctl unload ~/Library/LaunchAgents/com.chalkthat.nba.backup.plist`.

## Things that make it fail

- **PATH.** launchd's PATH is minimal. `zsh -l` loads the login PATH (for `node`
  and `railway`); the script uses absolute paths for libpq
  (`/opt/homebrew/opt/libpq/bin`, from `brew install libpq`).
- **Railway session.** The job uses your `railway login` session and the repo
  directory's `railway link`. If the session expires, runs log
  `FAIL stage=preflight reason="railway CLI not logged in"` and show a
  notification until you run `railway login` again. Check `backup.log` weekly.
- **macOS privacy.** Background access to `/Volumes/...` and `~/Documents` is
  blocked without a prompt. Full Disk Access for `/bin/zsh` (already granted for
  the weekly job) fixes it. `Operation not permitted` on the volume in the log
  means this.
- **Drive not mounted.** The run logs `FAIL stage=preflight` and stops before
  contacting Railway.
