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
SAMPLER=""; NCPID=""; LOCKPID=""

pass() { PASS=$((PASS+1)); print "PASS  $1"; }
fail() { FAILN=$((FAILN+1)); print "FAIL  $1"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }

cleanup() {
  trap - EXIT INT TERM
  [[ -n $SAMPLER ]] && kill $SAMPLER 2>/dev/null
  [[ -n $NCPID ]] && kill $NCPID 2>/dev/null
  [[ -n $LOCKPID ]] && kill $LOCKPID 2>/dev/null
  if [[ -f $WORK/fake.pid ]]; then kill $(cat $WORK/fake.pid) 2>/dev/null; fi
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
  FAKE_RAILWAY_TARGET_PORT=$SP FAKE_RAILWAY_PIDFILE=$WORK/fake.pid)
run_backup() { env $BENV "$@" node scripts/backup-db.mjs; }
OUTN=0
run_case() { OUTN=$((OUTN+1)); rm -f $WORK/fake.pid; run_backup "$@" >$WORK/out.$OUTN 2>$WORK/err.$OUTN; RC=$?; }
last_log() { tail -1 $LOG 2>/dev/null; }
dumps() { ls $DIR 2>/dev/null | grep -E '^chalk-that-nba_[0-9]{8}T[0-9]{6}Z\.dump$'; }
fake_dead() { [[ ! -f $WORK/fake.pid ]] || ! kill -0 $(cat $WORK/fake.pid) 2>/dev/null; }
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
  no_partial || okc=0
  [[ $okc -eq 1 ]] && pass "$name -> exit $RC, FAIL stage=$stg, dumps unchanged, tunnel dead" || { fail "$name (rc=$RC log: $(last_log))"; }
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
kill $NCPID 2>/dev/null; NCPID=""
expect_fail "tunnel prints nothing (timeout 3s)" tunnel FAKE_RAILWAY_MODE=silent BACKUP_TUNNEL_TIMEOUT_S=3
expect_fail "tunnel URL points at non-local host" tunnel FAKE_RAILWAY_MODE=wrong-host
expect_fail "tunnel process exits at once" tunnel FAKE_RAILWAY_MODE=exit
expect_fail "wrong password" dump FAKE_RAILWAY_PASSWORD=$WRONG
expect_fail "database without teams table" validate FAKE_RAILWAY_DB=empty_test
secret_scan "all failure-case logs/output" $LOG $WORK/out.* $WORK/err.*

print "== Production guard (PATH-shadowed fake named railway; the real CLI is never reachable) =="
SHADOW=$WORK/shadow; mkdir -p $SHADOW
printf '#!/bin/sh\necho invoked >> %s/shadow.calls\nexit 1\n' $WORK > $SHADOW/railway; chmod +x $SHADOW/railway
guard_run() { rm -f $WORK/shadow.calls $WORK/fake.pid; OUTN=$((OUTN+1)); env ${BENV:#BACKUP_RAILWAY_BIN=*} PATH=$SHADOW:$PATH "$@" node scripts/backup-db.mjs >$WORK/out.$OUTN 2>$WORK/err.$OUTN; RC=$?; }
guard_run
[[ $RC -eq 1 && $(last_log) == *'FAIL stage=preflight reason="production run not confirmed (set BACKUP_CONFIRM_PROD=1)"'* ]] && pass "no flag, real-binary path -> refused" || fail "no flag refused (rc=$RC $(last_log))"
[[ ! -e $WORK/shadow.calls && ! -f $WORK/fake.pid ]] && pass "no flag: railway never invoked, tunnel never started" || fail "no flag: railway was invoked"
guard_run BACKUP_CONFIRM_PROD=true
[[ $RC -eq 1 && $(last_log) == *"production run not confirmed"* && ! -e $WORK/shadow.calls ]] && pass "BACKUP_CONFIRM_PROD=true (not 1) -> refused, railway not invoked" || fail "CONFIRM_PROD=true not refused"
guard_run BACKUP_CONFIRM_PROD=1
[[ -e $WORK/shadow.calls && $(last_log) == *"railway CLI not logged in"* ]] && pass "with flag the guard lets the (shadow) CLI be called" || fail "flag did not unlock: $(last_log)"
[[ "$(dumps)" == "$BEFORE" ]] && pass "guard cases: dumps unchanged" || fail "guard cases changed dumps"

print "== SIGTERM during dump =="
rm -f $WORK/fake.pid
( DBN=backup_test psql_src -c "BEGIN; LOCK TABLE teams IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);" >/dev/null 2>&1 ) & LOCKPID=$!
sleep 1.5
OUTN=$((OUTN+1))
env $BENV node scripts/backup-db.mjs >$WORK/out.$OUTN 2>$WORK/err.$OUTN & BPID=$!
for i in {1..100}; do pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && break; sleep 0.2; done
pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && pass "pg_dump is running (blocked on lock)" || fail "pg_dump never started"
kill -TERM $BPID
wait $BPID; RC=$?
[[ $RC -eq 143 ]] && pass "SIGTERM -> exit 143" || fail "SIGTERM -> exit $RC"
fake_dead && pass "SIGTERM: tunnel dead" || fail "SIGTERM: tunnel alive"
! pgrep -f "pg_dump -h 127.0.0.1 -p $TP" >/dev/null && pass "SIGTERM: pg_dump dead" || fail "SIGTERM: pg_dump alive"
no_partial && pass "SIGTERM: no .partial" || fail "SIGTERM: .partial left"
[[ "$(dumps)" == "$BEFORE" ]] && pass "SIGTERM: dumps unchanged" || fail "SIGTERM: dumps changed"
[[ $(last_log) == *"FAIL stage=dump"*"SIGTERM"* ]] && pass "SIGTERM logged" || fail "SIGTERM logged: $(last_log)"
[[ ! -e $HOME/Library/Logs/chalk-that-nba/backup.lock && ! -e $WORK/backup.lock ]] && pass "lock released" || fail "lock left behind"
kill $LOCKPID 2>/dev/null; LOCKPID=""
DBN=postgres psql_src -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(60)%' and pid <> pg_backend_pid()" >/dev/null 2>&1
secret_scan "SIGTERM-case output" $LOG $WORK/out.$OUTN $WORK/err.$OUTN
secret_scan "ps argv samples (final)" $WORK/ps.txt

print "== Summary: $PASS passed, $FAILN failed =="
[[ $FAILN -eq 0 ]] && exit 0 || exit 1
