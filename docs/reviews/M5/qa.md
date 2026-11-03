# QA review: M5 weekly job through the Railway CLI tunnel

## 1. Scope reviewed
- PR #6, branch `feat/weekly-tunnel`, head `b49fcc3` (checked out in the main working tree; no source edited).
- Requirements: "Mission M5" in `docs/STATUS.md` (mission text and owner Gate 1 answers 1 to 3), `docs/plans/M5-weekly-tunnel.md`.
- Environment: throwaway `postgres:18` containers started by the drills, `scripts/fixtures/fake-railway.sh`, disk-image "drive". The real Railway CLI was never reachable: no `WEEKLY_CONFIRM_PROD` or `BACKUP_CONFIRM_PROD` was set in any shell (checked empty before the runs), direct runs used a call-recording shadow `railway` first on PATH (never called), and no plist was loaded.
- Mutation experiments ran in throwaway detached worktrees of `b49fcc3` under the scratchpad. All were removed afterward, along with the fake tunnel processes the mutants left behind.

## 2. Traceability

| Requirement | Test(s) | Result |
|---|---|---|
| Tunnel port is not 55432/55433 (default 55434) | `loadWeeklyConfig` unit tests; drill W3 (55432, 55433, and a free port); direct run with `WEEKLY_TUNNEL_PORT=55433` and with it equal to `BACKUP_TUNNEL_PORT`: "bad configuration", exit 1, shadow never called | Pass |
| Port conflicts are refused, and unrelated listeners are not killed | W4 (foreign listener, refused at preflight, listener survives, no backup ran); W15 (own stale forwarder reaped); W16/W17 (each job leaves the other's port alone) | Pass |
| Order schedule -> positions -> backfill `--season 2026-27` -> status | `STEPS`/`stepArgv` unit tests (match `package.json`); W5 marks in order with `--season 2026-27`; real `db:status` output in the log | Pass |
| Stop at first step failure | W9 to W12: later steps not run for each of schedule, positions, backfill, status | Pass |
| Tunnel and its ssh child close on success | W5, W6, W7, W19b, W22 | Pass |
| ...on each step failure | W9 to W12 | Pass |
| ...on timeout | W13 (hung step, process group dead, tunnel and forwarder dead, port free) | Pass |
| ...on SIGINT / SIGTERM | W14-INT, W14-TERM (exit 130 and 143, step dead, tunnel dead); SIGTERM during the backup child (backup's own handler ran, weekly tunnel never opened) | Pass |
| ...crash (SIGKILL) recovery | W15 (orphan reaped by the next run via `tunnel.json`) | Pass |
| Prod guard off by default; refuses before any tunnel or backup | W1 (unset, `true`, `01`, WEEKLY only; shadow never called, no lock, no log or dump change); W2 (fake weekly with real backup bin); W23 (step fixture with a non-fake bin); direct runs: no flags, only WEEKLY flag, bad season | Pass |
| Pre-write backup: reuse a validated one under 24 h | W6 (no new dump or backup log line); W7 (25 h old: new backup); W7b (recent dump with no OK line: new backup) | Pass |
| ...wait up to 10 min on a held lock, else fail | W19, W19b (real backup holds the lock, weekly waits and reuses its dump); W20 (3 s wait, fails, lock and holder untouched); W21 (stale dead-pid lock handled). The 600 s cap is enforced in config (`intIn(..., 1, 600)`). | Pass (the full 10 min was not run; the limit is configurable and tested at 3 s) |
| ...otherwise run a backup; abort with no writes if it fails | W5 (new backup); W8 (drive detached: `FAIL stage=backup`, tunnel never started, 0 marks) | Pass |
| Plist sets the flag(s) | W24 (`plutil -lint`, both flags exactly `1`, no DB URL); read the plist: new log paths, Monday 09:07 | Pass (plist not loaded, by rule) |
| Log and notification kept | W5 (log header, result line, `=== exit N ===`, mode 0600); `notify()` reads `WEEKLY_NOTIFY`, which is set to 0 in the drill, so the osascript call is not exercised | Pass for the log; notification untested (Note 4) |
| No credentials in logs, argv or `tunnel.json` | "no password" checks in every case; W5 and W22 redaction (step prints the URL, log shows it redacted); ps argv samples; `tunnel.json` check in W15 | Pass |
| Backup behaviour unchanged by the `tunnel.mjs` refactor | `npm run db:backup:drill` | Pass, 108/0 |
| Concurrent weekly and backup tunnels do not interfere | W16, W17, W18 | Pass (fake CLI only; Note 2) |
| `.env.example` documents the new variables | Not testable | Not tested (Finding 1) |

## 3. CI and automated tests
- CI run 41683723531 on PR #6: success. Jobs backend, frontend, root and worker all green. The only annotation is the Ubuntu 26 runner-label notice.
- Root `npm test`: 76 pass, 0 fail.
- `npm run db:backup:drill`: **108 passed, 0 failed**.
- `npm run db:weekly:drill`: **153 passed, 0 failed** (W1 to W24). No stray containers, mounts or fake tunnel processes were left afterward.
- Direct guard and config runs without Docker: five invocations, all refused at `stage=preflight` with the expected reasons. The shadow `railway` was never called, and no state dir or lock was created.

### Mutation check: is the weekly close path covered in isolation?
I mutated only `scripts/weekly.mjs`. The shared `tunnel.mjs` and the backup were left intact, so the backup step cannot be what fails. Each mutant made weekly's own `tunnel.kill` and `killSync` no-ops on one path.

| Mutant | First failing assertion | Cascade |
|---|---|---|
| A: weekly tunnel never closes (all paths) | W5 "cleanup incomplete" | Yes: the orphan holds the port, so later cases fail with "port already in use" (90 pass, 63 fail) |
| B: `cleanup()` kill and exit hook removed (signal path), `finally` kept | W14-INT "cleanup incomplete" (W5 to W13 all pass) | Yes, from W14 on (115 pass, 39 fail) |
| C: `finally` kill and exit hook removed (success path), `cleanup()` kept | W5 "cleanup incomplete" | Yes (88 pass, 66 fail) |
| D: no-op only when a fresh backup is reused (the backup step is skipped) | W6 "W6: cleanup incomplete", and it is the first failure (W5 passes) | Yes, from W7 on (92 pass, 62 fail) |

Conclusion: **the reported gap is not real for the paths I could separate.** Weekly has its own "weekly tunnel and forwarder dead, port free, lock released" assertion in every case, and the break is caught at the first case that exercises the path, including the reused-backup case (D), where backup is not involved at all. The Developer's observation was probably a product of the shared `tunnel.kill` no-op, which also breaks the backup's tunnel. Two real but minor weaknesses remain:
1. A single fault poisons every later case, because the drill does not reap between cases. The first FAIL is accurate, but the total count is noise (Finding 3).
2. The step-failure and timeout paths are closed twice (the `finally` and `cleanup()`), so no single mutation can fail them. That is redundancy, not a gap. I did not test removing both.

## 4. Findings

1. **Minor: `.env.example` was not updated.** It was not read, per instruction. The Developer reports that agent permissions deny it. The new `WEEKLY_*` variables (`WEEKLY_TUNNEL_PORT`, `WEEKLY_BACKUP_WAIT_S`, `WEEKLY_STEP_TIMEOUT_S`, `WEEKLY_TUNNEL_TIMEOUT_S`, `WEEKLY_PG_SERVICE`, `WEEKLY_RAILWAY_ENV`, `WEEKLY_LOG`, `WEEKLY_NOTIFY`) and the two confirm flags are documented in `README.md`, `ops/launchd/README.md` and the plan, but not there. Also, `DATABASE_PUBLIC_URL` is no longer needed by the weekly job. Fix: the owner (or an agent given permission) adds the variables and the note. This is documentation only and does not block merge.
2. **Note: the real Railway CLI is unverified.** Everything above ran against the fake CLI. Concurrent tunnels on 55434 and the backup port, the refactored backup against the real CLI, and the real ssh child process group behaviour are covered only by the plan's own caveat. The owner's manual first run is the real check. The README already says to do that before installing the plist. Recommend watching `logs/weekly.log` and `ps` for leftover `ssh -L` processes on that run.
3. **Minor: drill failure cascade.** After one broken close, dozens of later cases fail with "port already in use". The first failure is correct, but diagnosis needs the output read top-down. Optional fix: reap or fail fast between cases.
4. **Note: the notification is not exercised.** The drill always sets `WEEKLY_NOTIFY=0`. `notify()` is simple (osascript, errors swallowed). Check it once on the manual run.
5. **Note: test hook in production code.** `WEEKLY_STEP_FIXTURE` is accepted only with the repo's fake railway (W23 passes, and the unit tests cover `isFakeBin`). Behaviour is correct, and Sec should confirm the realpath comparison.
6. **Note: known wake-time noise.** If the weekly backup takes the lock first, the daily backup logs "another backup is running" and notifies. This is documented as a follow-up and matches the plan.
7. **Note: the 10-minute lock wait was tested at 3 s.** Behaviour is deterministic and the cap is validated in config. The full 600 s run was not done.

No Blocker or Major defects were found.

## 5. Verdict
VERDICT: READY WITH CONDITIONS

Every Gate 1 requirement traces to at least one passing test, and I reproduced all of the Developer's numbers (CI green, 76/76, backup drill 108/0, weekly drill 153/0). The backup behaviour is unchanged by the `tunnel.mjs` extraction, since the backup drill still passes in full. The tunnel and ssh child close on every path I could separate (success, reused backup, signals, step failure, timeout, crash recovery). Four independent mutants broke weekly's own close path, each caught by a weekly-specific assertion at the right case, including the reused-backup case. So the claimed coverage gap is not real. Conditions: (a) the `.env.example` documentation gap is tracked and closed by someone with access (Finding 1); (b) the owner's first manual run against the real CLI is treated as the real verification of Finding 2, with the notification (Finding 4) checked there, before the plist is installed. Security's review of the process-control, guard and fixture-hook changes is still outstanding.

## Handoff
- **Done:** independent QA of PR #6 at `b49fcc3`. Ran CI review, `npm test`, both drills, direct guard and config runs, and four weekly-only mutants. Wrote this report.
- **Files created:** `/Users/jayprox_pro/Documents/Projects/git/ai-application-nba/docs/reviews/M5/qa.md`. No source files were edited. Scratch worktrees were removed and the stray fake tunnel processes were killed.
- **Open questions:** who updates `.env.example` (Finding 1)? Does the owner want a fail-fast in the drill between cases (Finding 3)?
- **Recommended next role:** Sec review (T4) if it is not already done, then Lead review (T5). After that, the Coordinator readiness report with the two conditions above.

---

# Re-check (fix cycle 1)

## R1. Scope
- PR #6, branch `feat/weekly-tunnel`, head `dac36c3` (previous `b49fcc3`). Reviewed `git diff b49fcc3..dac36c3` (7 files: `scripts/lib/weekly.mjs`, `scripts/lib/weekly.test.mjs`, `scripts/weekly.mjs`, `scripts/weekly-drill.sh`, and three docs). CI run 41709082436 reported green by the Coordinator (not re-queried by me).
- Same safety rules as before. No `*_CONFIRM_PROD` in my shell (checked: 0). Only throwaway containers and the fake railway were used. No plist was loaded, no source edited, and the pre-existing `pg` container was untouched.

## R2. Results I reproduced
| Check | Result |
|---|---|
| `npm test` (root) | 80 pass, 0 fail (was 76; +4 new tests) |
| `npm run db:weekly:drill` | **155 passed, 0 failed** (W25 new) |
| `npm run db:backup:drill` | **108 passed, 0 failed** (unchanged) |
| Leftovers | No fake tunnel or ssh processes, no extra containers (`pg` only), no new disk images (the three mounted images are unrelated downloads and system assets) |

## R3. Do the new tests cover Lead findings 1 to 4?
| Lead finding | Change | Coverage | Verified by mutation (scratch worktree of `dac36c3`, since removed) |
|---|---|---|---|
| 1 Major: real weekly accepted a non-real backup bin | `weeklyGuard` returns `BACKUP_BIN_SET_MSG` when `BACKUP_RAILWAY_BIN` is non-empty, after both flags pass | Unit: fake bin, other absolute path, fake weekly bin plus fake backup bin all refused; unset and empty pass. Drill W25 | Mutant "guard returns null": the unit test `weeklyGuard: a production run refuses any BACKUP_RAILWAY_BIN` fails. The guard unit test is the only pre-drill catch. |
| 2 Minor: fake run reusing the real backup folder | `fakeIsolationError`, called in `weekly.mjs` right after `weeklyGuard`, still `stage=preflight` | Unit only (as the Lead specified, no drill case): defaults, volume (with and without trailing slash), dir equal, dir under (with `..`), log, each refused; drill-style paths accepted; sibling name `DB-Backups-other` accepted; non-fake run ignored | Mutant "always null": `fakeIsolationError` unit test fails. Every drill launch already passes (155/0), so the check does not break the isolated drill paths. |
| 3 Minor: redactor splits a secret at the 64 KB cap | On overflow writes one marker, clears the buffer, drops until `\n`. `flush()` writes nothing while dropping | Unit: Sec's repro (no 4-character substring of the secret in output, marker and `next` present); secret straddling several pushes; resume at the next newline; flush while dropping writes only the marker | Mutant "restore the old slice-and-keep-tail": the cross-push unit test fails. Note the single-chunk repro test did not fail on this mutant (see Finding R-2). |
| 4 Minor: port rule only checked in weekly env | Doc only, two lines in `ops/launchd/README.md` | Read: it says the two ports must differ, neither may be 55432 or 55433, and the weekly job checks only its own env | n/a (no code) |

W25 (read and run): sets both flags, keeps the fake `BACKUP_RAILWAY_BIN`, uses the shadow `railway` as `WEEKLY_RAILWAY_BIN`. It asserts exit non-zero, `FAIL stage=preflight`, the exact reason text, shadow call log absent, no lock dir, backup log line count unchanged, dump count unchanged (a fresh backup was seeded first so a reuse or new run would show), and 0 step marks. This meets the "no shadow calls, no lock, no new dump" requirement.

W23 change: its expectation moved from "step fixture requires the fake railway" to the new `BACKUP_RAILWAY_BIN must not be set` reason, because the drill env keeps a fake backup bin and the new guard fires first. This is correct and passes. Side effect: the drill no longer reaches the separate `stepFixture` plus non-fake bin check in `weekly.mjs`. That check is now unreachable through the drill (and in production, since the fixture needs the fake bin and the guard also needs the backup bin unset). It is covered only by the unit tests for `isFakeBin`. This is dead-ish defence in depth, not a defect (Finding R-1).

## R4. Findings
- **R-1 Note:** W23 no longer exercises the `step fixture requires the fake railway` branch (see above). The branch is still correct by reading. Optional: a unit or drill variant with the backup bin unset and both flags off is not possible without the real CLI, so no action is recommended.
- **R-2 Note:** The single-chunk "Sec repro" unit test passes even on the old slicing code, because the secret and padding all fit in one push that includes the newline, so the line is emitted whole. The cross-push test is what catches a regression. Coverage of the finding is adequate, but the first test is weaker than its name suggests. Optional: push the repro without the trailing newline first.
- **R-3 Note (carried over):** `.env.example` (original Finding 1) is an owner action at Gate 2. The real Railway CLI remains unverified (original Finding 2), and notification (original Finding 4) is untested. These are unchanged and are covered by the owner's manual first run.

No new Blocker, Major or Minor defects. The Lead's four in-PR fixes are present and effectively tested.

## R5. Updated verdict
VERDICT: READY WITH CONDITIONS

Rationale: All four fix-cycle items are implemented as the Lead specified. The guard fix, which was the one Major, is tested at both the unit level and by the new drill case W25. W25 shows a refusal at preflight with no shadow call, no lock, no new dump and no new backup log line. Mutating the guard, the isolation check and the redactor each made at least one new unit test fail. I reproduced `npm test` 80/0, weekly drill 155/0 and backup drill 108/0, and found no leftover processes or containers. Conditions are unchanged from before: (a) the owner adds the `.env.example` lines at Gate 2, and (b) the owner's first manual run against the real CLI, with attention to leftover `ssh -L` processes and the notification, is the real verification before the plist is installed. Security's re-check is separate from this verdict.

## Handoff (re-check)
- **Done:** reviewed `b49fcc3..dac36c3`, reran `npm test` (80/0), weekly drill (155/0) and backup drill (108/0), read W23 and W25, ran three scratch mutants against the new unit tests, and appended this section.
- **Files touched:** `/Users/jayprox_pro/Documents/Projects/git/ai-application-nba/docs/reviews/M5/qa.md` (appended only). No source edits. The scratch worktree was removed and no fake processes remain.
- **Open questions:** none new. The owner still has the `.env.example` action and the manual first run.
- **Recommended next role:** Sec re-check if outstanding, then Lead re-review, then the Coordinator readiness report.
