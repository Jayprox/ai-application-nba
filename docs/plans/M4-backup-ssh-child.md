# M4: Backup tunnel leaves the ssh child running (bug-fix triage)

- **Status:** Triage done, ready for Dev. No owner decision blocks the fix (see §7 for one FYI).
- **Requirement source:** "Mission M4" in `docs/STATUS.md` (owner, 2026-11-02, bug fix, no PA). No production runs by any role; the owner verifies with a real run after merge.
- **Branch:** `fix/backup-ssh-child` (push to `fix/*` is pre-approved). One PR. Commit this note with the change.
- **Reviews:** QA **and Security: yes**. The change adds code that signals processes the script did not spawn directly (the ssh grandchild and orphans from earlier runs), and it changes the process-matching rules of the reaper.
- **Path:** Lead triage -> Dev -> QA + Sec -> Lead review -> readiness report.

## 1. Root cause

**The real CLI puts ssh in its own process group and kills it only on a graceful Ctrl+C exit. Our script kills only railway's process group, and it uses SIGTERM.**

Evidence comes from the railwayapp/cli **v5.71.0** source (read only). It matches the local `railway --version`: `railway 5.71.0`.
- `src/commands/ssh/native.rs` `spawn_native_ssh_forward`: spawns `ssh [-p port] -i <key> -N -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:<local>:127.0.0.1:<remote> <target>@ssh.railway.com`. On unix it calls **`ssh_cmd.process_group(0)`**, so ssh gets its own PGID. Its PPID is still railway.
- The same file has `impl Drop for ForwardGuard { self.child.kill(); ... }`. ssh is killed **only when that guard is dropped**.
- `src/commands/connect.rs` (tunnel-only path) holds `_forward` and then awaits `tokio::signal::ctrl_c()`. Only **SIGINT** (after that handler is registered) returns normally and runs the drop. SIGTERM, SIGHUP and SIGKILL use the default action, so railway dies without running Drop. A SIGINT that lands before `ctrl_c()` is first polled (the CLI prints the URL just before that) also kills railway without the drop.

Where this breaks our code (`scripts/backup-db.mjs`):
- `killTunnel()` (L58-65) and the `exit` handler (L78-79) do `process.kill(-pid, SIGTERM/SIGKILL)` on **railway's** group. ssh is not in that group. railway dies at once from the SIGTERM, ssh is re-parented to launchd (PPID 1) and keeps listening on 127.0.0.1:55432. This happens on **every** exit path: success, every failure stage, timeout, SIGINT, SIGTERM and SIGHUP.
- The plan's assumption in M3 D-c(1) was wrong: "`detached: true` (own process group, so the SSH child is killed too)".
- `reapStaleTunnel()` (L133-144) cannot recover from this. (a) It runs only when a **stale lock** exists. After a successful run the lock was released cleanly, so the next run goes straight to `checkPortFree` (L217) and fails. (b) Even when it runs, it kills railway's group, which no longer contains ssh. (c) Its match `/railway/i`, `\bconnect\b` and `--tunnel-only` on the group leader is loose (F5(3)).
- The fixture hides the bug. `scripts/fixtures/fake-railway.sh` L38-51 runs the port-holding forwarder **in railway's group** ("A group kill takes the node child too"), so the drill never models a forwarder in a separate group.

This matches the production log in `~/Library/Logs/chalk-that-nba/backup.log`: `2026-11-02T22:59:25Z OK ...` was followed by `2026-11-03T03:41:28Z FAIL stage=preflight reason="tunnel port 55432 is already in use"`. Nothing is listening on 55432 now (`lsof -nP -iTCP:55432 -sTCP:LISTEN` is empty) and no ssh/railway process is alive, so the owner already cleared it.

## 2. Approach (Lead decisions, routine)

