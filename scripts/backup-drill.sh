#!/bin/zsh
# End-to-end backup + restore drill (M3, docs/plans/M3-backup.md section 5).
# `npm run db:backup:drill`. Local only: macOS (hdiutil), Docker, Homebrew libpq.
#
# Uses ONLY throwaway postgres:18 containers, a disk image as the "drive", and
# scripts/fixtures/fake-railway.sh as the tunnel. Never touches Railway or any
# real volume. Everything is removed on exit.
setopt pipefail
cd "${0:A:h}/.." || exit 1
REPO=$PWD
PGBIN=${BACKUP_PG_BIN_DIR:-/opt/homebrew/opt/libpq/bin}
FAKE=$REPO/scripts/fixtures/fake-railway.sh
SUF=$(openssl rand -hex 3)
SRC=chalk-drill-src-$SUF
DST=chalk-drill-dst-$SUF
PW=$(openssl rand -hex 16)
WRONG=$(openssl rand -hex 16)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/chalk-drill.XXXXXX") || exit 1
chmod 700 $WORK
mkdir -p $WORK/priv $WORK/vol
VOL=$WORK/vol
DIR=$VOL/db-backups
LOG=$WORK/backup.log
PASS=0; FAILN=0
SAMPLER=""; NCPID=""; LOCKPID=""; DECOY=""

pass() { PASS=$((PASS+1)); print "PASS  $1"; }
fail() { FAILN=$((FAILN+1)); print "FAIL  $1"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }

