#!/bin/zsh
# End-to-end weekly drill (M5, docs/plans/M5-weekly-tunnel.md section 8.2).
# `npm run db:weekly:drill`. Local only: macOS (hdiutil), Docker, Homebrew libpq.
#
# Uses ONLY one throwaway postgres:18 container, a disk image as the "drive", and
# scripts/fixtures/fake-railway.sh as the tunnel (WEEKLY_RAILWAY_BIN and BACKUP_RAILWAY_BIN are always
# the verified fake, or a verified shadow that records calls). Never touches Railway or any real
# volume. WEEKLY_CONFIRM_PROD / BACKUP_CONFIRM_PROD are never set in this shell. Nothing is
# installed or loaded into launchd (the plist is only linted). Everything is removed on exit.
setopt pipefail nonomatch
cd "${0:A:h}/.." || exit 1
REPO=$PWD
PGBIN=${BACKUP_PG_BIN_DIR:-/opt/homebrew/opt/libpq/bin}
FAKE=$REPO/scripts/fixtures/fake-railway.sh
SUF=$(openssl rand -hex 3)
SRC=chalk-wdrill-src-$SUF
PW=$(openssl rand -hex 16)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/chalk-wdrill.XXXXXX") || exit 1
chmod 700 $WORK
mkdir -p $WORK/priv $WORK/vol $WORK/wstate
: > $WORK/empty.env                      # Highlightly step env file: empty, so drills never read the real .env
VOL=$WORK/vol
DIR=$VOL/db-backups
LOG=$WORK/backup.log
WLOG=$WORK/weekly.log
PASS=0; FAILN=0
SAMPLER=""; NCPID=""; SLEEPPID=""; WPID=""; BPID=""; LOCKPID=""

pass() { PASS=$((PASS+1)); print "PASS  $1"; }
fail() { FAILN=$((FAILN+1)); print "FAIL  $1"; }

