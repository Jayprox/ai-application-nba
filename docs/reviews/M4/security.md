# M4 Security review: backup tunnel ssh child (PR #5)

`VERDICT: READY`

There are no Blocker or Major findings. Findings 1-6 are Minor or Note hardening items. None of them lets the script signal a process that belongs to another user or to an unrelated program.

## 1. Scope and tools

- **PR:** #5. **Branch:** `fix/backup-ssh-child`. **Head:** `0e9c29990a4e7970322528df7782f343f72c4d14`. **Base:** `main` (`ee89270`).
- **Files read:**
  - the full `scripts/backup-db.mjs`
  - the M4 additions in `scripts/lib/backup.mjs`, `scripts/fixtures/fake-railway.sh`, `scripts/fixtures/fake-ssh-forward.mjs` and `scripts/backup-drill.sh`
  - `docs/backup-restore.md`
  - the plan `docs/plans/M4-backup-ssh-child.md`
  - the M4 section of `docs/STATUS.md`
  - the M3 security review, for context
- **Commands run (all local, nothing against production, `BACKUP_CONFIRM_PROD` not set, the real `railway` CLI never invoked):**
  - `npm test`: 55/55 pass. `node --test scripts/lib/backup.test.mjs`: 24/24 pass.
  - `zsh scripts/backup-drill.sh`: **99 passed, 0 failed** (rc=0). Before the run, `lsof -nP -iTCP:55432 -sTCP:LISTEN` was empty. The drill uses ephemeral ports from `free_port`, not 55432.
  - An ad-hoc probe of the pure matchers (`isRailwaySshForward`, `isRailwayTunnelCmd`, `parseLsofListeners`, `reapDecision`, `parsePsRows`) with adversarial inputs. Results are used in the findings below.
  - `gh pr checks 5`: backend, frontend, root and worker all pass.
  - A pattern grep of `git log -p main..HEAD` for secrets, plus a check for added `.env`, key or pem files. Nothing was found.
- **Scanners:** `gitleaks`, `semgrep`, `trivy` and `osv-scanner` are not installed, so none were run. No `npm audit` was needed because no dependency changed (§3).

## 2. Findings

### Confirmed properties (verified, high confidence)

- **Single kill gate for the orphan path.** `reapOrphanedSsh` (`scripts/backup-db.mjs:105-117`) signals only rows that pass `reapDecision` (`scripts/lib/backup.mjs:166-174`). That function checks, in order:
  - pid > 1 and not self
  - same uid
  - lstart, when recorded
  - `isRailwaySshForward` with the exact port
  - the pid is a listener on exactly `n127.0.0.1:<port>`; the IPv6 `[::1]` and `*:` listeners are excluded (probe confirmed)
  - PPID is 1, or PPID is the railway pid recorded in a verified stale lock

  This implements M4-AC8.
- **The live-run path kills only our own descendants.** `sshTargets` (`backup-db.mjs:72-82`) returns only:
  - descendants of our own railway child, or recorded pids whose `lstart` matches
  - in both cases, with the same uid and the exact forward argv

  Snapshot (2) is taken before railway is signalled (`:130` before `:133`), so the PPID link still exists. The SIGKILL escalation in `stopSsh` re-verifies pid, lstart, uid and argv against a fresh snapshot (`:91-95`).
- **The stale-lock path checks railway strictly.** `reapStaleTunnel` (`:226-245`) signals the recorded railway only if it has the same uid and `isRailwayTunnelCmd`. That check requires the exact `railwayBin` token, `connect`, `--tunnel-only` and `-P <port>`. This closes M3 F5(3). The drill's decoy case (a live `sleep 600` in its own group, named in `tunnel.json`) passes: the decoy is not killed.
- **Exact port compare.**
  - In `isRailwaySshForward`, the `FORWARD_RE` capture is compared as a string to `String(port)`. Ports 5543, 554321, 155432 and 055432 are all rejected (unit tests and probe).
  - In `isRailwayTunnelCmd`, the `-P` value must equal `String(port)` exactly.
  - In lsof parsing, the line must equal `n127.0.0.1:${port}` exactly.
