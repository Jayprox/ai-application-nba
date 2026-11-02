# QA review: M3-backup (PR #4)

## 1. Scope
- Branch `feat/db-backup`, head `20b7b5983966d3cbef675b3f983e0034eefa56c7` (fix cycle 1: production opt-in guard). Working tree clean.
- Requirements: "Mission M3-backup" in `docs/STATUS.md`, the owner-added `BACKUP_CONFIRM_PROD=1` guard, acceptance criteria in `docs/plans/M3-backup.md` section 11.
- Safety: the real `railway` binary was never executed. All script runs used `BACKUP_RAILWAY_BIN=scripts/fixtures/fake-railway.sh` or a harmless PATH-shadowed `railway` stub that only echoes (used to test the guard). `/Volumes/DB-Backups` IS mounted on this Mac, so no bare or default-config run was made. No writes to it or to the TM-Prism volume. Test dumps went to my own temp disk image (detached, deleted with scratchpad).

## 2. Traceability

| AC | Tests | Result |
|---|---|---|
| AC1 no credentials | `git grep -nIE 'postgres(ql)?://[^ <$]*:[^ <$@]*@'`: hits only pre-existing CI localhost `postgres:postgres` URLs, plan text, and test/comment fixtures with fake values. No `.env` in the PR file list. | PASS |
| AC2 npm test + CI | `npm test`: 44/44 pass (includes backup.test.mjs). `gh pr checks 4`: backend, frontend, root, worker all pass (run 41476164011). | PASS |
| AC3 drill | `npm run db:backup:drill`: 51 PASS, 0 FAIL, exit 0, 27 s. Containers and disk image removed afterwards. | PASS |
| AC4 drive absent | Drill case (preflight FAIL, `fake.pid` never written) plus my manual run with `BACKUP_VOLUME=/nonexistent-vol` + fake: exit 1, log `2026-11-02T16:08:37Z FAIL stage=preflight reason="volume /nonexistent-vol is not mounted"`, fake never started. The default-path variant could not be run because the owner's drive is mounted. | PASS (equivalent config) |
| AC5 never write under TM-Prism | Drill case (`BACKUP_DIR=/Volumes/TM-Prism/...`) and my manual symlink `-> /Volumes/TM-Prism` case (`backup path resolves under the Time Machine volume`). Code read: `assertSafeBackupDir` is called in preflight before mkdir and again after; `runDump`/`commit`/`rotate` only use `cfg.realDir` derived from it. Note the check only prevented my symlink test from doing any I/O. | PASS |
| AC6 output file | Drill and my own run: `chalk-that-nba_20261102T160855Z.dump`, mode `-rw-------`, `pg_restore --list` OK, no `.partial`. | PASS |
| AC7 restore equality | Drill: 16 tables equal row counts, schema-only diff identical, `db:test` passes on restored DB. Independently I restored my own dump into a fresh `postgres:18`: pg_restore rc 0, `db:test` passes, data and `Luka Dončić` present. | PASS |
| AC8 retention | Drill KEEP=3 over 5 runs keeps newest 3, decoys (`notes.txt`, `chalk-that-nba_manual.dump`, `other_*.dump`) untouched, stale `.partial` removed; failures leave dumps unchanged (rotate happens only after commit). Unit tests cover `selectForDeletion`. Code read: rotate is after validate+commit only. | PASS |
| AC9 tunnel killed | Drill: fake pid dead after happy path, after every failure stage (preflight, tunnel x3, dump, validate), and SIGTERM during a lock-blocked dump (exit 143, pg_dump and tunnel dead). Timeout case covered by "silent tunnel 3s". `pgrep` after my runs found no stray fake/backup processes. | PASS |
| AC10 password never leaked | Drill secret scans over log, stdout/stderr of all cases, and 50 ms `ps` samples (sampler did capture pg_dump argv); both correct and wrong passwords absent. | PASS |
| AC11 no .env / allow-listed env | grep: no import of `env.mjs`, no `.env` read in backup files. `buildPgEnv` is an allow-list (PATH, HOME, LANG, PGPASSWORD, PGCONNECT_TIMEOUT, PGAPPNAME). pg_restore --list gets `buildPgEnv('')`. | PASS |
| AC12 launchd | `plutil -lint` OK; StartCalendarInterval daily 03:17; absolute paths; only secret-free `BACKUP_CONFIRM_PROD=1`; README covers PATH, login, Full Disk Access, install/unload. | PASS |
| AC13 docs | `docs/backup-restore.md` has restore steps, production-restore approval rule, Pro-plan native backup line; architecture and README updated (but see findings 2 and 3). | PASS with minor doc defects |
| AC14 nothing run against production | PR body discloses an incident: before the guard, one default-config run invoked the real `railway whoami` and `railway connect ... -e production`. No dump or DB connection, but the CLI may have contacted Railway and `ensure_ssh_key` may have registered an SSH key. I cannot verify the Railway side. The remaining criterion ("no new resources, owner confirms") is untestable by QA. | NOT VERIFIABLE by QA, owner action needed |
| Owner guard: bare run cannot reach Railway | Drill guard cases (stub named `railway` first on PATH): no flag refused, `BACKUP_CONFIRM_PROD=true` refused, `=1` lets the stub be called. My manual repeat with the stub and no flag: `FAIL stage=preflight reason="production run not confirmed (set BACKUP_CONFIRM_PROD=1)"`, exit 1, stub not invoked. Direct `prodGuard` matrix: unset/empty/exact `railway`/symlink to railway/relative `railway`/` 1` blocked; flag `1` allowed. Guard is the first thing in preflight (before drive, lock, whoami). | PASS (with finding 1) |