cleanup() {
  trap - EXIT INT TERM
  local p f
  for p in $SAMPLER $NCPID $SLEEPPID $WPID $BPID $LOCKPID; do [[ -n $p ]] && kill $p 2>/dev/null; done
  # Only pids this drill started (its own pidfiles): fake tunnels and their ssh-like forwarders.
  for f in $WORK/*.pid(N); do kill $(cat $f) 2>/dev/null; done
  pkill -f "$REPO/scripts/fixtures/fake-weekly-step.mjs" 2>/dev/null
  hdiutil detach $VOL -force >/dev/null 2>&1
  docker rm -fv $SRC >/dev/null 2>&1
  rm -rf $WORK
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
[[ -x $PGBIN/pg_dump ]] || { echo "libpq not found at $PGBIN (brew install libpq)"; exit 1; }
[[ -x $FAKE ]] || { echo "fake railway missing"; exit 1; }

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
SP=$(free_port); BP=$(free_port); WP=$(free_port); P2=$(free_port)

print "== Throwaway server ($SRC :$SP) =="
print "POSTGRES_PASSWORD=$PW\nPOSTGRES_DB=backup_test" > $WORK/priv/env
docker run -d --name $SRC --env-file $WORK/priv/env -p 127.0.0.1:$SP:5432 postgres:18 >/dev/null || { echo "docker run failed"; exit 1; }
for i in {1..60}; do "$PGBIN/pg_isready" -h 127.0.0.1 -p $SP -d backup_test >/dev/null 2>&1 && break; sleep 1; done
sleep 2
psql_src() { PGPASSWORD=$PW "$PGBIN/psql" -h 127.0.0.1 -p $SP -U postgres -d backup_test -v ON_ERROR_STOP=1 -X -q "$@"; }

print "== Seed =="
DATABASE_PUBLIC_URL="postgres://postgres:$PW@127.0.0.1:$SP/backup_test" npm run --silent db:apply >$WORK/apply.out 2>&1 && pass "schema applied (db:apply + constraint tests)" || { fail "db:apply"; tail -5 $WORK/apply.out; exit 1; }
psql_src -f db/tests/backup_drill_seed.sql >/dev/null 2>$WORK/seed.err && pass "seed loaded" || { fail "seed load"; head -3 $WORK/seed.err; exit 1; }
psql_src -c 'CREATE TABLE weekly_drill_marks (id serial PRIMARY KEY, step text NOT NULL, args text NOT NULL, at timestamptz NOT NULL DEFAULT now())' && pass "weekly_drill_marks created" || { fail "marks table"; exit 1; }

print "== Fake drive (disk image) =="
hdiutil create -size 64m -fs APFS -volname WDRILL $WORK/drive.dmg >/dev/null 2>&1 \
  && hdiutil attach -nobrowse -mountpoint $VOL $WORK/drive.dmg >/dev/null 2>&1 && pass "disk image mounted" || { fail "disk image"; exit 1; }

# One env for both scripts. %p in the pidfiles becomes the tunnel port (weekly and backup keep separate files).
BENV=(BACKUP_VOLUME=$VOL BACKUP_DIR=$DIR BACKUP_LOG=$LOG BACKUP_RAILWAY_BIN=$FAKE BACKUP_TUNNEL_PORT=$BP BACKUP_NOTIFY=0
  WEEKLY_RAILWAY_BIN=$FAKE WEEKLY_TUNNEL_PORT=$WP WEEKLY_LOG=$WLOG WEEKLY_STATE_DIR=$WORK/wstate WEEKLY_NOTIFY=0 WEEKLY_STEP_FIXTURE=1 WEEKLY_HL_ENV_FILE=$WORK/empty.env
  FAKE_RAILWAY_PASSWORD=$PW FAKE_RAILWAY_USER=postgres FAKE_RAILWAY_DB=backup_test FAKE_RAILWAY_TARGET_PORT=$SP
  FAKE_RAILWAY_PIDFILE=$WORK/fake.%p.pid FAKE_RAILWAY_SSH_PIDFILE=$WORK/ssh.%p.pid)

# ---- Safety: the real railway CLI must be unreachable in EVERY case ----------
# build_env [--no-wbin] [--no-bbin] [--shadow-wbin] [--no-fixture] [VAR=val ...] fills LE (the complete env
# assignments for one launch) and aborts the whole drill unless every railway the run could reach is
# a verified fake (or, for --shadow-wbin only, the verified call-recording shadow), and a production
# flag is never combined with a PATH lookup.
SHADOW=$WORK/shadow; mkdir -p $SHADOW
printf '#!/bin/sh\n# chalk-drill-shadow\necho invoked >> %s/shadow.calls\nexit 1\n' $WORK > $SHADOW/railway
chmod +x $SHADOW/railway
abort_unsafe() { print "ABORT  unsafe drill configuration ($1); nothing was run"; exit 99; }
[[ ${FAKE:A} == ${REPO:A}/scripts/fixtures/fake-railway.sh ]] || abort_unsafe "fake path"
grep -q chalk-drill-shadow $SHADOW/railway && [[ -x $SHADOW/railway ]] || abort_unsafe "shadow not created"
[[ "$(PATH=$SHADOW:$PATH /usr/bin/which railway)" == $SHADOW/railway ]] || abort_unsafe "shadow does not win the PATH lookup"
[[ -z $WEEKLY_CONFIRM_PROD$BACKUP_CONFIRM_PROD ]] || abort_unsafe "production flag set in the caller's shell"
LE=()
build_env() {
  local nw=0 nb=0 sw=0 a wbin="" bbin="" wflag="" bflag=""
  local nf=0
  while [[ $1 == --* ]]; do case $1 in --no-wbin) nw=1;; --no-bbin) nb=1;; --shadow-wbin) sw=1;; --no-fixture) nf=1;; esac; shift; done
  LE=($BENV)
  (( nf )) && LE=(${LE:#WEEKLY_STEP_FIXTURE=*})              # M6 cases run the REAL sub-steps
  (( nw )) && LE=(${LE:#WEEKLY_RAILWAY_BIN=*})
  (( nb )) && LE=(${LE:#BACKUP_RAILWAY_BIN=*})
  LE+=("$@")
  for a in $LE; do case $a in
    WEEKLY_RAILWAY_BIN=*) wbin=${a#*=};; BACKUP_RAILWAY_BIN=*) bbin=${a#*=};;
    WEEKLY_CONFIRM_PROD=*) wflag=${a#*=};; BACKUP_CONFIRM_PROD=*) bflag=${a#*=};;
  esac; done
  if [[ -z $wbin || -z $bbin ]]; then
    [[ $wflag == 1 || $bflag == 1 ]] && abort_unsafe "production flag with a PATH-resolved railway"
    [[ "$(PATH=$SHADOW:$PATH /usr/bin/which railway)" == $SHADOW/railway ]] || abort_unsafe "shadow lost the PATH lookup"
    LE+=(PATH=$SHADOW:$PATH)
  fi
  if [[ -n $wbin ]]; then
    if (( sw )); then [[ ${wbin:A} == ${SHADOW:A}/railway ]] || abort_unsafe "shadow-wbin is not the shadow"
    else [[ -x $wbin && ${wbin:A} == ${FAKE:A} ]] || abort_unsafe "WEEKLY_RAILWAY_BIN is not the verified fake"; fi
  fi
  [[ -z $bbin ]] || { [[ -x $bbin && ${bbin:A} == ${FAKE:A} ]] || abort_unsafe "BACKUP_RAILWAY_BIN is not the verified fake"; }
}
LAUNCH=(env -i HOME=$HOME PATH=$PATH TMPDIR=${TMPDIR:-/tmp} LANG=${LANG:-en_US.UTF-8})
OUTN=0
# run_weekly [build_env args] -> RC, stdout/stderr in $WORK/out.N / err.N
run_weekly() { build_env "$@"; OUTN=$((OUTN+1)); rm -f $WORK/fake.*.pid $WORK/ssh.*.pid; WOFF=$(wsize); $LAUNCH $LE node scripts/weekly.mjs >$WORK/out.$OUTN 2>$WORK/err.$OUTN; RC=$?; }
run_backup() { build_env "$@"; OUTN=$((OUTN+1)); $LAUNCH $LE node scripts/backup-db.mjs >$WORK/out.$OUTN 2>$WORK/err.$OUTN; RC=$?; }
# Background launch: `( exec ... ) &` so $! is node's own pid and signals reach the script.
start_weekly() { build_env "$@"; OUTN=$((OUTN+1)); rm -f $WORK/fake.*.pid $WORK/ssh.*.pid; WOFF=$(wsize); ( exec $LAUNCH $LE node scripts/weekly.mjs ) >$WORK/out.$OUTN 2>$WORK/err.$OUTN & WPID=$!; }
start_backup() { build_env "$@"; ( exec $LAUNCH $LE node scripts/backup-db.mjs ) >$WORK/outb.$OUTN 2>$WORK/errb.$OUTN & BPID=$!; }
wsize() { [[ -f $WLOG ]] && stat -f %z $WLOG || print 0; }
wnew() { tail -c +$((WOFF+1)) $WLOG 2>/dev/null; }           # weekly log text written by the last run
wres() { wnew | grep -E 'Z (OK|OK-DEGRADED|FAIL) ' | tail -1; }   # its result line
blines() { [[ -f $LOG ]] && wc -l < $LOG | tr -d ' ' || print 0; }
dumps() { ls $DIR 2>/dev/null | grep -E '^chalk-that-nba_[0-9]{8}T[0-9]{6}Z\.dump$'; }
ndumps() { dumps | grep -c .; }
marks() { psql_src -Atc "select step || ':' || args from weekly_drill_marks order by id" | tr '\n' ' ' | sed 's/ $//'; }
nmarks() { psql_src -Atc "select count(*) from weekly_drill_marks"; }
clear_marks() { psql_src -c 'TRUNCATE weekly_drill_marks' >/dev/null; }
clear_backups() { rm -f $DIR/chalk-that-nba_*.dump $LOG; }
stamped() { node -e "import('./scripts/lib/backup.mjs').then(m=>console.log(m.dumpName(new Date(Date.now()-$1*3600e3))))"; }
pid_dead() { [[ ! -f $1 ]] || ! kill -0 $(cat $1) 2>/dev/null; }
alive() { [[ -n $1 ]] && kill -0 $1 2>/dev/null; }
port_free() { [[ -z "$(lsof -nP -iTCP:$1 -sTCP:LISTEN 2>/dev/null)" ]]; }
wlock_gone() { [[ ! -e $WORK/wstate/weekly.lock ]]; }
step_gone() { ! pgrep -f "$REPO/scripts/fixtures/fake-weekly-step.mjs" >/dev/null; }
secret_scan() { # name file... ; the password must be absent
  local name=$1; shift; local hit=0 f
  for f in "$@"; do [[ -f $f ]] && grep -qF -- "$PW" $f && hit=1; done
  [[ $hit -eq 0 ]] && pass "no password in $name" || fail "password FOUND in $name"
}
# Checks every weekly case shares: its tunnel and forwarder are dead, its port is free, its lock is released,
# no password in its log or output. $1 = label
common() {
  local ok=1
  pid_dead $WORK/fake.$WP.pid || { ok=0; print "  weekly tunnel process alive"; }
  pid_dead $WORK/ssh.$WP.pid || { ok=0; print "  weekly ssh-like forwarder alive"; }
  port_free $WP || { ok=0; print "  weekly port $WP held"; }
  wlock_gone || { ok=0; print "  weekly lock left behind"; }
  [[ $ok -eq 1 ]] && pass "$1: weekly tunnel and forwarder dead, port free, lock released" || fail "$1: cleanup incomplete"
  secret_scan "$1 output" $WLOG $LOG $WORK/out.$OUTN $WORK/err.$OUTN
}
# expect_wfail label stage reason-substring  (uses RC and the last run)
expect_wfail() {
  local lbl=$1 stg=$2 why=$3 line=$(wres) ok=1
  [[ $RC -ne 0 ]] || ok=0
  [[ $line == *"FAIL stage=$stg "* && $line == *$why* ]] || ok=0
  [[ $ok -eq 1 ]] && pass "$lbl -> exit $RC, FAIL stage=$stg" || fail "$lbl (rc=$RC line: $line)"
}
# Wait (max 40 s) for a command to succeed.
wait_for() { local i; for i in {1..200}; do eval "$1" && return 0; sleep 0.2; done; return 1; }
start_fx() { # tag port [env...] -> $WORK/<tag>.fake.pid / <tag>.ssh.pid (waits for the port); always the fake
  local tag=$1 port=$2; shift 2
  env -i HOME=$HOME PATH=$PATH FAKE_RAILWAY_PASSWORD=$PW FAKE_RAILWAY_TARGET_PORT=$SP \
    FAKE_RAILWAY_PIDFILE=$WORK/$tag.fake.pid FAKE_RAILWAY_SSH_PIDFILE=$WORK/$tag.ssh.pid "$@" \
    $FAKE connect Postgres --tunnel-only -P $port -e production >/dev/null 2>&1 &
  for i in {1..50}; do port_free $port || return 0; sleep 0.2; done
  return 1
}
ppid_of() { ps -o ppid= -p $1 2>/dev/null | tr -d ' '; }
mk_fresh_backup() { clear_backups; run_backup; [[ $RC -eq 0 && $(ndumps) -eq 1 ]] || { fail "could not take the setup backup (rc=$RC)"; tail -3 $LOG; }; }

print "== W1 Guard refusal (shadow railway on PATH, never called) =="
mk_fresh_backup
BL=$(blines); D0=$(ndumps)
for v in "" true 01; do
  rm -f $WORK/shadow.calls
  if [[ -z $v ]]; then run_weekly --no-wbin --no-bbin; else run_weekly --no-wbin --no-bbin WEEKLY_CONFIRM_PROD=$v; fi
  expect_wfail "WEEKLY_CONFIRM_PROD='${v:-unset}'" preflight "production run not confirmed"
  [[ ! -e $WORK/shadow.calls ]] && wlock_gone && [[ $(blines) == $BL && $(ndumps) == $D0 && $(nmarks) -eq 0 ]] \
    && pass "  shadow never called, no lock, backup log and dumps unchanged, 0 marks" || fail "  side effects after a refused run (shadow/lock/log/marks)"
done
rm -f $WORK/shadow.calls
run_weekly --shadow-wbin WEEKLY_RAILWAY_BIN=$SHADOW/railway WEEKLY_CONFIRM_PROD=1
expect_wfail "WEEKLY_CONFIRM_PROD=1 without BACKUP_CONFIRM_PROD (real-looking bin)" preflight "production run not confirmed"
[[ ! -e $WORK/shadow.calls ]] && pass "  shadow never called" || fail "  shadow was called"

print "== W2 Mixed mode: fake weekly with an unset (real) backup bin =="
rm -f $WORK/shadow.calls
run_weekly --no-bbin
expect_wfail "fake weekly + real backup" preflight "production run not confirmed"
[[ ! -e $WORK/shadow.calls && $(blines) == $BL && $(nmarks) -eq 0 ]] && pass "  nothing was invoked" || fail "  mixed run invoked something"

print "== W3 Port config =="
for p in 55432 55433 $BP; do
  run_weekly WEEKLY_TUNNEL_PORT=$p
  expect_wfail "WEEKLY_TUNNEL_PORT=$p" preflight "WEEKLY_TUNNEL_PORT must not be 55432, 55433 or the backup tunnel port"
  [[ $(blines) == $BL && ! -f $WORK/fake.$p.pid ]] && wlock_gone && pass "  refused before any lock, CLI call or backup" || fail "  something ran before the port check"
done

print "== W4 Port conflict =="
nc -l 127.0.0.1 $WP >/dev/null 2>&1 & NCPID=$!
sleep 0.5
run_weekly
expect_wfail "listener on the weekly port" preflight "tunnel port $WP is already in use"
alive $NCPID && pass "  unrelated listener NOT killed" || fail "  unrelated listener was killed"
[[ $(blines) == $BL && $(nmarks) -eq 0 ]] && wlock_gone && pass "  no backup ran, lock released, 0 marks" || fail "  work happened despite the port conflict"
kill $NCPID 2>/dev/null; NCPID=""; sleep 0.3

print "== W5 Happy path, no backup yet =="
clear_backups
# Sample only the drill's own process tree (this shell and its descendants), so an unrelated host process
# with a postgres:// URL in its argv can't fail the case.
( while :; do ps -axww -o pid=,ppid=,args= | awk -v root=$$ '{ pid[NR]=$1; par[$1]=$2; line[$1]=$0 } END { for (p in par) { q=p; while (q > 1) { if (q == root) { print line[p]; break } q=par[q] } } }' | sed -E 's/^ *[0-9]+ +[0-9]+ //' >> $WORK/ps.txt; sleep 0.05; done ) &
SAMPLER=$!
run_weekly
kill $SAMPLER 2>/dev/null; SAMPLER=""
[[ $RC -eq 0 ]] && pass "exit 0" || { fail "exit 0 (got $RC: $(wres))"; wnew | tail -5; }
[[ $(ndumps) -eq 1 && $(blines) -eq 1 && $(tail -1 $LOG) == *" OK "* ]] && pass "exactly one new dump and one backup OK line" || fail "backup artifacts (dumps=$(ndumps) log lines=$(blines))"
[[ "$(marks)" == "schedule:--season 2026-27 positions: backfill:--season 2026-27" ]] && pass "marks: schedule, positions, backfill in order with --season 2026-27" || fail "marks: $(marks)"
wnew | grep -q "^\[status\] 127.0.0.1:$WP" && pass "real db:status output is in the weekly log" || fail "no db:status output in the log"
[[ "$(wres)" == *" OK season=2026-27 backup=new:chalk-that-nba_"* ]] && pass "result line: OK season=2026-27 backup=new:<dump>" || fail "result line: $(wres)"
[[ "$(tail -1 $WLOG)" == "=== exit 0 ===" ]] && pass "log ends with === exit 0 ===" || fail "log tail: $(tail -1 $WLOG)"
head -1 $WLOG | grep -qE '^=== [0-9-]+ [0-9:]+ weekly run, season 2026-27 ===$' && pass "log header" || fail "log header: $(head -1 $WLOG)"
[[ $(stat -f %Lp $WLOG) == 600 ]] && pass "weekly log mode 0600" || fail "weekly log mode"
common "W5"
secret_scan "ps argv samples" $WORK/ps.txt
grep -q "postgres://" $WORK/ps.txt && fail "a postgres:// URL was seen in ps argv" || pass "no postgres:// URL in ps argv"

print "== W6 Fresh reuse =="
BL=$(blines); D0=$(ndumps); clear_marks
run_weekly
[[ $RC -eq 0 ]] && pass "exit 0" || fail "exit 0 (got $RC: $(wres))"
[[ $(ndumps) == $D0 && $(blines) == $BL ]] && pass "no new dump and no new backup log line" || fail "a backup ran again"
wnew | grep -q "NOTE using backup chalk-that-nba_" && pass "NOTE using backup" || fail "no 'using backup' note"
[[ "$(wres)" == *"backup=reused:"* && $(nmarks) -eq 3 ]] && pass "result backup=reused, 3 marks" || fail "reuse result: $(wres) marks=$(nmarks)"
common "W6"

print "== W7 Stale backup (25 h old, with an OK line) -> a new backup runs =="
clear_backups; clear_marks
OLD=$(stamped 25); touch $DIR/$OLD; print "data" > $DIR/$OLD
print "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK   file=$OLD size=1.0MB kept=1 deleted=0 duration=1s" > $LOG
run_weekly
[[ $RC -eq 0 && $(ndumps) -eq 2 && "$(wres)" == *"backup=new:"* ]] && pass "a new backup was taken (2 dumps now)" || fail "stale case: rc=$RC dumps=$(ndumps) $(wres)"
common "W7"

print "== W7b Recent dump without an OK line -> a new backup runs =="
clear_backups; clear_marks
REC=$(stamped 1); print "data" > $DIR/$REC
run_weekly
[[ $RC -eq 0 && $(ndumps) -eq 2 && "$(wres)" == *"backup=new:"* ]] && pass "a new backup was taken" || fail "no-OK-line case: rc=$RC dumps=$(ndumps) $(wres)"
common "W7b"

print "== W8 Backup failure aborts the run (drive detached) =="
clear_backups; clear_marks
hdiutil detach $VOL >/dev/null 2>&1
BL=$(blines)
run_weekly
expect_wfail "no fresh dump and no drive" backup "db:backup failed"
[[ ! -f $WORK/fake.$WP.pid && $(nmarks) -eq 0 ]] && pass "  weekly tunnel never started, 0 marks" || fail "  work happened after the backup failed"
common "W8"
hdiutil attach -nobrowse -mountpoint $VOL $WORK/drive.dmg >/dev/null 2>&1 && pass "drive re-attached" || { fail "re-attach"; exit 1; }
mk_fresh_backup

print "== W9-W12 Each step fails =="
for s in schedule positions backfill; do
  clear_marks
  run_weekly FAKE_STEP_FAIL=$s
  expect_wfail "FAKE_STEP_FAIL=$s" $s 'reason="exit 3"'
  case $s in
    schedule) exp="" ;; positions) exp="schedule:--season 2026-27" ;; backfill) exp="schedule:--season 2026-27 positions:" ;;
  esac
  [[ "$(marks)" == "$exp" ]] && pass "  later steps not run (marks: '${exp:-none}')" || fail "  marks after $s failed: '$(marks)'"
  wnew | grep -q '^\[status\]' && fail "  status ran after $s failed" || pass "  status did not run"
  common "W-$s"
done
clear_marks
psql_src -c 'ALTER TABLE ingestion_runs RENAME TO ingestion_runs_hidden' >/dev/null
run_weekly
psql_src -c 'ALTER TABLE ingestion_runs_hidden RENAME TO ingestion_runs' >/dev/null
expect_wfail "real db:status made to fail" status 'reason="exit 1"'
[[ $(nmarks) -eq 3 ]] && pass "  the 3 earlier steps ran" || fail "  marks: $(marks)"
common "W-status"

print "== W13 Step timeout =="
clear_marks
run_weekly FAKE_STEP_HANG=backfill WEEKLY_STEP_TIMEOUT_S=3
expect_wfail "hung backfill, 3 s limit" backfill "timed out after 3s"
step_gone && pass "  the step's process group is dead" || fail "  the hung step is still running"
wnew | grep -q '^\[status\]' && fail "  status ran" || pass "  status did not run"
common "W13"

print "== W14 Signals =="
for sg in INT TERM; do
  clear_marks
  start_weekly FAKE_STEP_HANG=backfill
  wait_for 'pgrep -f "fake-weekly-step.mjs backfill" >/dev/null' && pass "SIG$sg: backfill step is hanging" || fail "SIG$sg: step never started"
  kill -$sg $WPID; wait $WPID; RC=$?
  [[ $RC -eq $([[ $sg == INT ]] && print 130 || print 143) ]] && pass "SIG$sg -> exit $RC" || fail "SIG$sg -> exit $RC"
  step_gone && pass "  step dead" || fail "  step alive"
  [[ "$(wres)" == *"FAIL stage=backfill reason=\"interrupted by SIG$sg\""* ]] && pass "  logged: interrupted by SIG$sg" || fail "  log: $(wres)"
  common "W14-$sg"; WPID=""
done
clear_backups; clear_marks; BL=$(blines)
start_weekly FAKE_RAILWAY_MODE=silent BACKUP_TUNNEL_TIMEOUT_S=30
wait_for "[[ -f $WORK/fake.$BP.pid ]]" && pass "SIGTERM during backup: the backup's tunnel exists" || fail "backup tunnel never started"
[[ ! -f $WORK/fake.$WP.pid ]] && pass "  weekly's own tunnel does not exist yet" || fail "  weekly tunnel exists early"
kill -TERM $WPID; wait $WPID; RC=$?; WPID=""
[[ $RC -eq 143 ]] && pass "  weekly -> exit 143" || fail "  weekly -> exit $RC"
pid_dead $WORK/fake.$BP.pid && pid_dead $WORK/ssh.$BP.pid && port_free $BP && pass "  backup's fake tunnel dead, its port free" || fail "  backup tunnel left behind"
tail -1 $LOG | grep -q 'FAIL stage=tunnel.*interrupted by SIGTERM' && pass "  backup logged FAIL interrupted by SIGTERM (its own handler ran)" || fail "  backup log: $(tail -1 $LOG)"
[[ $(nmarks) -eq 0 ]] && wlock_gone && [[ ! -e $WORK/backup.lock ]] && pass "  0 marks, weekly lock and backup lock released" || fail "  state left behind"
secret_scan "W14 backup-child output" $WLOG $LOG $WORK/out.$OUTN $WORK/err.$OUTN

print "== W15 Crash recovery (SIGKILL mid-step) =="
mk_fresh_backup; clear_marks
start_weekly FAKE_STEP_HANG=backfill
wait_for 'pgrep -f "fake-weekly-step.mjs backfill" >/dev/null' || fail "step never started"
kill -KILL $WPID; wait $WPID 2>/dev/null; WPID=""
OLDF=$(cat $WORK/fake.$WP.pid 2>/dev/null); OLDS=$(cat $WORK/ssh.$WP.pid 2>/dev/null)
pkill -f "$REPO/scripts/fixtures/fake-weekly-step.mjs" 2>/dev/null
alive $OLDF && alive $OLDS && pass "SIGKILL: tunnel and forwarder are orphaned (expected)" || fail "SIGKILL: tunnel not orphaned"
[[ -s $WORK/wstate/weekly.lock/tunnel.json ]] && pass "tunnel record in the weekly lock dir" || fail "no tunnel.json"
grep -q "$PW" $WORK/wstate/weekly.lock/tunnel.json && fail "password in tunnel.json" || pass "no password in tunnel.json"
clear_marks
run_weekly
[[ $RC -eq 0 ]] && pass "next weekly run exits 0" || fail "next run rc=$RC $(wres)"
! alive $OLDF && ! alive $OLDS && pass "its stale tunnel and forwarder were reaped" || fail "stale tunnel survived"
wnew | grep -q "NOTE reaped an orphaned tunnel" && pass "reap noted" || fail "reap not noted"
common "W15"

print "== W16 Weekly never touches backup-port tunnels =="
mk_fresh_backup; clear_marks
start_fx m $BP && pass "fixture tunnel up on the backup port" || fail "fixture tunnel did not come up"
start_fx n $P2 && pass "second (live) tunnel up on another port" || fail "second fixture did not come up"
kill -KILL $(cat $WORK/m.fake.pid); sleep 0.3
alive $(cat $WORK/m.ssh.pid) && [[ $(ppid_of $(cat $WORK/m.ssh.pid)) == 1 ]] && pass "backup-port forwarder is orphaned (PPID 1)" || fail "forwarder not orphaned"
rm -f $WORK/fake.*.pid $WORK/ssh.*.pid
run_weekly
[[ $RC -eq 0 ]] && pass "weekly (fresh reuse) exits 0" || fail "weekly rc=$RC $(wres)"
alive $(cat $WORK/m.ssh.pid) && alive $(cat $WORK/n.fake.pid) && alive $(cat $WORK/n.ssh.pid) && pass "backup-port orphan and the live tunnel are still alive" || fail "weekly killed a tunnel that is not its own"
common "W16"
kill $(cat $WORK/m.ssh.pid) $(cat $WORK/n.ssh.pid) $(cat $WORK/n.fake.pid) 2>/dev/null; sleep 0.5

print "== W17 Backup never touches weekly-port tunnels =="
clear_marks
start_fx w $WP && pass "fixture tunnel up on the weekly port" || fail "fixture tunnel did not come up"
kill -KILL $(cat $WORK/w.fake.pid); sleep 0.3
alive $(cat $WORK/w.ssh.pid) && [[ $(ppid_of $(cat $WORK/w.ssh.pid)) == 1 ]] && pass "weekly-port forwarder is orphaned (PPID 1)" || fail "forwarder not orphaned"
run_backup
[[ $RC -eq 0 ]] && pass "db:backup exits 0" || fail "db:backup rc=$RC $(tail -1 $LOG)"
alive $(cat $WORK/w.ssh.pid) && pass "weekly-port forwarder untouched by the backup" || fail "backup killed the weekly-port forwarder"
kill $(cat $WORK/w.ssh.pid) 2>/dev/null; sleep 0.5
port_free $WP && pass "weekly port free again" || fail "weekly port still held"

print "== W18 Live concurrency: weekly mid-step while db:backup runs =="
mk_fresh_backup; clear_marks
start_weekly FAKE_STEP_SLOW=backfill:25
wait_for "[[ \$(nmarks) -ge 2 ]]" && pass "weekly is in its slow step (tunnel open)" || fail "weekly never reached backfill"
alive $(cat $WORK/ssh.$WP.pid 2>/dev/null) && pass "weekly's forwarder is up" || fail "weekly forwarder missing"
run_backup
BRC=$RC
[[ $BRC -eq 0 ]] && pass "db:backup (own tunnel) exits 0 meanwhile" || fail "db:backup rc=$BRC $(tail -1 $LOG)"
alive $(cat $WORK/ssh.$WP.pid 2>/dev/null) && pass "weekly's forwarder still alive right after the backup finished" || fail "the backup closed weekly's tunnel"
wait $WPID; RC=$?; WPID=""
[[ $RC -eq 0 ]] && pass "weekly exits 0" || fail "weekly rc=$RC $(wres)"
port_free $BP && pass "backup port free" || fail "backup port held"
common "W18"

print "== W19 Lock wait: a running backup finishes within the wait =="
clear_backups; clear_marks
mkdir -m 700 $WORK/backup.lock; sleep 300 & SLEEPPID=$!; print -n $SLEEPPID > $WORK/backup.lock/pid
start_weekly WEEKLY_BACKUP_WAIT_S=20
sleep 3
rm -rf $WORK/backup.lock; kill $SLEEPPID 2>/dev/null; SLEEPPID=""
wait $WPID; RC=$?; WPID=""
[[ $RC -eq 0 ]] && pass "exit 0 after the lock was released" || fail "rc=$RC $(wres)"
wnew | grep -q "NOTE waiting for a running backup" && pass "NOTE waiting for a running backup" || fail "no waiting note"
common "W19"

print "== W19b Both fire at wake: a real backup holds the lock, weekly waits and reuses its dump =="
clear_backups; clear_marks
( psql_src -c "BEGIN; LOCK TABLE teams IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8);" >/dev/null 2>&1 ) & LOCKPID=$!
sleep 1
start_backup
wait_for "[[ -d $WORK/backup.lock ]]" && pass "the backup holds its lock" || fail "backup lock never appeared"
start_weekly
wait $WPID; RC=$?; WPID=""
wait $BPID; BRC=$?; BPID=""
[[ $RC -eq 0 && $BRC -eq 0 ]] && pass "weekly and backup both exit 0" || fail "weekly=$RC backup=$BRC $(wres)"
[[ $(ndumps) -eq 1 && $(blines) -eq 1 ]] && pass "exactly one dump (weekly did not make a second)" || fail "dumps=$(ndumps) backup log lines=$(blines)"
wnew | grep -q "NOTE waiting for a running backup" && wnew | grep -q "NOTE using backup" && pass "weekly waited, then reused" || fail "wait/reuse notes missing"
[[ $(nmarks) -eq 3 ]] && pass "3 marks" || fail "marks: $(marks)"
kill $LOCKPID 2>/dev/null; LOCKPID=""
common "W19b"

print "== W20 Lock wait timeout =="
clear_backups; clear_marks
mkdir -m 700 $WORK/backup.lock; sleep 300 & SLEEPPID=$!; print -n $SLEEPPID > $WORK/backup.lock/pid
BL=$(blines)
run_weekly WEEKLY_BACKUP_WAIT_S=3
expect_wfail "held backup lock, 3 s wait" backup "backup still running after 3s"
[[ -d $WORK/backup.lock && "$(cat $WORK/backup.lock/pid)" == "$SLEEPPID" ]] && alive $SLEEPPID && pass "  the backup lock and its holder are untouched" || fail "  weekly disturbed the backup lock"
[[ ! -f $WORK/fake.$WP.pid && ! -f $WORK/fake.$BP.pid && $(nmarks) -eq 0 && $(blines) == $BL ]] && pass "  no tunnel, 0 marks, backup log unchanged" || fail "  work happened"
rm -rf $WORK/backup.lock; kill $SLEEPPID 2>/dev/null; SLEEPPID=""
common "W20"

print "== W21 Stale backup lock (dead pid): the backup cleans it up, weekly proceeds =="
clear_backups; clear_marks
sleep 0 & DEAD=$!; wait $DEAD
mkdir -m 700 $WORK/backup.lock; print -n $DEAD > $WORK/backup.lock/pid
run_weekly
[[ $RC -eq 0 && $(ndumps) -eq 1 ]] && pass "exit 0 with one new dump" || fail "rc=$RC $(wres)"
[[ ! -e $WORK/backup.lock ]] && pass "stale backup lock was removed by the backup" || fail "stale backup lock still present"
common "W21"

print "== W22 Redaction =="
mk_fresh_backup; clear_marks
run_weekly FAKE_STEP_PRINT_URL=1
[[ $RC -eq 0 ]] && pass "exit 0" || fail "rc=$RC $(wres)"
wnew | grep -q '\[redacted-url\]' && pass "the step's URL line is in the log, redacted" || fail "step output not seen in the log"
grep -q 'postgres://' $WLOG $WORK/out.$OUTN $WORK/err.$OUTN && fail "a postgres:// URL reached the log or stdout/stderr" || pass "no postgres:// URL in the log, stdout or stderr"
common "W22"

print "== W23 Test hook outside fake mode =="
rm -f $WORK/shadow.calls; clear_marks
run_weekly --shadow-wbin WEEKLY_RAILWAY_BIN=$SHADOW/railway WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1
expect_wfail "WEEKLY_STEP_FIXTURE=1 with a non-fake bin (the guard now refuses first)" preflight "BACKUP_RAILWAY_BIN must not be set for a production run"
[[ ! -e $WORK/shadow.calls && $(nmarks) -eq 0 ]] && wlock_gone && pass "  shadow never called, no lock, 0 marks" || fail "  something ran"

print "== W24 Plist =="
PL=ops/launchd/com.chalkthat.nba.weekly.plist
plutil -lint $PL >/dev/null && pass "plutil -lint passes" || fail "plutil -lint"
[[ "$(plutil -extract EnvironmentVariables.WEEKLY_CONFIRM_PROD raw -o - $PL 2>/dev/null)" == 1 && "$(plutil -extract EnvironmentVariables.BACKUP_CONFIRM_PROD raw -o - $PL 2>/dev/null)" == 1 ]] && pass "both opt-in flags are exactly 1" || fail "plist flags"
grep -q "DATABASE_PUBLIC_URL" $PL && fail "plist mentions DATABASE_PUBLIC_URL" || pass "plist holds no database URL"

print "== W25 Production flags with a fake BACKUP_RAILWAY_BIN =="
mk_fresh_backup; BL=$(blines); D0=$(ndumps)
rm -f $WORK/shadow.calls; clear_marks
run_weekly --shadow-wbin WEEKLY_RAILWAY_BIN=$SHADOW/railway WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1
expect_wfail "both flags + fake BACKUP_RAILWAY_BIN" preflight "BACKUP_RAILWAY_BIN must not be set for a production run"
[[ ! -e $WORK/shadow.calls && $(nmarks) -eq 0 ]] && wlock_gone && [[ $(blines) == $BL && $(ndumps) == $D0 ]] \
  && pass "  shadow never called, no lock, no new dump or backup log line, 0 marks" || fail "  something ran after the refusal"

# ============================== M6: Highlightly first, NBA.com best-effort ==============================
# These cases run the REAL sub-steps (load-schedule / load-positions / backfill / worker weekly-hl.js) against the
# throwaway database through the fake tunnel. Highlightly answers from fixtures (HIGHLIGHTLY_FIXTURES, no key, no
# network); NBA.com answers from synthetic fixtures (SEED_FIXTURES) or is switched off (WEEKLY_NBA=0).
# The fixtures are synthetic; nothing here contacts Highlightly or NBA.com.
print "== M6 setup: date-relative Highlightly fixtures and the weekly seed =="
FX=$WORK/m6fx; NBAFX=$REPO/scripts/fixtures/nba
FAKEKEY=$(openssl rand -hex 16)
DATES=$(node scripts/fixtures/make-weekly-drill-fixtures.mjs $FX $FAKEKEY) && pass "fixtures written ($DATES)" || { fail "fixture generator"; DATES="{}"; }
jget() { print -r -- "$DATES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' $1; }
G1_TIP=$(jget g1_tip); G1_LOCAL=$(jget g1_local); FIN_TIP=$(jget fin_tip); FIN_LOCAL=$(jget fin_local)
reset_m6() {
  psql_src -c "TRUNCATE games, players, ingestion_runs RESTART IDENTITY CASCADE; DELETE FROM entity_id_crosswalk WHERE entity_type IN ('game', 'player'); DELETE FROM entity_id_crosswalk WHERE entity_type = 'team' AND source IN ('highlightly', 'nba_stats')" >/dev/null
  psql_src -v g1_tip=$G1_TIP -v g1_local=$G1_LOCAL -v fin_tip=$FIN_TIP -v fin_local=$FIN_LOCAL -f db/tests/weekly_drill_seed.sql >/dev/null
}
G1=00000000-0000-4000-8000-0000000000c1; FIN=00000000-0000-4000-8000-0000000000c2
q1() { psql_src -Atc "$1"; }
g1tip() { q1 "select to_char(tipoff_utc at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') from games where id = '$G1'"; }
dur() { print -r -- "$(wres)" | sed -n 's/.* duration=\([0-9]*\)s$/\1/p'; }
reset_m6 && pass "seed loaded (30 teams, 1 scheduled game, 1 final game without a box score)" || fail "weekly seed"
mk_fresh_backup

print "== W26 NBA.com blocked (synthetic) + Highlightly fixtures -> OK-DEGRADED, exit 0 =="
reset_m6
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_ok SEED_FIXTURES=$NBAFX/synthetic_unreachable
line=$(wres)
[[ $RC -eq 0 ]] && pass "exit 0" || fail "exit $RC: $line"
[[ $line == *" OK-DEGRADED season=2026-27 backup=reused:"* && $line == *" nba=down "* && $line == *"skipped=nba:arena,nba:tv,nba:cup,nba:season_type,nba:new_games,nba:positions,nba:reconcile,nba:standings"* ]] \
  && pass "OK-DEGRADED with nba=down and the full skipped list" || fail "result line: $line"
[[ $line == *" hl_requests="* && $line != *" hl_requests=0 "* ]] && pass "Highlightly requests were made and counted" || fail "hl_requests: $line"
[[ $(dur) -lt 30 ]] && pass "whole run under 30 s (so the NBA.com wait was far below the 15 s probe limit)" || fail "duration $(dur)s"
[[ "$(g1tip)" == "${G1_TIP:0:13}:00" ]] && fail "tip-off was not moved (Highlightly authority)" || pass "tip-off moved to Highlightly's time while NBA.com was down: $(g1tip)"
[[ $(q1 "select count(*) from player_game_stats where game_id = '$FIN' and source = 'highlightly'") -gt 0 ]] && pass "box score caught up from Highlightly (source highlightly)" || fail "no box score rows"
[[ $(q1 "select count(*) from ingestion_runs where source = 'nba_stats' and status = 'success'") -eq 0 ]] && pass "no NBA.com success row (freshness is not faked)" || fail "an NBA.com run is marked success"
[[ $(q1 "select count(*) from ingestion_runs where source = 'highlightly' and status = 'success'") -eq 2 ]] && pass "two Highlightly run rows (schedule, backfill)" || fail "highlightly runs: $(q1 "select job_type || ':' || status from ingestion_runs where source = 'highlightly'")"
wnew | grep -q '^\[status\] .*' && wnew | grep -q 'weekly: ' && pass "db:status shows the weekly line" || fail "no weekly line in the status output"
common "W26"

print "== W27 Highlightly down (HTTP 500) -> FAIL stage=schedule, database unchanged =="
reset_m6
BEFORE=$(q1 "select md5(string_agg(g::text, '|' order by id)) from games g")
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_500 WEEKLY_NBA=0
expect_wfail "Highlightly 500" schedule 'highlightly unreachable (HTTP 500)'
[[ "$(q1 "select md5(string_agg(g::text, '|' order by id)) from games g")" == "$BEFORE" ]] && pass "  games unchanged" || fail "  games changed after a Highlightly failure"
[[ $(q1 "select count(*) from ingestion_runs where status = 'failed' and source = 'highlightly'") -eq 1 ]] && pass "  one failed Highlightly run row" || fail "  run rows: $(q1 "select job_type || ':' || status from ingestion_runs")"
wnew | grep -q '^\[status\]' && fail "  status ran after the failure" || pass "  status did not run"
common "W27"

print "== W28 Quota reserve reached (remaining 1002, reserve 1000) -> OK-DEGRADED stop=reserve, no partial game =="
reset_m6
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_reserve WEEKLY_NBA=0
line=$(wres)
[[ $RC -eq 0 && $line == *" OK-DEGRADED "* && $line == *"stop=reserve"* ]] && pass "exit 0, OK-DEGRADED, stop=reserve" || fail "rc=$RC $line"
[[ $line == *"hl_requests=2 "* ]] && pass "exactly 2 requests before the reserve" || fail "requests: $line"
[[ $(q1 "select count(*) from games g where box_score_checks > 0 and not exists (select 1 from player_game_stats s where s.game_id = g.id)") -eq 0 ]] && pass "no game marked loaded without its box score" || fail "partial game"
common "W28"

print "== W29 Request cap (WEEKLY_HL_CAP=3) -> stop=cap, nearest dates first =="
reset_m6
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_quota_ok WEEKLY_NBA=0 WEEKLY_HL_CAP=3
line=$(wres)
[[ $RC -eq 0 && $line == *" OK-DEGRADED "* && $line == *"stop=cap"* && $line == *"hl_requests=3 "* ]] && pass "exit 0, stop=cap, exactly 3 requests in the whole run" || fail "rc=$RC $line"
[[ "$(g1tip)" == "${G1_TIP:0:13}:00" ]] && fail "tomorrow's game (a nearest date) was not processed" || pass "tomorrow's game was processed (nearest dates first)"
[[ $(q1 "select count(*) from player_game_stats where game_id = '$FIN'") -eq 0 ]] && pass "the box-score step had no budget left and wrote nothing" || fail "box score rows exist"
common "W29"

print "== W30 Key redaction (fake HIGHLIGHTLY_API_KEY in the environment) =="
reset_m6
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_keyname WEEKLY_NBA=0 HIGHLIGHTLY_API_KEY=$FAKEKEY
[[ $RC -eq 0 ]] && pass "exit 0" || fail "rc=$RC $(wres)"
wnew | grep -q 'redacted' && pass "a vendor name equal to the key was masked in the log" || fail "no masked text in the log (the case did not exercise redaction)"
hit=0; for f in $WLOG $LOG $WORK/out.$OUTN $WORK/err.$OUTN; do [[ -f $f ]] && grep -qF -- "$FAKEKEY" $f && hit=1; done
[[ $hit -eq 0 ]] && pass "the key is absent from the weekly log, backup log, stdout and stderr" || fail "KEY FOUND in a log or output"
[[ $(q1 "select count(*) from ingestion_runs where details::text like '%$FAKEKEY%'") -eq 0 ]] && pass "the key is not in ingestion_runs.details" || fail "key in ingestion_runs"
common "W30"

print "== W31 NBA.com answers with no game logs (synthetic) -> Highlightly rows are not deleted =="
reset_m6
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_ok SEED_FIXTURES=$NBAFX/synthetic_zero_rows
line=$(wres)
[[ $RC -eq 0 && $line == *" OK-DEGRADED "* && $line == *"nba:reconcile"* ]] && pass "exit 0, OK-DEGRADED, reconcile reported as skipped" || fail "rc=$RC $line"
wnew | grep -q 'nba.com returned no game logs; reconcile skipped' && pass "log: nba.com returned no game logs; reconcile skipped" || fail "no skip message"
[[ $(q1 "select count(*) from player_game_stats where game_id = '$FIN' and source = 'highlightly'") -gt 0 ]] && pass "the Highlightly box-score rows are still there" || fail "highlightly rows were deleted"
[[ $(q1 "select count(*) from ingestion_runs where source = 'nba_stats' and status = 'success'") -eq 0 ]] && pass "no NBA.com success row" || fail "NBA.com run marked success"
common "W31"

print "== W32 Fixture guards =="
rm -f $WORK/shadow.calls; clear_marks
run_weekly --shadow-wbin --no-fixture WEEKLY_RAILWAY_BIN=$SHADOW/railway WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1 HIGHLIGHTLY_FIXTURES=$FX/hl_ok
expect_wfail "production-looking run with HIGHLIGHTLY_FIXTURES" preflight ""
[[ ! -e $WORK/shadow.calls ]] && wlock_gone && pass "  shadow never called, no lock" || fail "  something ran"
run_weekly --no-fixture WEEKLY_NBA=0
expect_wfail "fake run without HIGHLIGHTLY_FIXTURES" preflight "a fake run needs HIGHLIGHTLY_FIXTURES"
[[ ! -f $WORK/fake.$WP.pid ]] && wlock_gone && pass "  no tunnel, no lock" || fail "  tunnel started"
run_weekly --no-fixture HIGHLIGHTLY_FIXTURES=$FX/hl_ok
expect_wfail "fake run with Highlightly fixtures but NBA.com live" preflight "a fake run needs HIGHLIGHTLY_FIXTURES"
common "W32"

print "== Summary: $PASS passed, $FAILN failed =="
[[ $FAILN -eq 0 ]] && exit 0 || exit 1
