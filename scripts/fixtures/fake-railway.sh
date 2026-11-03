#!/bin/sh
# Fake `railway` CLI for the backup drill (scripts/backup-drill.sh). Test fixture only.
# Never talks to Railway. `connect` mimics `railway connect --tunnel-only`
# (v5.71.0 print_tunnel_info output, on stderr) and forwards the requested local
# port to a local throwaway Postgres (FAKE_RAILWAY_TARGET_PORT).
#
# Env: FAKE_RAILWAY_PASSWORD / _USER / _DB / _TARGET_PORT / _PIDFILE
#      FAKE_RAILWAY_SSH_PIDFILE (pid of the ssh-like forwarder); both may contain %p (the -P port)
#      FAKE_RAILWAY_MODE = silent | silent-ssh | wrong-host | exit   (default: normal)
#      FAKE_RAILWAY_SSH_LABEL_PORT: the -L port the forwarder's argv claims (drill negative case)
if [ "$1" = "whoami" ]; then echo "fake-user"; exit 0; fi
if [ "$1" != "connect" ]; then exit 2; fi
PORT=""
while [ $# -gt 0 ]; do [ "$1" = "-P" ] && PORT="$2"; shift; done
[ -n "$PORT" ] || exit 2
# `%p` in the pidfile paths is replaced by the -P port, so two tunnels (backup and weekly) can
# run at once with separate pidfiles. A path without `%p` behaves as before.
case "$PORT" in *[!0-9]*) exit 2 ;; esac
FAKE_RAILWAY_PIDFILE=$(printf '%s' "$FAKE_RAILWAY_PIDFILE" | sed "s/%p/$PORT/g")
FAKE_RAILWAY_SSH_PIDFILE=$(printf '%s' "$FAKE_RAILWAY_SSH_PIDFILE" | sed "s/%p/$PORT/g")
[ -n "$FAKE_RAILWAY_PIDFILE" ] && echo $$ > "$FAKE_RAILWAY_PIDFILE"
# The real CLI starts `ssh -N -L ...` as its child with process_group(0) (CLI v5.71.0
# native.rs) and only kills it on a graceful Ctrl+C. Model that: an ssh-like child
# of this sh, in its OWN session and group, that holds the port (this sh holds none).
# perl setsid + exec keeps the pid and lets argv0 be "ssh", as `ps` shows for the real one.
HERE=$(cd "$(dirname "$0")" && pwd)
start_ssh() {
  KEY="$(dirname "${FAKE_RAILWAY_SSH_PIDFILE:-/tmp/x}")/fake_key"
  LPORT="${FAKE_RAILWAY_SSH_LABEL_PORT:-$PORT}"
  FAKE_SSH_LISTEN_PORT="$PORT" /usr/bin/perl -e 'use POSIX qw(setsid); setsid(); exec { $ARGV[0] } @ARGV[1..$#ARGV]' \
    "$(command -v node)" ssh "$HERE/fake-ssh-forward.mjs" -i "$KEY" -N -o StrictHostKeyChecking=accept-new \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L "127.0.0.1:$LPORT:127.0.0.1:$FAKE_RAILWAY_TARGET_PORT" service:fake@ssh.railway.com </dev/null >/dev/null 2>&1 &
  [ -n "$FAKE_RAILWAY_SSH_PIDFILE" ] && echo $! > "$FAKE_RAILWAY_SSH_PIDFILE"
}
# Worst case for the caller: on TERM/INT/HUP this sh exits WITHOUT killing the ssh-like child.
trap 'exit 143' TERM INT HUP
case "$FAKE_RAILWAY_MODE" in
  exit) exit 1 ;;
  silent) exec sleep 600 ;;
  silent-ssh) start_ssh; sleep 600 & wait ;;
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
start_ssh
wait