**A. Find the ssh child while railway is still alive, then kill ssh explicitly.** Do not rely on group membership or on the CLI's own cleanup.
- Take one snapshot with `/bin/ps -axww -o pid=,ppid=,pgid=,uid=,args=` (absolute path, `spawnSync`, timeout 5 s). Walk the **descendants** of the railway PID. Keep only those that pass `isRailwaySshForward(args, port)` (§2.D).
- Snapshot **(1)** after the tunnel is ready in `openTunnel` (the CLI prints the URL only after ssh is ready). Store the result in `tunnel.ssh = [{pid, pgid, lstart}]` and in the lock dir as `tunnel.json` (`{railwayPid, port, railwayBin, ssh:[{pid,lstart}]}`; replaces `tunnel.pgid`, mode 0600).
- Snapshot **(2)** again at the start of every kill, **before** railway is signalled. This catches ssh on the timeout path, where the URL was never printed but ssh may already be spawned inside `wait_for_forward_ready`. Once railway is dead the PPID link is gone, which is why the order matters.

**B. Kill order (`killTunnel`, also used by `cleanup` and `finishFail`):**
1. Snapshot (2), union with the recorded ssh PIDs. Re-verify each one: same `lstart` if recorded, argv still matches, same uid.
2. SIGTERM each verified ssh. Use its group (`-pgid`) when `pgid === pid` (true for the real CLI, and it also takes a `ProxyCommand` child), otherwise the single PID.
3. SIGINT railway's group, which is the CLI's own stop path. Wait up to 2 s, then SIGTERM, then after 5 s SIGKILL, as now.
4. Wait up to 5 s for each ssh to die, then SIGKILL.
5. **Post-check:** the port is free (bind test, a few retries over about 3 s). If it is still held, run the orphan reaper (§2.C) once. If it is still held after that, the run reports `FAIL stage=cleanup reason="tunnel port <port> still in use after run"`, exit 2, and sends a notification. This is the same convention as `rotate`: a good dump is still validated, committed and rotated before the line is written. This adds one log stage name, `cleanup`; it is routine.

The `process.on('exit')` last resort must also SIGKILL the recorded ssh PIDs, after a synchronous `spawnSync` ps re-verify (pid + lstart + argv).

**C. Orphan reaper, extended.** It runs in two places:
- In `takeLock` on a stale lock (as now). Read `tunnel.json` instead of `tunnel.pgid`. Kill the railway group only if the leader passes the **strict** railway matcher (§2.D, F5(3)) with the recorded `railwayBin` and port. Kill the recorded ssh PIDs only if they pass the ssh rules below.
- **New:** in `preflight` step 4, when the port is busy and before failing, list the listeners with `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` (timeout 5 s). Kill a listener **only if all** of these hold:
  - argv passes `isRailwaySshForward(args, port)`
  - uid equals `process.getuid()`
  - PPID is 1 (railway parent gone), **or** PPID is the railway PID recorded in our own stale `tunnel.json` that also passed the strict railway match
  - it is the process listening on `127.0.0.1:<port>` (from the lsof output)

  Use SIGTERM, then SIGKILL after 5 s. Then re-check the port. If that frees it, log `NOTE reaped an orphaned ssh tunnel on port <port>` (fixed text, no argv) and continue. Otherwise fail with the existing `tunnel port <port> is already in use`. A listener that fails any rule is never signalled, and the failure reason stays the same.