cleanup() {
  trap - EXIT INT TERM
  [[ -n $SAMPLER ]] && kill $SAMPLER 2>/dev/null
  [[ -n $NCPID ]] && kill $NCPID 2>/dev/null
  [[ -n $LOCKPID ]] && kill $LOCKPID 2>/dev/null
  [[ -n $DECOY ]] && kill $DECOY 2>/dev/null
  # Only pids this drill started (its own pidfiles): the fake tunnels and their ssh-like forwarders.
  local f; for f in fake ssh m.fake m.ssh; do [[ -f $WORK/$f.pid ]] && kill $(cat $WORK/$f.pid) 2>/dev/null; done
  hdiutil detach $VOL -force >/dev/null 2>&1
  docker rm -fv $SRC $DST >/dev/null 2>&1
  rm -rf $WORK
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
[[ -x $PGBIN/pg_dump ]] || { echo "libpq not found at $PGBIN (brew install libpq)"; exit 1; }
[[ -x $FAKE ]] || { echo "fake railway missing"; exit 1; }

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
SP=$(free_port); DP=$(free_port); TP=$(free_port); P2=$(free_port)

print "== Throwaway servers ($SRC :$SP, $DST :$DP) =="
print "POSTGRES_PASSWORD=$PW\nPOSTGRES_DB=backup_test" > $WORK/priv/env
for pair in "$SRC $SP" "$DST $DP"; do
  set -- ${=pair}
  docker run -d --name $1 --env-file $WORK/priv/env -p 127.0.0.1:$2:5432 postgres:18 >/dev/null || { echo "docker run failed"; exit 1; }
done
wait_ready() { for i in {1..60}; do "$PGBIN/pg_isready" -h 127.0.0.1 -p $1 -d backup_test >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
wait_ready $SP && wait_ready $DP || { echo "servers did not start"; exit 1; }
sleep 2
psql_src() { PGPASSWORD=$PW "$PGBIN/psql" -h 127.0.0.1 -p $SP -U postgres -d ${DBN:-backup_test} -v ON_ERROR_STOP=1 -X -q "$@"; }
psql_dst() { PGPASSWORD=$PW "$PGBIN/psql" -h 127.0.0.1 -p $DP -U postgres -d backup_test -v ON_ERROR_STOP=1 -X -q "$@"; }

print "== Seed source =="
DATABASE_PUBLIC_URL="postgres://postgres:$PW@127.0.0.1:$SP/backup_test" npm run --silent db:apply >$WORK/apply.out 2>&1 && pass "schema applied to source (db:apply + constraint tests)" || { fail "db:apply on source"; tail -5 $WORK/apply.out; }
psql_src -f db/tests/backup_drill_seed.sql >/dev/null 2>$WORK/seed.err && pass "seed loaded" || { fail "seed load"; head -3 $WORK/seed.err; }
DBN=postgres psql_src -c 'CREATE DATABASE empty_test' >/dev/null 2>&1

print "== Fake drive (disk image) =="
hdiutil create -size 64m -fs APFS -volname DRILL $WORK/drive.dmg >/dev/null 2>&1 \
  && hdiutil attach -nobrowse -mountpoint $VOL $WORK/drive.dmg >/dev/null 2>&1 && pass "disk image mounted" || { fail "disk image"; exit 1; }

# Always the fake tunnel; the real railway binary can never be reached from here.
BENV=(BACKUP_VOLUME=$VOL BACKUP_DIR=$DIR BACKUP_LOG=$LOG BACKUP_RAILWAY_BIN=$FAKE BACKUP_TUNNEL_PORT=$TP
  BACKUP_NOTIFY=0 FAKE_RAILWAY_PASSWORD=$PW FAKE_RAILWAY_USER=postgres FAKE_RAILWAY_DB=backup_test
  FAKE_RAILWAY_TARGET_PORT=$SP FAKE_RAILWAY_PIDFILE=$WORK/fake.pid FAKE_RAILWAY_SSH_PIDFILE=$WORK/ssh.pid)

# ---- Safety: the real railway CLI must be unreachable in EVERY case ----------
# build_env [--no-bin] [VAR=val ...] fills LE (the complete env assignments for
# one script run) and aborts the whole drill unless the railway the run could
# reach is a verified fake and the production flag is never combined with a PATH
# lookup. Every launch of backup-db.mjs goes through it.
SHADOW=$WORK/shadow; mkdir -p $SHADOW
printf '#!/bin/sh\n# chalk-drill-shadow\necho invoked >> %s/shadow.calls\nexit 1\n' $WORK > $SHADOW/railway
chmod +x $SHADOW/railway
abort_unsafe() { print "ABORT  unsafe drill configuration ($1); nothing was run"; exit 99; }
[[ ${FAKE:A} == ${REPO:A}/scripts/fixtures/fake-railway.sh ]] || abort_unsafe "fake path"
grep -q chalk-drill-shadow $SHADOW/railway && [[ -x $SHADOW/railway ]] || abort_unsafe "shadow not created"
[[ "$(PATH=$SHADOW:$PATH /usr/bin/which railway)" == $SHADOW/railway ]] || abort_unsafe "shadow does not win the PATH lookup"
LE=()
build_env() {
  local nobin=0 a bin="" flag=""
  [[ $1 == --no-bin ]] && { nobin=1; shift; }
  LE=($BENV); (( nobin )) && LE=(${LE:#BACKUP_RAILWAY_BIN=*})
  LE+=("$@")
  for a in $LE; do case $a in BACKUP_RAILWAY_BIN=*) bin=${a#*=};; BACKUP_CONFIRM_PROD=*) flag=${a#*=};; esac; done
  if [[ -z $bin ]]; then
    [[ $flag == 1 ]] && abort_unsafe "production flag with a PATH-resolved railway"
    [[ "$(PATH=$SHADOW:$PATH /usr/bin/which railway)" == $SHADOW/railway ]] || abort_unsafe "shadow lost the PATH lookup"
    LE+=(PATH=$SHADOW:$PATH)
  else
    [[ -x $bin && ( ${bin:A} == ${FAKE:A} || ${bin:A} == ${SHADOW:A}/railway ) ]] || abort_unsafe "BACKUP_RAILWAY_BIN is not a verified fake"
  fi
}
# The only way the drill launches the script: a scrubbed env (no inherited BACKUP_*,
# PG*, DATABASE_*, RAILWAY_*), plus exactly the vetted assignments in LE.
LAUNCH=(env -i HOME=$HOME PATH=$PATH TMPDIR=${TMPDIR:-/tmp} LANG=${LANG:-en_US.UTF-8})
launch_node() { $LAUNCH $LE node scripts/backup-db.mjs; }
# Background launches are written inline as `( exec $LAUNCH $LE node ... ) & BPID=$!` so $! is
# node's own pid (a backgrounded function would add a subshell and signals would miss the script).
run_backup() { build_env "$@"; launch_node; }
OUTN=0
run_case() { OUTN=$((OUTN+1)); rm -f $WORK/fake.pid $WORK/ssh.pid; run_backup "$@" >$WORK/out.$OUTN 2>$WORK/err.$OUTN; RC=$?; }
last_log() { tail -1 $LOG 2>/dev/null; }
dumps() { ls $DIR 2>/dev/null | grep -E '^chalk-that-nba_[0-9]{8}T[0-9]{6}Z\.dump$'; }
fake_dead() { [[ ! -f $WORK/fake.pid ]] || ! kill -0 $(cat $WORK/fake.pid) 2>/dev/null; }
# The ssh-like forwarder (own session, holds the tunnel port) and the port itself (M4).
ssh_dead() { [[ ! -f $WORK/ssh.pid ]] || ! kill -0 $(cat $WORK/ssh.pid) 2>/dev/null; }
port_free() { [[ -z "$(lsof -nP -iTCP:$1 -sTCP:LISTEN 2>/dev/null)" ]]; }
alive() { [[ -n $1 ]] && kill -0 $1 2>/dev/null; }
no_partial() { [[ -z $(ls $DIR 2>/dev/null | grep '\.partial$' | grep -v '^chalk-that-nba_20200101') ]]; }

print "== Happy path =="
( while :; do ps -axww -o args= >> $WORK/ps.txt; sleep 0.05; done ) &
SAMPLER=$!
run_case
kill $SAMPLER 2>/dev/null; SAMPLER=""
[[ $RC -eq 0 ]] && pass "exit 0" || fail "exit 0 (got $RC)"
[[ $(dumps | wc -l) -eq 1 ]] && pass "exactly one dump" || fail "exactly one dump"
D1=$(dumps | head -1)
[[ $(stat -f %Lp $DIR/$D1) == 600 ]] && pass "dump mode 0600" || fail "dump mode 0600"
no_partial && pass "no .partial left" || fail "no .partial left"
[[ $(last_log) == *" OK "* ]] && pass "log line is OK" || fail "log line is OK"
fake_dead && pass "tunnel process dead" || fail "tunnel process dead"
ssh_dead && pass "ssh-like forwarder dead after a successful run" || fail "ssh-like forwarder still alive after a successful run"
port_free $TP && pass "tunnel port free after a successful run" || fail "tunnel port $TP still held after a successful run"
check "pg_restore --list reads the dump" "$PGBIN/pg_restore" --list $DIR/$D1
grep -q pg_dump $WORK/ps.txt && print "note  ps sampler saw pg_dump argv" || print "note  ps sampler did not catch pg_dump (too fast)"
secret_scan() { # name file... ; $PW and $WRONG must be absent
  local name=$1; shift; local hit=0 f
  for f in "$@"; do [[ -f $f ]] && { grep -qF -- "$PW" $f && hit=1; grep -qF -- "$WRONG" $f && hit=1; }; done
  [[ $hit -eq 0 ]] && pass "no password in $name" || fail "password FOUND in $name"
}
secret_scan "backup.log" $LOG
secret_scan "script stdout/stderr" $WORK/out.1 $WORK/err.1
secret_scan "ps argv samples" $WORK/ps.txt
extra=$(ls $DIR | grep -v -E '^chalk-that-nba_[0-9]{8}T[0-9]{6}Z\.dump$')
[[ -z $extra ]] && pass "no extra files in backup dir" || fail "extra files in backup dir"

print "== Restore into second server and compare =="
if PGPASSWORD=$PW "$PGBIN/pg_restore" --no-owner --no-acl -h 127.0.0.1 -p $DP -U postgres -d backup_test $DIR/$D1 >$WORK/restore.out 2>&1; then pass "pg_restore exit 0"; else fail "pg_restore exit 0"; head -5 $WORK/restore.out; fi
tables=(${(f)"$(psql_src -Atc "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")"})
print "tables: ${#tables}"
bad=0
for t in $tables; do
  a=$(psql_src -Atc "select count(*) from public.\"$t\""); b=$(psql_dst -Atc "select count(*) from public.\"$t\"")
  [[ "$a" == "$b" ]] || { bad=1; print "  mismatch $t src=$a dst=$b"; }
  print "  $t src=$a dst=$b"
done
[[ $bad -eq 0 && ${#tables} -gt 0 ]] && pass "row counts equal for all ${#tables} public tables" || fail "row counts equal"
for t in teams players games team_games player_game_stats users; do
  [[ $(psql_dst -Atc "select count(*) from public.$t") -gt 0 ]] || { bad=1; print "  $t empty on dst"; }
done
[[ $bad -eq 0 ]] && pass "seeded tables non-empty on restored DB" || fail "seeded tables non-empty"
[[ $(psql_dst -Atc "select full_name from players where id='00000000-0000-4000-8000-000000000001'") == "Luka Dončić" ]] && pass "non-ASCII name survived" || fail "non-ASCII name survived"
schema_of() { PGPASSWORD=$PW "$PGBIN/pg_dump" --schema-only --no-owner -h 127.0.0.1 -p $1 -U postgres -d backup_test | grep -v -E '^\\(un)?restrict' | grep -v -E '^--'; }
if diff <(schema_of $SP) <(schema_of $DP) >$WORK/schema.diff; then pass "schema-only dumps identical"; else fail "schema-only dumps identical"; head -10 $WORK/schema.diff; fi
if DATABASE_PUBLIC_URL="postgres://postgres:$PW@127.0.0.1:$DP/backup_test" npm run --silent db:test >$WORK/dbtest.out 2>&1; then pass "db:test passes on restored DB"; else fail "db:test passes on restored DB"; tail -5 $WORK/dbtest.out | sed "s/$PW/[pw]/g"; fi

print "== Rotation (BACKUP_KEEP=3) =="
touch $DIR/notes.txt $DIR/chalk-that-nba_manual.dump $DIR/other_20250101T000000Z.dump $DIR/chalk-that-nba_20200101T000000Z.dump.partial
ALL=($(dumps))
for i in 1 2 3 4; do sleep 1.2; run_case BACKUP_KEEP=3; [[ $RC -eq 0 ]] || fail "rotation run $i exit $RC"; ALL+=($(dumps)); done
ALL=(${(u)ALL}); ALL=(${(o)ALL})
expect=(${(Oa)ALL}); expect=(${expect[1,3]}); expect=(${(o)expect})
actual=($(dumps))
[[ "$actual" == "$expect" && ${#actual} -eq 3 ]] && pass "exactly the 3 newest dumps remain (${#ALL} made)" || fail "rotation kept wrong set: $actual"
ok=1; for d in notes.txt chalk-that-nba_manual.dump other_20250101T000000Z.dump; do [[ -e $DIR/$d ]] || ok=0; done
[[ $ok -eq 1 ]] && pass "decoys untouched" || fail "decoys untouched"
[[ ! -e $DIR/chalk-that-nba_20200101T000000Z.dump.partial ]] && pass "stale .partial removed" || fail "stale .partial removed"
[[ $(last_log) == *"kept=3 deleted=1"* ]] && pass "log reports kept=3 deleted=1" || fail "log reports kept: $(last_log)"

print "== Failure paths =="
BEFORE=$(dumps)
expect_fail() { # name stage [env assignments...]
  local name=$1 stg=$2; shift 2
  run_case "$@"
  local okc=1
  [[ $RC -ne 0 ]] || okc=0
  [[ $(last_log) == *"FAIL stage=$stg "* ]] || okc=0
  [[ -z $SKIPDUMPS && "$(dumps)" != "$BEFORE" ]] && okc=0
  fake_dead || okc=0
  ssh_dead || okc=0
  no_partial || okc=0
  [[ $okc -eq 1 ]] && pass "$name -> exit $RC, FAIL stage=$stg, dumps unchanged, tunnel and forwarder dead" || { fail "$name (rc=$RC log: $(last_log))"; }
}

hdiutil detach $VOL >/dev/null 2>&1
SKIPDUMPS=1 expect_fail "drive missing" preflight
[[ ! -f $WORK/fake.pid ]] && pass "drive missing: tunnel never started (no fake.pid)" || fail "drive missing: tunnel was started"
hdiutil attach -nobrowse -mountpoint $VOL $WORK/drive.dmg >/dev/null 2>&1 && pass "drive re-attached" || { fail "re-attach"; exit 1; }
[[ "$(dumps)" == "$BEFORE" ]] || fail "dumps survived detach/attach"

expect_fail "BACKUP_DIR under /Volumes/TM-Prism" preflight BACKUP_DIR=/Volumes/TM-Prism/db-backups
[[ ! -f $WORK/fake.pid ]] && pass "TM-Prism: tunnel never started" || fail "TM-Prism: tunnel started"
nc -l 127.0.0.1 $P2 >/dev/null 2>&1 & NCPID=$!
sleep 0.5
expect_fail "tunnel port already in use" preflight BACKUP_TUNNEL_PORT=$P2
alive $NCPID && pass "unrelated listener (nc) on the port was NOT killed" || fail "unrelated listener (nc) was killed"
kill $NCPID 2>/dev/null; NCPID=""
expect_fail "tunnel prints nothing (timeout 3s)" tunnel FAKE_RAILWAY_MODE=silent BACKUP_TUNNEL_TIMEOUT_S=3
expect_fail "ssh started but tunnel prints nothing (timeout 3s)" tunnel FAKE_RAILWAY_MODE=silent-ssh BACKUP_TUNNEL_TIMEOUT_S=3
[[ -s $WORK/ssh.pid ]] && port_free $TP && pass "silent-ssh: forwarder was started, port free afterwards" || fail "silent-ssh: forwarder not started or port still held"
expect_fail "tunnel URL points at non-local host" tunnel FAKE_RAILWAY_MODE=wrong-host
expect_fail "tunnel process exits at once" tunnel FAKE_RAILWAY_MODE=exit
expect_fail "wrong password" dump FAKE_RAILWAY_PASSWORD=$WRONG
expect_fail "database without teams table" validate FAKE_RAILWAY_DB=empty_test
secret_scan "all failure-case logs/output" $LOG $WORK/out.* $WORK/err.*

print "== Production guard (verified shadow named railway; the real CLI is never reachable) =="
guard_run() { local nb=(); [[ $1 == --no-bin ]] && { nb=(--no-bin); shift; }; rm -f $WORK/shadow.calls $WORK/fake.pid; OUTN=$((OUTN+1)); build_env $nb "$@"; launch_node >$WORK/out.$OUTN 2>$WORK/err.$OUTN; RC=$?; }
guard_run --no-bin
[[ $RC -eq 1 && $(last_log) == *'FAIL stage=preflight reason="production run not confirmed (set BACKUP_CONFIRM_PROD=1)"'* ]] && pass "no flag, real-binary path -> refused" || fail "no flag refused (rc=$RC $(last_log))"
[[ ! -e $WORK/shadow.calls && ! -f $WORK/fake.pid ]] && pass "no flag: railway never invoked, tunnel never started" || fail "no flag: railway was invoked"
guard_run --no-bin BACKUP_CONFIRM_PROD=true
[[ $RC -eq 1 && $(last_log) == *"production run not confirmed"* && ! -e $WORK/shadow.calls ]] && pass "BACKUP_CONFIRM_PROD=true (not 1) -> refused, railway not invoked" || fail "CONFIRM_PROD=true not refused"
# ambient BACKUP_* in the drill's own shell must not leak into a run (shadow only, never the real CLI)
export BACKUP_RAILWAY_BIN=$SHADOW/railway BACKUP_CONFIRM_PROD=1
guard_run --no-bin
unset BACKUP_RAILWAY_BIN BACKUP_CONFIRM_PROD
[[ $RC -eq 1 && $(last_log) == *"production run not confirmed"* && ! -e $WORK/shadow.calls ]] && pass "ambient BACKUP_RAILWAY_BIN + BACKUP_CONFIRM_PROD=1 in the caller's env are not inherited -> refused, shadow not invoked" || fail "ambient env leaked into a run (rc=$RC $(last_log))"
guard_run BACKUP_RAILWAY_BIN=$SHADOW/railway
[[ $RC -eq 1 && $(last_log) == *"production run not confirmed"* && ! -e $WORK/shadow.calls ]] && pass "binary named railway by absolute path, no flag -> refused" || fail "named-railway bin not refused"
guard_run BACKUP_RAILWAY_BIN=$SHADOW/railway BACKUP_CONFIRM_PROD=1
[[ -e $WORK/shadow.calls && $(last_log) == *"railway CLI not logged in"* ]] && pass "with flag (absolute verified shadow) the guard lets the CLI be called" || fail "flag did not unlock: $(last_log)"
[[ "$(dumps)" == "$BEFORE" ]] && pass "guard cases: dumps unchanged" || fail "guard cases changed dumps"

print "== SIGTERM during dump =="
rm -f $WORK/fake.pid $WORK/ssh.pid
( DBN=backup_test psql_src -c "BEGIN; LOCK TABLE teams IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);" >/dev/null 2>&1 ) & LOCKPID=$!
sleep 1.5
OUTN=$((OUTN+1))
build_env; ( exec $LAUNCH $LE node scripts/backup-db.mjs ) >$WORK/out.$OUTN 2>$WORK/err.$OUTN & BPID=$!
for i in {1..100}; do pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && break; sleep 0.2; done
pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && pass "pg_dump is running (blocked on lock)" || fail "pg_dump never started"
kill -TERM $BPID
wait $BPID; RC=$?
[[ $RC -eq 143 ]] && pass "SIGTERM -> exit 143" || fail "SIGTERM -> exit $RC"
fake_dead && pass "SIGTERM: tunnel dead" || fail "SIGTERM: tunnel alive"
ssh_dead && pass "SIGTERM: ssh-like forwarder dead" || fail "SIGTERM: ssh-like forwarder alive"
port_free $TP && pass "SIGTERM: tunnel port free" || fail "SIGTERM: tunnel port still held"
! pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && pass "SIGTERM: pg_dump dead" || fail "SIGTERM: pg_dump alive"
no_partial && pass "SIGTERM: no .partial" || fail "SIGTERM: .partial left"
[[ "$(dumps)" == "$BEFORE" ]] && pass "SIGTERM: dumps unchanged" || fail "SIGTERM: dumps changed"
[[ $(last_log) == *"FAIL stage=dump"*"SIGTERM"* ]] && pass "SIGTERM logged" || fail "SIGTERM logged: $(last_log)"
[[ ! -e $HOME/Library/Logs/chalk-that-nba/backup.lock && ! -e $WORK/backup.lock ]] && pass "lock released" || fail "lock left behind"
kill $LOCKPID 2>/dev/null; LOCKPID=""
DBN=postgres psql_src -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(60)%' and pid <> pg_backend_pid()" >/dev/null 2>&1
secret_scan "SIGTERM-case output" $LOG $WORK/out.$OUTN $WORK/err.$OUTN

print "== SIGINT during dump (M4) =="
rm -f $WORK/fake.pid $WORK/ssh.pid
( DBN=backup_test psql_src -c "BEGIN; LOCK TABLE teams IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);" >/dev/null 2>&1 ) & LOCKPID=$!
sleep 1.5
OUTN=$((OUTN+1))
build_env; ( exec $LAUNCH $LE node scripts/backup-db.mjs ) >$WORK/out.$OUTN 2>$WORK/err.$OUTN & BPID=$!
for i in {1..100}; do pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && break; sleep 0.2; done
pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && pass "pg_dump is running (blocked on lock)" || fail "pg_dump never started"
kill -INT $BPID
wait $BPID; RC=$?
[[ $RC -eq 130 ]] && pass "SIGINT -> exit 130" || fail "SIGINT -> exit $RC"
fake_dead && pass "SIGINT: tunnel dead" || fail "SIGINT: tunnel alive"
ssh_dead && pass "SIGINT: ssh-like forwarder dead" || fail "SIGINT: ssh-like forwarder alive"
port_free $TP && pass "SIGINT: tunnel port free" || fail "SIGINT: tunnel port still held"
! pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && pass "SIGINT: pg_dump dead" || fail "SIGINT: pg_dump alive"
no_partial && pass "SIGINT: no .partial" || fail "SIGINT: .partial left"
[[ ! -e $WORK/backup.lock ]] && pass "SIGINT: lock released" || fail "SIGINT: lock left behind"
kill $LOCKPID 2>/dev/null; LOCKPID=""
DBN=postgres psql_src -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(60)%' and pid <> pg_backend_pid()" >/dev/null 2>&1
secret_scan "SIGINT-case output" $LOG $WORK/out.$OUTN $WORK/err.$OUTN

print "== SIGKILL of the script orphans the tunnel; the next run reaps it =="
rm -f $WORK/fake.pid $WORK/ssh.pid
( DBN=backup_test psql_src -c "BEGIN; LOCK TABLE teams IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);" >/dev/null 2>&1 ) & LOCKPID=$!
sleep 1.5
OUTN=$((OUTN+1))
build_env; ( exec $LAUNCH $LE node scripts/backup-db.mjs ) >$WORK/out.$OUTN 2>$WORK/err.$OUTN & BPID=$!
for i in {1..100}; do pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && break; sleep 0.2; done
kill -KILL $BPID; wait $BPID 2>/dev/null
OLDFAKE=$(cat $WORK/fake.pid 2>/dev/null); OLDSSH=$(cat $WORK/ssh.pid 2>/dev/null)
pkill -f "pg_dump -h 127.0.0.1 -p $TP" 2>/dev/null
[[ -n $OLDFAKE ]] && kill -0 $OLDFAKE 2>/dev/null && pass "SIGKILL: tunnel is orphaned (expected: the script cannot clean up)" || fail "SIGKILL: tunnel not alive after kill -9"
alive $OLDSSH && pass "SIGKILL: ssh-like forwarder is orphaned too" || fail "SIGKILL: forwarder not alive after kill -9"
[[ -s $WORK/backup.lock/tunnel.json ]] && pass "tunnel pids recorded in the lock dir" || fail "no tunnel.json in lock dir"
kill $LOCKPID 2>/dev/null; LOCKPID=""
DBN=postgres psql_src -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(60)%' and pid <> pg_backend_pid()" >/dev/null 2>&1
BEFORE2=$(dumps)
run_case
[[ $RC -eq 0 ]] && pass "next run succeeds (stale lock + orphan tunnel reaped)" || fail "next run rc=$RC $(last_log)"
! kill -0 $OLDFAKE 2>/dev/null && pass "orphaned tunnel was killed by the next run" || { fail "orphaned tunnel still alive"; kill $OLDFAKE 2>/dev/null; }
! alive $OLDSSH && pass "orphaned ssh-like forwarder was killed by the next run" || { fail "orphaned forwarder still alive"; kill $OLDSSH 2>/dev/null; }
port_free $TP && pass "tunnel port free after the reaping run" || fail "tunnel port still held after the reaping run"
grep -q "NOTE reaped an orphaned tunnel" $LOG && pass "reap noted in the log" || fail "reap not logged"
no_partial && pass "stale .partial gone" || fail "stale .partial left"
secret_scan "SIGKILL-case output" $LOG $WORK/out.$OUTN $WORK/err.$OUTN

# ---- M4: orphan reaper (no lock) and its negative paths. The fixtures here are started by
# the drill itself (never railway), and only pids the drill started are ever signalled.
start_fx() { # tag port [env assignments...] -> $WORK/<tag>.fake.pid / <tag>.ssh.pid (waits for the port)
  local tag=$1 port=$2; shift 2
  env -i HOME=$HOME PATH=$PATH FAKE_RAILWAY_PASSWORD=$PW FAKE_RAILWAY_TARGET_PORT=$SP \
    FAKE_RAILWAY_PIDFILE=$WORK/$tag.fake.pid FAKE_RAILWAY_SSH_PIDFILE=$WORK/$tag.ssh.pid "$@" \
    $FAKE connect Postgres --tunnel-only -P $port -e production >/dev/null 2>&1 &
  for i in {1..50}; do port_free $port || return 0; sleep 0.2; done
  return 1
}
ppid_of() { ps -o ppid= -p $1 2>/dev/null | tr -d ' '; }
mfake() { cat $WORK/m.fake.pid 2>/dev/null; }
mssh() { cat $WORK/m.ssh.pid 2>/dev/null; }

print "== Orphaned ssh forwarder, lock released (the owner's M4 bug) =="
rm -rf $WORK/backup.lock
start_fx m $TP && pass "fixture tunnel up on the backup port" || fail "fixture tunnel did not come up"
kill -KILL $(mfake)
sleep 0.3
alive $(mssh) && [[ $(ppid_of $(mssh)) == 1 ]] && pass "forwarder survives its railway (PPID 1), port held" || fail "forwarder not orphaned as expected"
[[ ! -e $WORK/backup.lock ]] && pass "no lock present (clean-release situation)" || fail "unexpected lock present"
run_case
[[ $RC -eq 0 ]] && pass "next run exits 0" || fail "next run rc=$RC $(last_log)"
! alive $(mssh) && pass "orphaned forwarder reaped" || { fail "orphaned forwarder still alive"; kill $(mssh); }
grep -q "NOTE reaped an orphaned ssh tunnel" $LOG && pass "reap noted in the log" || fail "reap not logged"
port_free $TP && pass "tunnel port free afterwards" || fail "tunnel port still held"
secret_scan "orphan-reaper output" $LOG $WORK/out.$OUTN $WORK/err.$OUTN

print "== Reaper negative: live parent (like a manual TablePlus tunnel) =="
start_fx m $P2 && pass "manual-style tunnel up on another port" || fail "manual tunnel did not come up"
BEFORE3=$(dumps)
run_case BACKUP_TUNNEL_PORT=$P2
[[ $RC -ne 0 && $(last_log) == *"FAIL stage=preflight reason=\"tunnel port $P2 is already in use\""* ]] && pass "refused: already in use" || fail "live-parent case rc=$RC $(last_log)"
alive $(mfake) && alive $(mssh) && pass "live-parent tunnel and forwarder NOT killed" || fail "live-parent tunnel was killed"
[[ "$(dumps)" == "$BEFORE3" ]] && pass "no dump made" || fail "dump made in refused case"
kill $(mssh) $(mfake) 2>/dev/null; sleep 0.3

print "== Reaper negative: argv does not name the port it listens on =="
start_fx m $P2 FAKE_RAILWAY_SSH_LABEL_PORT=40000 && pass "mismatched forwarder up" || fail "mismatched forwarder did not come up"
kill -KILL $(mfake); sleep 0.3
alive $(mssh) && [[ $(ppid_of $(mssh)) == 1 ]] && pass "mismatched forwarder is orphaned (PPID 1)" || fail "mismatched forwarder not orphaned"
run_case BACKUP_TUNNEL_PORT=$P2
[[ $RC -ne 0 && $(last_log) == *"FAIL stage=preflight reason=\"tunnel port $P2 is already in use\""* ]] && pass "refused: already in use" || fail "argv-mismatch case rc=$RC $(last_log)"
alive $(mssh) && pass "mismatched forwarder NOT killed" || fail "mismatched forwarder was killed"
kill $(mssh) 2>/dev/null; sleep 0.3

print "== Reaper negative: stale lock whose recorded pid is an unrelated live process in its own group =="
/usr/bin/perl -e 'use POSIX qw(setsid); setsid(); exec "sleep", "600"' & DECOY=$!
sleep 0.5
sleep 0 & DEADPID=$!; wait $DEADPID
mkdir -m 700 $WORK/backup.lock
print -n $DEADPID > $WORK/backup.lock/pid
print "{\"railwayPid\":$DECOY,\"port\":$TP,\"railwayBin\":\"$FAKE\",\"ssh\":[]}" > $WORK/backup.lock/tunnel.json
[[ $(ps -o pgid= -p $DECOY | tr -d ' ') == $DECOY ]] && pass "decoy is its own group leader" || fail "decoy setup"
run_case
[[ $RC -eq 0 ]] && pass "run proceeds past the decoy stale lock" || fail "decoy case rc=$RC $(last_log)"
alive $DECOY && pass "decoy process (not a railway tunnel) NOT killed" || fail "decoy was killed"
kill $DECOY 2>/dev/null; DECOY=""
secret_scan "negative-case output" $LOG $WORK/out.* $WORK/err.*

print "== Port still held after the run (matcher miss): FAIL stage=cleanup, exit 2 =="
# The run's own forwarder listens on $TP but its argv names another port, so the script cannot
# verify it is railway's ssh and must leave it alone (fail-safe), then report the held port.
LABELP=$(free_port)
BEFORE4=$(dumps)
run_case FAKE_RAILWAY_SSH_LABEL_PORT=$LABELP
[[ $RC -eq 2 ]] && pass "exit 2 when the tunnel port stays held" || fail "cleanup case rc=$RC $(last_log)"
[[ $(last_log) == *"FAIL stage=cleanup reason=\"tunnel port $TP still in use after run\""* ]] && pass "log: FAIL stage=cleanup, port still in use" || fail "cleanup log line: $(last_log)"
[[ $(dumps | wc -l) -eq $(( $(echo "$BEFORE4" | grep -c .) + 1 )) ]] && pass "dump was committed despite the cleanup failure" || fail "dump not committed in the cleanup case"
no_partial && pass "no .partial left" || fail "partial left in the cleanup case"
[[ ! -e $WORK/backup.lock ]] && pass "lock released" || fail "lock still present after the cleanup failure"
alive "$(cat $WORK/ssh.pid 2>/dev/null)" && pass "unverifiable forwarder NOT killed (fail-safe)" || fail "forwarder was killed although it could not be verified"
port_free $TP && fail "port should still be held by the mismatched forwarder" || pass "tunnel port still held, as reported"
secret_scan "cleanup-case output" $LOG $WORK/out.$OUTN $WORK/err.$OUTN
kill "$(cat $WORK/ssh.pid 2>/dev/null)" 2>/dev/null; sleep 0.3
port_free $TP && pass "tunnel port free after killing only the drill's own forwarder" || fail "tunnel port still held after the drill killed its forwarder"

secret_scan "ps argv samples (final)" $WORK/ps.txt

print "== Summary: $PASS passed, $FAILN failed =="
[[ $FAILN -eq 0 ]] && exit 0 || exit 1