Restore procedure in `docs/backup-restore.md` followed as written: step (a) works; step (b) works after fixing the ordering problem in finding 2; createdb, pg_restore (rc 0), `db:test` with the documented `DATABASE_PUBLIC_URL`, all fine.

## 3. CI and automated results
- CI run 41476164011: 4/4 jobs green. CI does not run the drill (no hdiutil) so the drill result is local-only: 51/51 PASS by me.
- Root unit tests 44/44.

## 4. Findings

1. **Minor: guard is bypassable by case on APFS.** `prodGuard` compares `path.basename(bin) !== 'railway'` case-sensitively. On the default case-insensitive APFS, `BACKUP_RAILWAY_BIN=/path/Railway` resolves to the real binary but is classified as a test binary and skips the confirmation. Repro: stub at `<dir>/railway`; `node -e` call of `prodGuard({BACKUP_RAILWAY_BIN:'<dir>/Railway'})` returns null (allowed); `<dir>/Railway` executes the stub. Same for a wrapper script with another name, or `railway.exe`. Requires the user to set the variable deliberately, so it does not defeat the "bare npm run db:backup" requirement. Fix: compare lowercased names, or invert the rule so test mode requires an explicit opt-in (for example `BACKUP_TEST_MODE=1`) instead of a name heuristic.
2. **Minor: restore doc step (b) misleads when run top to bottom.** The line `docker run ... -e POSTGRES_PASSWORD ...   # export POSTGRES_PASSWORD first` puts the export instruction in a trailing comment. Running it as written (variable unset) creates a container that exits immediately ("superuser password is not specified") but still holds the name `restore-test` and prints a container ID, so the next attempt fails with a name conflict and `createdb` gets "connection refused". Fix: put `export POSTGRES_PASSWORD=...` as its own first line, and add a `pg_isready` wait before `createdb`, which is also needed because the server takes a few seconds after `docker run`.
3. **Minor: docs omit the flag in two places.** README table row says `npm run db:backup` for a daily backup, and `docs/architecture.md` says nothing about `BACKUP_CONFIRM_PROD`; a user following the README gets a refusal. Also `docs/architecture.md` states the drill is "46 PASS"; it is now 51. Fix: say `BACKUP_CONFIRM_PROD=1 npm run db:backup` in README, update the count (or drop it).
4. **Note: AC14 / incident follow-up for the owner.** Check Railway account settings for an unexpected SSH key and the project for no changed resources, per the PR's own disclosure. QA cannot check this.
5. **Note: first production run risks.** The service name `Postgres` is unconfirmed; the tunnel output format was taken from CLI source v5.71.0 and not executed. Both fail closed (stage=tunnel). The drill's tunnel is a fake, so the real CLI's behaviour is untested by design.
6. **Note: `/Volumes/DB-Backups` is mounted now.** Any default-config run today reaches the real drive and, with the flag, production. The drill and my tests avoided this.
7. **Note: the drill needs `docker`, `hdiutil`, libpq; it leaves nothing behind.** After my runs only the pre-existing `pg` container and `postgres:18`/`hello-world` images remain (the `postgres:18` image pre-existed or was pulled by the drill; I did not remove it).

