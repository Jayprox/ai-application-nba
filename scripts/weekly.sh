#!/bin/zsh -l
# Weekly NBA.com run from JD's Mac (NBA.com blocks cloud IPs, so this can't
# live on Railway). `npm run db:weekly`, or automatically via launchd:
# ops/launchd/README.md.
#   1. db:schedule  — pick up NBA schedule changes (Cup knockouts, postponements, TV)
#      db:positions — listed position for anyone new (rankings group by G/F/C)
#   2. db:backfill  — NBA.com overwrites the week's live (Highlightly) rows and
#                     reports anything that differed; refreshes official standings
#   3. db:status    — one-screen health check
# Output is appended to logs/weekly.log; a macOS notification says how it went.
SEASON="${1:-2026-27}"
cd "${0:A:h}/.." || exit 1
mkdir -p logs
LOG=logs/weekly.log
{
  echo "=== $(date '+%Y-%m-%d %H:%M') weekly run, season $SEASON ==="
  npm run --silent db:schedule -- --season "$SEASON" &&
  npm run --silent db:positions &&
  npm run --silent db:backfill -- --season "$SEASON" &&
  npm run --silent db:status
} >> "$LOG" 2>&1
STATUS=$?
if [ $STATUS -eq 0 ]; then MSG="Weekly NBA.com run OK"; else MSG="Weekly NBA.com run FAILED — see logs/weekly.log"; fi
osascript -e "display notification \"$MSG\" with title \"Chalk That NBA\"" 2>/dev/null
echo "=== exit $STATUS ===" >> "$LOG"
exit $STATUS
