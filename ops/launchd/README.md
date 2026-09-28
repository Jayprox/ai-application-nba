# Weekly NBA.com run on JD's Mac (launchd)

NBA.com blocks cloud IPs, so the weekly reconcile runs from the Mac:
`scripts/weekly.sh` = `db:schedule` + `db:backfill -- --season 2026-27` +
`db:status`, logged to `logs/weekly.log`, with a macOS notification.

Run it by hand any time: `npm run db:weekly`

## Install (once)

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