## 5. Cleanup
Containers `qa-src`, `restore-test` removed; my disk image detached; fake processes none. No source edits, no commits. Only file written in the repo: this report.

VERDICT: READY WITH CONDITIONS

Every acceptance criterion QA can test passes with evidence: the root tests (44/44), CI (4/4), the drill (51/51, run by me), my own manual fake-tunnel runs, an independent restore into a fresh `postgres:18`, and the production guard, which refuses without `BACKUP_CONFIRM_PROD=1` before any CLI call. Conditions: (a) fix the three minor items before or soon after merge (case-insensitive guard check, restore doc ordering, README/architecture flag and count), none of which affects the safe default; and (b) the owner confirms Railway shows no side effects from the disclosed pre-guard incident (AC14) and approves the first production run separately (T6).

---

# Re-verification (cycle 2, 1f3a027)

## R1. Scope
Branch `feat/db-backup`, head `1f3a027e3da999da027f2d44b2799919186b3ff7`; diff reviewed `20b7b59..1f3a027` (8 files). CI run 41480681670 reported green by the coordinator (not re-queried). Safety rules kept: real `railway` never executed; no script run except with the repo fake as the binary (in the drill); no writes to `/Volumes/DB-Backups`; `/Volumes/TM-Prism` only `stat`ed (dev 16777240; DB-Backups is a different device, 16777241). No source edited.

## R2. Previous Minor findings

| # | Finding | Result | Evidence |
|---|---|---|---|
| 1 | Guard bypass by case / name heuristic | FIXED | Guard is now an allow-list: exempt only if `realpath(BACKUP_RAILWAY_BIN) == realpath(<repo>/scripts/fixtures/fake-railway.sh)`. `prodGuard` matrix (exempt = ALLOWED without flag): fake direct, fake relative path, symlink to fake: ALLOWED. `/x/Railway`, unset, copy of the fake, wrapper script that execs the fake, missing file, and the fake with a different `repoRoot`: all refused. `BACKUP_CONFIRM_PROD=true`: refused; `=1`: allowed. The drill's guard cases pass (59/59). |
| 2 | Restore doc step (b) ordering | FIXED | Ran step (b) copy-pasted (zsh, fresh shell) against a throwaway `postgres:18` with a `pg_dump -Fc` of a schema-applied DB: export, `docker run`, `pg_isready` wait, `createdb`, `pg_restore --no-owner --no-acl`, `db:test` all work first time: "ALL SCHEMA CONSTRAINT TESTS PASSED". `--rm` + `docker stop` leaves no container. Step (a) works (it now sets `PGBIN`/`DUMP`; note `<stamp>` is a placeholder the reader must replace, which the comment says). |
| 3 | README / architecture flag and drill count | FIXED | README row now `BACKUP_CONFIRM_PROD=1 npm run db:backup` with explanation; architecture describes the guard; architecture drill count says 59 and the drill reports exactly `59 passed, 0 failed`. |

## R3. New behaviours