- **Other users' processes are never signalled.** Every gate checks `uid === process.getuid()`. Without root, lsof does not list other users' sockets anyway.
- **A live manual tunnel is not touched.** With a live parent, PPID is not 1. In the preflight path `recordedRailwayPid` is null, so `reapDecision` returns `parent-alive`. The drill's "live parent" negative case passes: the fake and the forwarder are still alive and the run fails `stage=preflight` with the existing reason. Unrelated listener (`nc`) and argv-mismatch cases also pass.
- **Absolute binaries, timeouts, scrubbed env.**
  - `/bin/ps` runs with a 5 s timeout and `env: {LC_ALL: 'C', PATH: '/usr/bin:/bin'}`.
  - `/usr/sbin/lsof` runs with a 5 s timeout.
  - Both use `spawnSync` with an argv array: no shell, so no injection. The port is coerced with `Number()`.
  - Any error gives `null` or `[]`, which means no kill.
- **No injection from argv or env.**
  - ps and lsof output is parsed with anchored regexes and never logged or interpolated into a command.
  - `parseTunnelRecord` validates `tunnel.json`: integer pids > 1, a port in range, `railwayBin` a non-empty string.
- **Secrets.**
  - New log lines are fixed strings: two `NOTE` lines, and the `cleanup` failure, which contains only the port.
  - The notification text is fixed.
  - `tunnel.json` holds pids, lstart, the port and the railway binary path. It is mode 0600 inside the 0700 lock dir, under `umask 077`.
  - The ssh key path from the argv never reaches a log or notification.
  - The drill's `secret_scan` covers the new outputs and passed.
- **The M3 guard is intact.**
  - `prodGuard` (`scripts/lib/backup.mjs:128-139`) is unchanged; the diff for that file only appends after line 197.
  - The drill still launches runs via `env -i` (`backup-drill.sh:108`), and its guard cases, including the ambient `BACKUP_CONFIRM_PROD` leak case, all pass.
  - The new `start_fx` helper also uses `env -i`.