**D. Matchers (pure, in `scripts/lib/backup.mjs`).** Tokenize the `ps` args on whitespace. The key path has no spaces in practice. If it ever has one, the match simply fails, which is the safe direction.
- `isRailwaySshForward(args, port)`: `path.basename(tok[0]) === 'ssh'` (rejects `sshd`, `autossh`, `ssh-agent`, `grep`, `node`). It contains `-N`, and `-o` followed by `ExitOnForwardFailure=yes`. It has **exactly one** `-L`, whose next token matches `^127\.0\.0\.1:<port>:127\.0\.0\.1:\d{1,5}$` with the port compared as an exact number, never a substring. The last token matches `^[^@\s]+@ssh\.railway(-develop|-staging)?\.com$`. It has no `-R` and no `-D`. Extra tokens are allowed, because the fixture has one (the script path).
- `isRailwayTunnelCmd(args, port, railwayBin)` (F5(3), replaces the regexes at L139):
  - `tok[0]` is `railwayBin`, or `tok[0]` is a shell (`/bin/sh`, `sh`) and `tok[1]` is `railwayBin`, so the fixture still matches
  - next comes `connect`, then the tokens `--tunnel-only` and `-P <port>`, adjacent and exact
- `parsePsRows(text)`, `descendantsOf(rows, pid)`, `parseLsofPids(text)` (`-Fp` lines `p<pid>`).
- `reapDecision({row, myUid, port, listenerPids, recordedRailwayPid})` returns `{kill: bool, reason}`. All the safety rules in §2.C live in this one pure function so they can be unit-tested. The orchestrator only does I/O.

**E. Logging and secrets.** Never log ps/lsof output or argv. The ssh argv holds the key path, not a password, but the rule stays "fixed strings only". `tunnel.json` holds PIDs, the port and the binary path, nothing secret.

**F. Rejected alternatives:**
- SIGINT-only: it depends on CLI internals and on handler timing, and it does not help after SIGKILL.
- Killing anything that listens on the port: unsafe.
- `pkill -f ssh`: unsafe.
- Spawning railway in a way that pulls ssh into our group: we cannot control the CLI's `process_group(0)`.

## 3. Fixture and drill (must fail on current code, pass after the fix)

**`scripts/fixtures/fake-railway.sh`.** For `connect`, it starts an **ssh-like forwarder** that:
- is a child of the fake (PPID = fake PID) but runs in its **own session/process group**. Use a small node launcher with `spawn(process.execPath, [<fixtures>/fake-ssh-forward.mjs, ...], { argv0: 'ssh', detached: true, stdio: 'ignore' })`, so `ps` shows `ssh <script> -i <work>/fake_key -N -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:<P>:127.0.0.1:<T> service:fake@ssh.railway.com`. It opens no network connection; it only forwards 127.0.0.1:P to 127.0.0.1:T (the existing node forwarder logic moves here).
- **holds the port**. The fake railway itself holds no port, as with the real CLI.
- writes its PID to `FAKE_RAILWAY_SSH_PIDFILE`.

The fake's TERM/INT/HUP trap exits **without** killing the forwarder. This models the worst case (SIGTERM, or SIGINT before the CLI's handler), so the explicit kill path is what gets tested. `-P` parsing stays the same. Remove the stale "A group kill takes the node child too" comment.

New mode `FAKE_RAILWAY_MODE=silent-ssh`: start the forwarder, print nothing, sleep. This tests discovery at kill time (snapshot 2) on the timeout path.

`prodGuard` is unchanged: the guard still allow-lists only `fake-railway.sh` by realpath. The new `fake-ssh-forward.mjs` is not a railway binary and is never passed as `BACKUP_RAILWAY_BIN`.

**`scripts/backup-drill.sh`.** Add `ssh_dead()` (forwarder PID not alive) and `port_free()` (`lsof -nP -iTCP:$TP -sTCP:LISTEN` empty). Clean up the forwarder PID in `cleanup()`.

