# QA review: M4 backup ssh child (PR #5)

## 1. Scope
Branch `fix/backup-ssh-child`, head `0e9c299` (fixture commit `dc4174c` + fix). Reviewed against docs/plans/M4-backup-ssh-child.md. Nothing run against Railway or production; BACKUP_CONFIRM_PROD never set; port 55432 confirmed empty before and after; drill uses random free ports.

## 2. Traceability
| AC | Evidence | Result |
|---|---|---|
| M4-AC1 red on old, green on fix | Worktree at `dc4174c`: drill 58 passed, 45 failed (ssh forwarder still alive after success, port held, rotation "already in use", SIGTERM/SIGINT port held, reap not logged). Branch: 99 passed, 0 failed (58 s). | PASS |
| M4-AC2 every exit path leaves no ssh child / listener | Drill: success, expect_fail cases, silent-ssh timeout (3 s, stage=tunnel), SIGTERM, SIGINT (exit 130) all assert tunnel + forwarder dead and port free | PASS |
| M4-AC3 orphan with lock released reaped; SIGKILL case | "Orphaned ssh forwarder, lock released" PASS (reaped, NOTE logged); SIGKILL case reaps both fake and forwarder | PASS |
| M4-AC4 negatives never signalled | nc listener alive; live-parent tunnel+forwarder alive; argv-mismatch forwarder alive; decoy PGID sleep alive; each fails preflight | PASS |
| M4-AC5 npm test, CI | Root `npm test` 55/55 pass. CI run 41583974979: backend, frontend, root, worker all pass | PASS |
| M4-AC6 no secrets | Drill secret scans (password in output / ps argv) all PASS. Code read: ps/lsof output never logged; tunnel.json holds pids, port, bin path, lstart | PASS |
| M4-AC7 absolute paths, timeouts, no deps, prodGuard | `/bin/ps`, `/usr/sbin/lsof` with 5 s timeout (lib/backup.mjs:295,312); no package/workflow changes in diff; prodGuard not in diff hunks | PASS |
| M4-AC8 no kill without gating | Read all `process.kill` sites in backup-db.mjs: ssh signals go through `sshTargets` (descendant + uid + `isRailwaySshForward`, lstart for recorded) or `reapDecision`; railway signals through own child group or `isRailwayTunnelCmd`-verified leader | PASS |

## 3. Automated summary
`npm test` 55/55. Drill 99/99 on branch. docs/architecture.md:773 says "99 PASS": matches. Docker containers and worktree cleaned up.

## 4. Findings
1. **Minor: `FAIL stage=cleanup` is not drilled.** Only code-read (backup-db.mjs:142, 180, 425). The post-check, `portStillHeld`, and exit code 2 path has no automated test. Recommend a follow-up drill case (e.g. a non-matching listener appearing on the port during the run).
2. **Note: the pre-fix drill leaks a forwarder (by design of the red run).** After running the drill at `dc4174c`, one ssh-like forwarder (PPID 1) was left behind by the drill's own pidfile cleanup missing it. I started it, verified by argv path, and killed it. This is expected for old code and confirms the bug; not a defect in the PR.
3. **Note: post-check orphan sweep.** If the port is still held after our own kill, `reapOrphanedSsh` may kill any PPID-1, same-uid, exact-argv forwarder on the port (including a manual tunnel with the railway parent gone). Matches plan section 7.1; documented behaviour.
4. **Note: real CLI untested.** The fixture models v5.71.0 argv; the owner's real run after merge is the final check (plan R5).
5. **Note: STATUS.md** M4 section is the uncommitted file in the main checkout; I did not read or touch it beyond the git status.

## 5. Verdict
VERDICT: READY WITH CONDITIONS

The fix is verified: the drill is red on the pre-fix script (45 failures) and fully green on the branch (99/99), every exit path leaves no forwarder or listener, orphan and SIGKILL cases are reaped, and all four must-not-kill negatives held. Unit tests and CI are green and the docs count matches. Conditions: (a) track the undrilled `stage=cleanup` path as a follow-up (or add a case), and (b) the owner's real post-merge run, followed by `lsof -nP -iTCP:55432 -sTCP:LISTEN` and `pgrep -fl 'ssh .*-L 127.0.0.1:55432'` printing nothing, remains the only real-CLI check.

## 6. Re-review (fix cycle 1), head a574414

Scope: diff 0e9c299..a574414 touches only `scripts/backup-drill.sh` (+18, new "Port still held after the run" case) and the drill count in `docs/architecture.md`. No source or fixture change, so no Sec re-review is needed per Lead finding 1.

| Lead assertion | Drill check | Result |
|---|---|---|
| exit 2 | "exit 2 when the tunnel port stays held" | PASS |
| cleanup FAIL log line | `FAIL stage=cleanup reason="tunnel port $TP still in use after run"` matched exactly | PASS |
| dump committed, no .partial | dump count +1; `no_partial` | PASS |
| lock released | `backup.lock` absent | PASS |
| mismatched forwarder left alive | `ssh.pid` still alive; port still held | PASS |
| secret scan | "no password in cleanup-case output" | PASS |
| forwarder then cleaned up | killed only the drill's own pid from `ssh.pid`; port free | PASS |

The case drives the real fail-safe path (`FAKE_RAILWAY_SSH_LABEL_PORT` makes the argv name another port, so the matcher rejects it). It does not just check a string. A mutation check was not run: I did not modify source.

Runs (fresh, local):
- Before: 55432 free, no forwarders, no `chalk-drill` containers.
- `./scripts/backup-drill.sh` (zsh script; `bash` fails on `setopt`, which is expected): `108 passed, 0 failed`, rc 0, zero FAIL lines.
- Root `npm test`: 55/55 pass.
- After: 55432 free (`lsof` empty), no `ssh -L 127.0.0.1:55432` processes, 0 `chalk-drill` containers. I killed no process I did not start.
- CI run 41611129533 reported green by the coordinator. I did not independently re-fetch it.
- `docs/architecture.md:773` says "108 PASS", matching the drill.

Finding 1 (undrilled cleanup path): resolved. Condition (a) is cleared. Condition (b) stays: the real `railway` CLI has never been exercised; that is the owner's post-merge run, followed by the `lsof` and `pgrep` checks printing nothing. Lead follow-ups 2-4 are unchanged and non-blocking.

VERDICT: READY WITH CONDITIONS

Rationale: the cleanup path is now drilled with every asserted behaviour passing (108/0), unit tests pass, and the environment was left clean. The one remaining condition is the owner's real-CLI post-merge run, which cannot be tested without the real CLI and production access.
