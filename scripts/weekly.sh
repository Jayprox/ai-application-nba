#!/bin/zsh -l
# Weekly NBA.com run from JD's Mac (NBA.com blocks cloud IPs, so this can't
# live on Railway). `npm run db:weekly`, or automatically via launchd:
# ops/launchd/README.md.
#
# Since M5 the work is done by scripts/weekly.mjs (docs/plans/M5-weekly-tunnel.md):
#   guard (WEEKLY_CONFIRM_PROD=1 and BACKUP_CONFIRM_PROD=1) -> backup (reuse one < 24 h old,
#   wait up to 10 min for a running one) -> Railway CLI tunnel on port 55434 ->
#   db:schedule -> db:positions -> db:backfill -> db:status -> close the tunnel.
# `exec` so launchd's SIGTERM reaches node directly. Output is appended to logs/weekly.log
# by weekly.mjs; a macOS notification says how it went.
cd "${0:A:h}/.." || exit 1
mkdir -p logs
if ! command -v node >/dev/null 2>&1; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') FAIL stage=preflight reason=\"node not found on PATH\"" >> logs/weekly.log
  /usr/bin/osascript -e 'display notification "Weekly NBA.com run FAILED — see logs/weekly.log" with title "Chalk That Hardwood"' 2>/dev/null
  exit 1
fi
exec node scripts/weekly.mjs "$@"