| Case | New assertions |
|---|---|
| Happy path | ssh-like forwarder dead; `$TP` free. **On current code:** FAIL, and the rotation runs then fail with "already in use", which proves the drill catches the bug |
| Every `expect_fail` case | `ssh_dead` added to `okc` (cases that start a tunnel) |
| `silent-ssh`, timeout 3 s | stage=tunnel, forwarder dead |
| SIGTERM during dump | forwarder dead, port free |
| **SIGINT** during dump (new) | exit 130, fake + forwarder dead, no `.partial`, lock released |
| **Owner's bug, lock released** (new) | Start the fixture directly in the background (`$FAKE connect Postgres --tunnel-only -P $TP -e production`; the fixture never talks to Railway), wait for the port, `kill -9` the fake only. Assert the forwarder is alive with PPID 1. Next `run_case` exits 0, the forwarder is dead, the log has `NOTE reaped an orphaned ssh tunnel` |
| SIGKILL of the script (existing) | Both fake and forwarder are orphaned; the next run reaps both |
| **Negative: unrelated listener** (F5(4)) | Existing `nc -l` case: also assert `nc` is **still alive** afterwards |
| **Negative: live parent** (F5(4)) | The fixture runs normally on `$P2` (parent alive, like the owner's own TablePlus tunnel). The run with `BACKUP_TUNNEL_PORT=$P2` fails `stage=preflight` "already in use"; fake and forwarder still alive; then the drill cleans them up |
| **Negative: argv mismatch** (F5(4)) | An orphaned forwarder (fake killed) whose `-L` names a different port than the one it listens on. Not killed; the run fails preflight |
| **Negative: stale lock decoy PGID** (F5(4)) | A stale lock dir with a dead pid, and `tunnel.json` whose `railwayPid` is a live `sleep 600` in its own group. The run proceeds and the `sleep` is still alive |

`secret_scan` covers all new outputs. Update the drill count in `docs/architecture.md`.

## 4. Tasks (one PR, in order)

| # | Task | Done when |
|---|---|---|
| T1 | Fixture + drill changes (§3) **only**. Run the drill on the unchanged script | Drill FAILs on the ssh assertions and on the rotation "already in use"; paste the failing summary lines in the PR as red evidence |
| T2 | Pure helpers + unit tests (§2.D, §5) in `scripts/lib/backup.mjs` / `backup.test.mjs` | Root `npm test` green |
| T3 | `scripts/backup-db.mjs`: snapshot + `tunnel.json`, new kill order, exit handler, post-check + `stage=cleanup`, extended reaper in `takeLock` and `preflight` (§2.A-C) | Drill all PASS |
| T4 | Docs: `docs/backup-restore.md` (the ssh child, `cleanup` stage, manual check `lsof -nP -iTCP:55432 -sTCP:LISTEN`, the reaper's rules); `docs/architecture.md` drill count; correct the M3 D-c(1) statement in a one-line note there | Docs match behaviour |
| — | PR: links M4 + this note, red and green drill summaries, "nothing run against production" | CI green on all 4 jobs |

## 5. Unit tests (`scripts/lib/backup.test.mjs`)

Positive fixtures are copied from the v5.71.0 argv built by `base_ssh_command` + `apply_forward_options`. One has `-p 2222` and `@ssh.railway-develop.com`.

- `isRailwaySshForward`:
  - true for the real argv and for the fixture argv (extra script token)
  - false for: port `5543` / `554321` / `155432` against 55432; `-L 0.0.0.0:55432:...`; `-L localhost:55432:...`; two `-L`; added `-R`/`-D`; missing `-N`; missing `ExitOnForwardFailure=yes`; argv0 `sshd`, `autossh`, `/usr/bin/ssh-agent`, `grep`, `node`; target `user@example.com`; empty string
- `isRailwayTunnelCmd`:
  - true for `/opt/homebrew/bin/railway connect Postgres --tunnel-only -P 55432 -e production`, and for `/bin/sh <fake> connect ...` with `railwayBin=<fake>`
  - false for other port, `-P` missing, `--tunnel-only` missing, a different binary, `vim railway connect --tunnel-only -P 55432`
- `parsePsRows`: handles leading spaces and args with spaces. `descendantsOf`: handles multi-level and cycles, and the root itself is excluded. `parseLsofPids`: `p123\nf4\n` gives `[123]`; garbage gives `[]`.
- `reapDecision`: kill only when every rule holds. One negative test per rule: wrong uid, PPID alive and not recorded, argv mismatch, not a listener on the port, PID reused (lstart differs).

## 6. Acceptance checks (QA)

- **M4-AC1** Drill red on current `main` (T1 evidence) and all PASS on the branch (QA re-runs).
- **M4-AC2** After every drill exit path (success, each failure stage, the tunnel timeout with `silent-ssh`, SIGINT, SIGTERM), the fake railway and the forwarder are dead and `lsof -nP -iTCP:<TP> -sTCP:LISTEN` is empty.
- **M4-AC3** A forwarder orphaned with the lock released (the owner's bug) is reaped by the next run, which exits 0 and logs the NOTE line. The SIGKILL case reaps both processes.
- **M4-AC4** Negative paths: an unrelated listener (`nc`), a forwarder with a live parent, an argv mismatch, and a decoy PGID are **never** signalled (each still alive after the run), and the run fails with the existing preflight reason.
- **M4-AC5** Root `npm test` green with the new unit tests; CI green on all 4 jobs.
- **M4-AC6** No password, URL or argv in `backup.log`, stdout/stderr or the new lock files (`secret_scan`, plus a code read: ps/lsof output is never logged).
- **M4-AC7** Only absolute tool paths (`/bin/ps`, `/usr/sbin/lsof`) with timeouts. No new dependencies. `prodGuard` unchanged.
- **M4-AC8** Code read: no `kill` call reaches a PID that has not passed `reapDecision` or the descendant-of-our-railway check, apart from the existing railway group kill and `pg_dump`.

## 7. For the owner (none blocks the PR)

1. **FYI, reaper scope (default: proceed as the mission asks).** The extended reaper will also kill **your own manual** tunnel on port 55432 if its railway parent is already gone (PPID 1) and its argv is the CLI's exact forward form. A manual tunnel whose `railway connect` is still running is never touched. Recommended: use a different `-P` for manual TablePlus sessions.
2. **Verification after merge** is your real run, `BACKUP_CONFIRM_PROD=1 npm run db:backup`. Afterwards, `lsof -nP -iTCP:55432 -sTCP:LISTEN` should print nothing, and `pgrep -fl 'ssh .*-L 127.0.0.1:55432'` should print nothing.
3. **Unexplained, out of scope:** the `2026-11-03T03:41:28Z FAIL stage=preflight` line shows `duration=138s`. The preflight timeouts add up to about 45 s, so 138 s is unexpected. It might be a sleeping external drive waking during the mount check. This note does not ask Dev to investigate. If it repeats, raise it as a separate item.

## 8. F5 follow-ups folded in

- **F5(3) stricter reaper argv match:** folded in (§2.D `isRailwayTunnelCmd` + `isRailwaySshForward`). It is the same code, and leaving the loose match while adding a second reaper would make it worse.
- **F5(4) drill case for the reaper's negative path:** folded in (§3, four negative cases). The fix adds new kill paths, so negative tests are required, not optional.
- F5(1), (2), (5), (6) stay as follow-ups (not related).

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A future CLI version changes the ssh argv, so the matcher misses and the leak comes back as "port in use" | The run fails safe (no wrong kill). The post-check gives a clear `stage=cleanup` failure plus notification. The doc names the CLI version. Unit tests pin the v5.71.0 argv |
| R2 | PID reuse between the snapshot and the kill | Re-verify `lstart` + argv + uid immediately before signalling; the window is milliseconds |
| R3 | `lsof`/`ps` slow or missing under launchd | Absolute paths and 5 s timeouts. On error, treat as "no match": no kill, existing failure |
| R4 | Killing a user's manual tunnel | Only when PPID 1 + exact argv + port + uid (§7.1) |
| R5 | The fixture diverges from the real CLI | The fixture argv is copied from `native.rs` v5.71.0. The owner's real run after merge is the final check |