- **TM device and firmlink deny.** `assertSafeBackupDir` rejects `/System/Volumes/Data/Volumes/TM-Prism/x`, an all-lowercase `/system/volumes/data/volumes/tm-prism`, `/Volumes/tm-prism/a` and `/Volumes/TM-Prism` (all "under the Time Machine volume"). `timeMachineDevices()` returns the TM device (stat of two mount points plus `tmutil destinationinfo`; no listing or I/O inside). Device deny tested with a stand-in: a directory on my scratch device with that device in `denyDevices` -> "backup path is on the Time Machine device"; with an unrelated device -> allowed. Drill TM case passes.
- **Orphan-tunnel reaper, positive.** Drill "SIGKILL of the script orphans the tunnel; next run reaps it": PGID recorded in `backup.lock/tunnel.pgid`, next run succeeds, log has `NOTE reaped an orphaned tunnel`, no password in output. All pass.
- **Orphan-tunnel reaper, negative (unrelated process group, pgid 1/0/garbage, live lock owner).** NOT run by me: my harness (attached disk image plus kill of a decoy `sleep`) was denied by the permission system, so I did not retry. Code read only: it returns false when the PID is not > 1, is our own PID, the group is dead, or the leader's `ps command=` lacks `railway`, `connect` and `--tunnel-only`; it is only reached when the lock owner PID is dead. Looks fail-safe, but untested by QA, see finding R4.2.
- **Fake change (no `exec`, trap TERM).** Tunnel is killed on every drill failure path (all "tunnel dead" checks pass), including SIGTERM during a dump.

## R4. Regression (plan section 11) and automated results
- Root `npm test`: 47/47 pass (was 44; +3 new backup unit tests).
- `npm run db:backup:drill`: rc 0, **59 passed, 0 failed**. Covers AC3 to AC10 (restore equality, retention, drive missing, TM-Prism refusal, tunnel killed on every failure, no password in log/stdout/ps) plus the guard cases. AC1, AC2, AC11, AC12, AC13 unchanged by the diff apart from docs (checked in the diff: no env.mjs or `.env` use, no credentials added). AC14 remains an owner action (see R5.1).
- Cleanup: no `restore-test`, `qa-src`, or drill containers left (`docker ps -a` shows only the pre-existing `pg`); images unchanged (`postgres:18`, `hello-world` pre-existing); the scratch dump lives in the scratchpad.

## R5. Findings
1. **Note (owner action, unchanged): AC14.** Verify in Railway that the pre-guard incident left no unexpected SSH key or changed resources, and approve the first production run separately.
2. **Note: reaper negative paths were not exercised by QA** (see R3). Suggest the owner or Lead consider a drill case where a decoy non-railway process group is named in `tunnel.pgid`; not blocking since the code gates on the dead lock PID and a `railway connect --tunnel-only` command-line match.
3. **Note: exemption is by file identity of the fake.** A user who edits `scripts/fixtures/fake-railway.sh` to exec the real CLI would bypass the flag. Acceptable (deliberate repo change), just documented here.
4. **Note: `/Volumes/DB-Backups` is mounted** on this Mac, so any default-config run with `BACKUP_CONFIRM_PROD=1` reaches the real drive and production; unchanged.

VERDICT: READY WITH CONDITIONS

All three Minor findings are fixed and verified (allow-list guard tested across eleven bypass shapes, restore step (b) copy-pasted and working on a fresh `postgres:18`, README/architecture corrected with a drill count that matches the actual 59). Root tests are 47/47 and the drill is 59/59 with no regressions against plan section 11; the TM device/firmlink deny and the positive orphaned-tunnel reaper behave as specified. Remaining conditions are non-code: the owner confirms the disclosed pre-guard incident left nothing on the Railway side (AC14) and approves the first production run separately; optionally add a negative-path reaper drill case.

---

# Re-verification (cycle 3, 81113b9)

