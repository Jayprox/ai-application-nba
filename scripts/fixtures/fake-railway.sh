#!/bin/sh
# Fake `railway` CLI for the backup drill (scripts/backup-drill.sh). Test fixture only.
# Never talks to Railway. `connect` mimics `railway connect --tunnel-only`
# (v5.71.0 print_tunnel_info output, on stderr) and forwards the requested local
# port to a local throwaway Postgres (FAKE_RAILWAY_TARGET_PORT).
#
# Env: FAKE_RAILWAY_PASSWORD / _USER / _DB / _TARGET_PORT / _PIDFILE
#      FAKE_RAILWAY_MODE = silent | wrong-host | exit   (default: normal)
if [ "$1" = "whoami" ]; then echo "fake-user"; exit 0; fi
if [ "$1" != "connect" ]; then exit 2; fi
PORT=""
while [ $# -gt 0 ]; do [ "$1" = "-P" ] && PORT="$2"; shift; done
[ -n "$PORT" ] || exit 2
[ -n "$FAKE_RAILWAY_PIDFILE" ] && echo $$ > "$FAKE_RAILWAY_PIDFILE"
case "$FAKE_RAILWAY_MODE" in
  exit) exit 1 ;;
  silent) exec sleep 600 ;;
esac
HOST=127.0.0.1
[ "$FAKE_RAILWAY_MODE" = "wrong-host" ] && HOST=db.example.invalid
USER_="${FAKE_RAILWAY_USER:-postgres}"
DB="${FAKE_RAILWAY_DB:-railway}"
{
  echo
  echo "PostgreSQL tunnel open — point an external client at:"
  echo
  echo "  Host:     $HOST"
  echo "  Port:     $PORT"
  echo "  User:     $USER_"
  echo "  Password: $FAKE_RAILWAY_PASSWORD"
  echo "  Database: $DB"
  echo
  echo "  URL:      postgres://$USER_:$FAKE_RAILWAY_PASSWORD@$HOST:$PORT/$DB"
  echo
  echo "Press Ctrl+C to close the tunnel."
  echo
} >&2
# Forward 127.0.0.1:PORT -> 127.0.0.1:TARGET (exec keeps this PID, so SIGTERM kills it).
exec node -e '
const net = require("net");
const [lp, tp] = process.argv.slice(1).map(Number);
net.createServer((c) => {
  const t = net.connect(tp, "127.0.0.1");
  c.pipe(t); t.pipe(c);
  c.on("error", () => t.destroy()); t.on("error", () => c.destroy());
}).listen(lp, "127.0.0.1");
' "$PORT" "$FAKE_RAILWAY_TARGET_PORT"