- **The fixture's perl launcher is safe.** `/usr/bin/perl -e 'use POSIX qw(setsid); setsid(); exec { $ARGV[0] } @ARGV[1..$#ARGV]'` (`fake-railway.sh:27`) uses list-form `exec` with an explicit program. There is no shell re-parse, all arguments are quoted, and the values come only from fixture env and fixture paths. It is test-only, and `prodGuard` still allow-lists only `fake-railway.sh` by realpath. `fake-ssh-forward.mjs` binds only `127.0.0.1` and connects only to `127.0.0.1:<target>`.

### Numbered findings

**1. Minor: `isRailwaySshForward` accepts extra `-o` forward and command options.**
- **Location:** `scripts/lib/backup.mjs:111-122`
- **Evidence:** the probe returned `true` for the real argv plus any one of:
  - `-o RemoteForward=...`
  - `-o DynamicForward=...`
  - `-o LocalForward=0.0.0.0:...`
  - `-o GatewayPorts=yes`
  - `-g`
  - `-o ProxyCommand=...`
  - `-o RemoteCommand=...`

  The `-R` and `-D` exclusion only covers the short flags.
- **Impact:** low. The reaper still needs the same uid, PPID 1, a listener on exactly `127.0.0.1:<port>`, exactly one `-L 127.0.0.1:<port>:127.0.0.1:n`, and a target `@ssh.railway.com`. Only an owner-started ssh to Railway on the backup port, with its parent gone, could be affected. That case is already disclosed in plan §7.1.
- **Fix (optional):** reject `-g`, and `-o` values whose key (case-insensitive) is `RemoteForward`, `DynamicForward`, `LocalForward`, `GatewayPorts`, `RemoteCommand` or `PermitLocalCommand`. Add matching unit cases. This is the fail-safe direction.

**2. Minor: the group signal on a verified ssh also reaches its other group members.**
- **Location:** `scripts/backup-db.mjs:84` (`sigProc`)
- **Evidence:** when `pgid === pid`, the signal goes to `-pid`. That is correct for the real CLI, since `process_group(0)` makes ssh the leader, and it also covers a `ProxyCommand` child.
- **Impact:** for an orphaned (PPID 1) owner-started ssh that leads a job-control pipeline, for example `ssh ... | tee log`, the `tee` would also get SIGTERM or SIGKILL. That needs §7.1's scenario plus a pipeline. Very unlikely.
- **Fix (optional):** in the reaper path (not the descendant path), signal only the pid. Alternatively, signal the group only if every member is the ssh pid or one of its descendants in the same snapshot.

**3. Note: PID-reuse window between check and kill.**
- **Location:** `scripts/backup-db.mjs:130-138`, `:87`
- **What happens:** in `doKillTunnel`, targets are verified once. They get SIGTERM at `:132`, and `stopSsh` sends SIGTERM to them again at `:87`. Waiting for railway can take up to about 5 s before that second SIGTERM, and there is no re-verification before it. Only the SIGKILL escalation re-verifies.
- **Impact:** for the pid to be reused, the verified ssh would have to die, and macOS would have to wrap its pid counter (up to 99999) back to that exact pid within about 5 s, all in a process of our own uid. Practically nil.
- **Fix (optional):** skip the second SIGTERM for targets that are already dead, or re-verify with the same `now` check used before SIGKILL. Confidence that this is exploitable: very low.

**4. Note: the stale-lock railway record has no `lstart`.**
- **Location:** `scripts/backup-db.mjs:145-151`, `:234`
- **What happens:** the recorded `railwayPid` is re-identified by uid and strict argv only, not by start time.
- **Impact:** a reused pid would have to be our uid running exactly `<railwayBin> connect … --tunnel-only -P <port>`, which is by definition a stale backup tunnel. Acceptable.
- **Fix (optional):** record and compare `lstart` for railway too, for symmetry with the ssh entries.

**5. Note: some railway group signals are pid-based without re-verification.**
- **Location:** `scripts/backup-db.mjs:133-136`, `:169`
- **What happens:** `process.kill(-t.pid, …)` targets the group of our own detached child. If node has already reaped railway and the pgid has emptied, a later group signal could only hit a group that reused that number.
- **Impact:** this behaviour predates M4 (it is unchanged from M3). The window is seconds. Not introduced by this PR.
- **Fix:** none required. Mentioned for completeness.

**6. Note: `lsof` inherits `process.env`, and `osascript` is resolved via PATH.**
- **Location:** `scripts/lib/backup.mjs:207`; `scripts/backup-db.mjs:60` (`osascript`, which predates M4)
- **What happens:** `lsof` has an absolute path and a timeout but no scrubbed env. Unlike `ps`, it is not locale-sensitive for `-F` output.
- **Fix (optional):** pass `env: {PATH: '/usr/bin:/bin'}` to lsof and use `/usr/bin/osascript`. This is hygiene, not exploitable: a same-user attacker who controls the env already controls the process.

**7. Note: a test-environment observation, not a code finding.**
- During this review, `pgrep` showed an orphaned fixture forwarder (`fake-ssh-forward.mjs`, PPID 1, a fixture argv on an ephemeral port).
- It came from another agent's red-evidence drill, running at `dc4174c` (fixture-only, unfixed script) in a scratchpad worktree. That drill was still running.
- It is not from this branch's drill. After my run, no forwarder from my drill remained and 55432 was free.
- I did not signal it. The owner of that run should make sure it is cleaned up.

## 3. Dependency review

- `package.json` and lockfiles are unchanged, and no new npm, pip or system dependencies were added.
- New tool use is limited to OS binaries at absolute paths: `/bin/ps`, `/usr/sbin/lsof`, and `/usr/bin/perl` (fixture only).
- **M4-AC7 is satisfied.**

## 4. Verdict

`VERDICT: READY`

- **Process-identification rules:** the logic matches plan §2.C and §2.D and is concentrated in pure, unit-tested functions. It matches on uid, the exact argv, an exact numeric port, a listener on exactly `127.0.0.1:<port>`, and PPID 1 or a verified recorded parent.
- **Negative paths:** in the drill, an unrelated listener, a live parent, an argv mismatch and a decoy PGID were each left alive.
- **Secrets:** nothing secret is logged or written.
- **M3 controls:** the production guard and the drill's env scrubbing are unchanged and still tested.
- **Remaining items:** findings 1-2 are optional hardening that narrows an already owner-disclosed edge case (plan §7.1). Findings 3-6 are notes. None blocks merge.

## Handoff

- **Done:** a static review of the PR #5 diff and the code paths it touches. Ran the unit tests (24/24 backup, 55/55 root), the full drill (99/0) and adversarial matcher probes, and checked CI (4/4 green). No scanners were available.
- **Files created:** `docs/reviews/M4/security.md` (not committed). No source, config or `docs/STATUS.md` edits.
- **Open questions:** whether Dev should take the optional hardening in findings 1 and 2 now or as follow-ups. Recommendation: follow-up.
- **Recommended next role:** Lead review, after QA's verdict. Coordinator: the orphaned fixture forwarder from the other agent's red-evidence drill (finding 7) should be cleaned up by whoever started it.