## C1. Scope
Branch `feat/db-backup`, head `81113b965a90bc7f13b6ae6aac3c22975048fd87` (matches PR #4 head). Diff reviewed `1f3a027..81113b9` (5 files). CI run 41485969944 reported green by the coordinator (not re-queried). Safety rules kept: real `railway` never run; no script run outside the drill's verified fakes; no writes to `/Volumes/DB-Backups`; `/Volumes/TM-Prism` untouched; no source edited.

## C2. Lead items A, B, C

| Item | Check | Result |
|---|---|---|
| A. Hermetic drill | All launches go through `launch_node` / inline `( exec $LAUNCH $LE node ... ) &` using `env -i` with explicit HOME, PATH, TMPDIR, LANG. New case exports shadow `BACKUP_RAILWAY_BIN` plus `BACKUP_CONFIRM_PROD=1`, runs `guard_run --no-bin`, unsets. Drill output: "PASS ambient BACKUP_RAILWAY_BIN + BACKUP_CONFIRM_PROD=1 ... not inherited -> refused, shadow not invoked". | PASS |
| A. SIGTERM / SIGKILL cases | The background launches changed to `( exec ... ) &` so `$!` is node's pid. Drill: SIGTERM exit 143, tunnel/pg_dump dead, no `.partial`, lock released, logged; SIGKILL leaves the orphan, next run succeeds and logs the reap (reaper `/railway/i` still matches the resolved fixture). All PASS. | PASS |
| B. Relative `BACKUP_RAILWAY_BIN` rejected | `loadConfig` with `railway` and `./x.sh` both throw `BACKUP_RAILWAY_BIN must be an absolute path` (run by me). `main()` maps a loadConfig throw to `FAIL stage=preflight reason="bad configuration: ..."`. Unit test covers both shapes plus an absolute-path accept. | PASS |
| B. Spawn the approved file | `resolveRailway()` returns `fs.realpathSync(cfg.railwayBin)` (non-`.native`; equivalent for this purpose) for both `whoami` and `connect`; missing file -> `FAIL preflight "BACKUP_RAILWAY_BIN not found"`. Unset path unchanged. Doc line says "absolute path". | PASS |
| C. PR body | Describes the realpath allow-list, no `exec node` wording, has absolute-path rule and a cycle-3 note; counts 47 tests and 60 drill PASS, both match my runs. | PASS |

## C3. Automated results
- Root `npm test`: 47/47 pass, 0 fail.
- `npm run db:backup:drill`: rc 0, **60 passed, 0 failed** (the 51-case figure from earlier passes is superseded).
- Earlier plan section 11 criteria (AC3 to AC10 via the drill, guard cases, secret-leak scans, TM-Prism refusal, retention, tunnel killed on all failure paths): all still PASS in this run. AC1, AC2, AC11 to AC13 unaffected by the diff (no env.mjs/.env use, no credentials added). AC14 and the owner items (SSH keys clean, service name `Postgres`, `DB-Backups` encrypted) are closed per the owner.
- Cleanup: `docker ps -a` shows only the pre-existing `pg`; images only the pre-existing `postgres:18` and `hello-world`. Drill output is in the scratchpad.

## C4. Findings
1. **Minor (doc): drill count in `docs/ARCHITECTURE.md:770` says "59 PASS"; the drill now reports 60.** One-word fix; does not affect behaviour. Can be fixed at merge or as a follow-up.
2. **Note: PR body "Not done" still lists "Railway service name `Postgres` unconfirmed"**; the owner has since confirmed it. Cosmetic; update the line if the PR text is edited.
3. **Note (unchanged follow-ups, non-blocking):** reaper negative paths untested (no decoy drill case), `pg_restore --list` capture cap, `postgres:18` digest pin. T6 first production run still needs its own owner approval.

VERDICT: READY

All three cycle-3 items are verified by running behaviour: the drill is hermetic (the ambient-env case refuses and never invokes the shadow), the SIGTERM and SIGKILL/reaper cases still pass after the launch change, relative `BACKUP_RAILWAY_BIN` values are rejected with the fixed preflight message, and the script spawns the realpath the guard approved. Root tests are 47/47 and the drill is 60/60 with no regressions against the earlier section 11 criteria; the PR body matches the code and the counts. The only residual items are a one-word stale count in ARCHITECTURE.md and a cosmetic PR line, neither of which blocks merge. The first production run (T6) remains a separate owner approval.
