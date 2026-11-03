# M5 Lead review: weekly job through the Railway CLI tunnel (PR #6)

`VERDICT: NOT READY` (fix cycle 1 of 3: four small, scoped items below; no redesign)

The implementation follows the plan (`docs/plans/M5-weekly-tunnel.md` §2-§8): T1 is a pure-refactor commit (`e4a1abc`), the tunnel factory is shared with no module state, the guard runs first, the URL lives only in step-child env, the order and Gate 1 backup rules are met, and the plist sets both flags and is not loaded. QA and Sec independently reproduced 76/76, backup drill 108/0, weekly drill 153/0 and CI 41683723531 green. QA's mutation work shows the Dev-reported close-path coverage gap is not real.

It is NOT READY only because Sec's condition (finding 1 below) is a hole in the guard that this plan was supposed to close (plan §4 item 2 blocks fake-weekly + real-backup but not the reverse), and it is cheaper to fix than to ask the owner to accept. While Dev is in the PR, three other small items ride along. Once they land with green CI and the drills pass, this is READY WITH CONDITIONS (owner items in §3).

## 1. What I checked

- Read `CLAUDE.md`, "Mission M5" in `docs/STATUS.md`, the plan, `docs/reviews/M5/qa.md`, `docs/reviews/M5/security.md`, the diff stat for `main...b49fcc3`, and in full `scripts/lib/weekly.mjs`, the guard and `loadConfig` in `scripts/lib/backup.mjs`, the backup stage of `scripts/weekly.mjs` (lines 200-283), the plist, and the drill's `build_env` safety harness (`scripts/weekly-drill.sh:75-114`).
- `npm test`: 76 pass, 0 fail.
- `pgrep -fl "fake-railway|fake-ssh-forward"` and `lsof` on 55390 and 55432-55434: nothing running. Sec note 9 (orphaned `mutA` fixture processes) is resolved; QA cleaned them up.
- I did not run the drills again (two independent reviewers already did), and nothing ran against production or the real CLI.

## 2. Findings and decisions

**1. Major (fix in this PR). Real weekly run accepts a non-real backup railway.** (Sec Minor 1, raised to Major for this review because it defeats the owner's Gate 1 answer 1.)
- Evidence: `scripts/lib/weekly.mjs:80` returns `null` for a real weekly run whenever `BACKUP_CONFIRM_PROD === '1'`, without looking at `BACKUP_RAILWAY_BIN`. The backup child gets `process.env` (`scripts/weekly.mjs:219`), and `prodGuard` exempts a fake `BACKUP_RAILWAY_BIN` (`scripts/lib/backup.mjs:128-143`). So `WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1 BACKUP_RAILWAY_BIN=<fake>` writes to production after a "backup" of a local DB.
- Fix (Dev):
  - In `weeklyGuard`, in the real-weekly branch (after the `isFakeBin(WEEKLY_RAILWAY_BIN)` branch), refuse with `WEEKLY_GUARD_MSG`, or a new fixed message such as `'BACKUP_RAILWAY_BIN must not be set for a production run'`, when `env.BACKUP_RAILWAY_BIN` is non-empty. Any value, fake or not, is refused. The real backup resolves `railway` from PATH when this is unset, so "set at all" is the right test and it needs no realpath logic.
  - Unit tests in `scripts/lib/weekly.test.mjs`: both flags plus fake `BACKUP_RAILWAY_BIN` is refused; both flags plus `BACKUP_RAILWAY_BIN=/usr/local/bin/railway` (any other absolute path) is refused; both flags with it unset still passes; the existing fake/fake cases are unchanged.
  - Drill case (next free `W` number) in `scripts/weekly-drill.sh`: `run_weekly --shadow-wbin WEEKLY_RAILWAY_BIN=$SHADOW/railway WEEKLY_CONFIRM_PROD=1 BACKUP_CONFIRM_PROD=1` with the fake `BACKUP_RAILWAY_BIN` kept. This is the W23 pattern, so `build_env` does not abort. Assert `FAIL stage=preflight`, exit 1, `shadow.calls` absent, no lock dir, no new dump or backup log line.
  - Doc: one sentence in `docs/backup-restore.md` (the weekly paragraph near line 25) or `ops/launchd/README.md`: a production weekly run refuses if `BACKUP_RAILWAY_BIN` is set.

**2. Minor (fix the weekly half in this PR; the backup half is a follow-up). A fake-mode backup in the real backup folder can be reused as fresh.** (Sec Minor 2.)
- Evidence: `findFreshBackup` (`scripts/lib/weekly.mjs:107-124`) trusts any `OK file=` line in `bcfg.logPath`. A fake weekly run without `BACKUP_*` overrides gets the defaults from `loadConfig` (`backup.mjs:26-28`: `/Volumes/DB-Backups`, `~/Library/Logs/chalk-that-nba/backup.log`). Its backup child then writes a throwaway-DB dump and a normal OK line there, which a real weekly run would reuse for 24 h. The reuse is new in M5.
- Fix (Dev), weekly side only:
  - Add a pure helper in `scripts/lib/weekly.mjs`, for example `fakeIsolationError(cfg, { home })`, that returns a fixed reason when the run is fake-exempt (`isFakeBin(env, 'WEEKLY_RAILWAY_BIN')`) and any of these hold: `path.resolve(cfg.backup.volume)` is `/Volumes/DB-Backups`; `path.resolve(cfg.backup.dir)` is that path or under it; `path.resolve(cfg.backup.logPath)` equals the default `path.join(home, 'Library/Logs/chalk-that-nba/backup.log')`.
  - Call it in `scripts/weekly.mjs` right after `weeklyGuard`, still at `stage=preflight` and before the lock, `findFreshBackup` or any child.
  - Unit tests only: defaults refused, each of the three overrides pointing back at the real location refused, and the drill's style of `$WORK` paths accepted. Do **not** add a drill case. A failing drill case here would write to the real drive.
  - Confirm the full weekly drill still passes 153+/0 (every drill launch already sets the `BACKUP_*` paths under `$WORK`).
- Follow-up (not this PR): an ad-hoc fake `npm run db:backup` with the default paths still writes into the real folder. Fixing that changes backup behaviour, which plan §2 keeps out of M5. Bundle it with the open M4 backup-hardening follow-ups (for example, mark fake-mode OK lines `src=fake` and have `findFreshBackup` reject them).

**3. Minor (fix in this PR). `lineRedactor` can split a secret at the 64 KB cap.** (Sec Minor 3.)
- Evidence: `scripts/lib/weekly.mjs:162` flushes `buf.slice(0, len-1024)` without regard to where a secret starts or ends. Sec's probe emitted a password in two halves. A tail of any length cannot fix this, because a secret can straddle any cut point.
- Fix (Dev): on overflow, do not write partial content. When `buf.length > 65536` with no newline, write one fixed marker line (for example `[output line over 64 KB truncated]`), clear `buf`, and drop input until the next `\n` (track with a boolean). Then resume normal line handling. `flush()` writes nothing if it is still dropping. Unit test: Sec's repro (65000 `a` + secret + 1012 `b` in one chunk, then `\nnext\n`). The writer output must not contain any substring of the secret of length 4 or more, and it must contain the marker and `next`. Also test a split across two pushes. The existing redactor tests must stay green.

**4. Minor (doc-only in this PR; code check is a follow-up). Port reservation is checked only inside the weekly env.** (Sec Minor 4.)
- Evidence: `scripts/lib/weekly.mjs:39-40` compares against the weekly process's own `BACKUP_TUNNEL_PORT`. The two plists are separate envs. `ops/launchd/README.md:67` already says not to use 55432-55434 for manual tunnels, but it does not say the two jobs' ports must differ.
- Fix (Dev): add one sentence to `ops/launchd/README.md` (near line 67) saying that if `BACKUP_TUNNEL_PORT` or `WEEKLY_TUNNEL_PORT` is set in either plist, the two must differ and must not be 55432/55433. No code change in this PR. Making `backup.mjs loadConfig` reject the weekly port changes backup behaviour, so it is a follow-up.

**5. Minor (owner action, does not block merge). `.env.example` is not updated.** (QA Minor 1.)
- Agents are denied read access to `.env.example`, so Dev cannot do it and must not try another route. It goes to the owner at Gate 2 as an action item. Suggested text for the owner, all commented out because the defaults are correct:
  - `# Weekly job (scripts/weekly.mjs). Production run needs WEEKLY_CONFIRM_PROD=1 and BACKUP_CONFIRM_PROD=1 (the launchd plist sets both). Do not put them in .env.`
  - `# WEEKLY_TUNNEL_PORT=55434  WEEKLY_BACKUP_WAIT_S=600  WEEKLY_STEP_TIMEOUT_S=3600  WEEKLY_TUNNEL_TIMEOUT_S=60  WEEKLY_PG_SERVICE=Postgres  WEEKLY_RAILWAY_ENV=production  WEEKLY_LOG=logs/weekly.log  WEEKLY_NOTIFY=1`
  - A note that the weekly job no longer reads `DATABASE_PUBLIC_URL` from `.env` (it builds the tunnel URL in memory). Other scripts may still use it.
- The variables are already documented in `README.md:152`, `ops/launchd/README.md` and the plan, so this is a documentation gap only.

**6. Minor (follow-up). The drill cascades after one broken close.** (QA Minor 3.)
- Evidence: QA mutants A-D (`qa.md` §3). The first FAIL is always the correct one, and later cases fail with "port already in use". This is a diagnosability issue in a test tool, not a correctness gap, and it applies equally to the backup drill. Follow-up: reap fixtures and assert the ports are free between cases, or stop at the first FAIL with a pointer. Dev should not change it in this PR, beyond adding the new case from finding 1.

**7. Note (follow-up).** Sec notes 5 (stale reaper trusts `rec.port`), 6 (lock-takeover microsecond race, inherited from backup) and 8 (pre-existing `logs/weekly.log` may be 0644; add `chmodSync(0o600)` per run or a README line) go to a hardening follow-up with the M4 items. None needs a change in this PR.

**8. Note (owner, Gate 2).** These are carried from plan §9 and QA, not defects: two prod flags (plist sets both); weekly depends on the DB-Backups drive; the daily backup may notify "another backup is running" at wake (follow-up); the real CLI, concurrent real tunnels, the refactored backup on the real CLI and the notification are verified only by the owner's first manual run. Watch `logs/weekly.log` and check `ps` for leftover `ssh -L` processes after that run, before installing the plist.

## 3. Path to READY

Dev pushes commits for findings 1-4 to `feat/weekly-tunnel` (one commit per finding is fine; no force-push, no rebase of the reviewed T1 commit). Before handing back, Dev runs `npm test`, `npm run db:weekly:drill` and `npm run db:backup:drill` (the backup drill must still be 108/0, since `backup.mjs` must not change) and reports the new head SHA and CI run.

Re-review scope: Sec checks findings 1-3, QA checks the new tests and drill counts, and Lead does a final pass. If those are clean, the expected verdict is READY WITH CONDITIONS, with these conditions: owner adds `.env.example` lines (finding 5); the owner's manual first run is the real verification (finding 8); follow-ups for findings 2 (backup half), 4 (code), 6 and 7 are logged in `docs/STATUS.md`.

## Handoff

- **Done:** Lead review of PR #6 at `b49fcc3` against the plan, standards and the QA and Sec verdicts. Ran `npm test` (76/76). Confirmed no stray fake tunnel processes or listeners remain.
- **Files created:** `docs/reviews/M5/lead.md` (not committed). No source edits.
- **Open questions:** none for the owner before the fix cycle. At Gate 2, the `.env.example` lines (finding 5) are an owner action.
- **Recommended next role:** Dev, for fix cycle 1 (findings 1-4), then CI, then QA and Sec re-check, then Lead.

---

# Final pass (fix cycle 1)

`VERDICT: READY WITH CONDITIONS`

Head `dac36c3` (local and `origin/feat/weekly-tunnel` match; PR #6 open at that SHA). No fix cycle 2.

## F1. What I checked

- `git diff b49fcc3..dac36c3` in full (7 files). `scripts/lib/backup.mjs`, `scripts/backup-db.mjs`, `package.json` and the lockfile are unchanged in the delta (empty `--stat`), so backup behaviour is untouched as plan §2 requires.
- `npm test` (root): 80 pass, 0 fail.
- `gh pr checks 6`: backend, frontend, root, worker all pass (run 41709082436).
- `scripts/weekly.mjs:239-245`: order is config load, `weeklyGuard`, `fakeIsolationError`, step-fixture check, then `createTunnel`. All three refusals are at `stage=preflight`, before the lock, `findFreshBackup` or any child.
- QA re-check (`qa.md` "Re-check (fix cycle 1)"): weekly drill 155/0, backup drill 108/0, three mutants each killed by a new unit test. Sec re-check (`security.md` "Re-check (fix cycle 1)"): findings 1 and 3 closed, finding 2 closed for the weekly half, redactor sweep with 0 leaks. I did not rerun the drills; two reviewers did independently. Nothing ran against production or the real CLI.

## F2. My four fix instructions

| # | Instruction | Result | Evidence |
|---|---|---|---|
| 1 Major | Real weekly refuses any non-empty `BACKUP_RAILWAY_BIN`; unit tests; drill case; one doc sentence | **Done** | `scripts/lib/weekly.mjs:83-86`; unit test "a production run refuses any BACKUP_RAILWAY_BIN" (fake, other absolute path, real weekly + fake backup refused; unset and empty pass); drill W25 (`scripts/weekly-drill.sh:432-438`) asserts preflight FAIL, exact reason, no shadow call, no lock, no new dump or backup log line; `docs/backup-restore.md:26-27`. |
| 2 Minor | Pure `fakeIsolationError`, called right after the guard; unit tests only, no drill case; drill still passes | **Done** | `scripts/lib/weekly.mjs:89-100`, `scripts/weekly.mjs:243-244`; unit test covers defaults, volume (with trailing slash), dir equal, dir under (with `..`), log, sibling name accepted, `$WORK` paths accepted, non-fake ignored. No drill case added. Drill 155/0 (QA, Sec). |
| 3 Minor | Redactor: marker on overflow, drop to next `\n`, `flush()` silent while dropping; tests | **Done** | `scripts/lib/weekly.mjs:173-197`; two new unit tests. Sec's sweep (7 prefix lengths x 5 chunk sizes, password and URL): 0 leaks. |
| 4 Minor | Doc sentence on the two plists' ports | **Done** | `ops/launchd/README.md:68-69`. |

Dev followed the scope: no force-push, the T1 commit is intact, and the only drill edits are W25 and the W23 expectation.

## F3. Decisions on the open items

**Sec R3-1 (string path comparison; case-insensitive APFS or a symlink gets past `fakeIsolationError`): accepted as a follow-up.**
- It needs a deliberately odd spelling (`/volumes/db-backups`) or a symlink in a manual fake run. Defaults and every drill path are handled correctly.
- Its worst outcome is the same as the already-accepted backup-half gap of finding 2 (an ad-hoc fake `npm run db:backup` with default paths): a throwaway dump reused as "fresh" for up to 24 h. Fixing R3-1 alone would not close that gap.
- The right fix closes the whole class at the source: tag fake-mode OK lines (for example `src=fake`) and have `findFreshBackup` reject them. Then the path comparison is only a convenience. That changes `backup.mjs`, which plan §2 keeps out of M5. A realpath/case-fold patch here would add fs logic to a pure helper for a partial fix. Not worth a fix cycle.

**W23 deviation / Sec R4 (step-fixture check now reached by no drill case; covered by `isFakeBin` unit tests only): accepted as a follow-up.**
- The W23 change is correct: the drill env keeps a fake backup bin, so the new guard fires first. This is a consequence of finding 1, not a regression.
- I agree with Sec that a drill variant with the backup bin unset is the wrong tool. It would rely on the PATH shadow as the only safety layer and would need the `build_env` abort at `scripts/weekly-drill.sh:99-100` weakened. Neither is acceptable.
- Impact if the check regressed is low (plist does not set `WEEKLY_STEP_FIXTURE`; the fixture step fails in prod because `weekly_drill_marks` does not exist; output goes through the redactor). Extracting `stepFixtureError(cfg, env)` with four unit cases is a pure refactor and fits the hardening follow-up.

**QA R-2 (single-chunk redactor test passes even on the old code): Note, follow-up.** The cross-push test kills the regression mutant, so the finding is covered. Optional: push the repro without its newline first so the first test also bites.

**Sec R3-2 (W23 and W25 now hit the same path): Note.** W25 adds the backup-log and dump-count assertions W23 lacks, so it is not pure duplication. No action.

## F4. Consolidated follow-ups (Coordinator: log in `docs/STATUS.md`)

Bundle 1-5 with the open M4 backup-hardening follow-ups as one hardening mission.

1. **Fake-backup reuse, backup half (finding 2) + R3-1:** tag fake-mode OK lines (e.g. `src=fake`) and have `findFreshBackup` reject them; optionally make `fakeIsolationError` compare by realpath of the nearest existing ancestor with case folding (or dev/ino), with unit cases for case variants and symlinks. Touches `backup.mjs`.
2. **Port reservation in code (finding 4):** `backup.mjs loadConfig` rejects the weekly port (55434 / `WEEKLY_TUNNEL_PORT`) and weekly rejects the backup port across both plists' values, or a shared constant. Touches `backup.mjs`.
3. **Step-fixture check (R4):** extract `stepFixtureError(cfg, env)` into `scripts/lib/weekly.mjs` with unit tests (fixture + real or unset weekly bin refused; fixture + repo fake allowed; fixture + copy of the fake refused; no fixture allowed). No drill variant.
4. **Sec notes 5, 6, 8:** stale reaper trusting `rec.port`; lock-takeover microsecond race (inherited from backup); `logs/weekly.log` permissions (`chmodSync(0o600)` per run or a README line).
5. **Drill diagnosability (finding 6):** reap fixtures and assert ports are free between cases, or stop at the first FAIL; applies to both drills.
6. **Redactor test (QA R-2):** strengthen the single-chunk test. Trivial; can ride with 3.
7. **Daily backup "another backup is running" notification at wake** (finding 8, plan §9): documented in `ops/launchd/README.md`; a code fix is a follow-up.

## F5. Owner items for Gate 2

1. **Merge approval** for PR #6 at `dac36c3` (CI 41709082436 green; QA, Sec and Lead all READY WITH CONDITIONS; no conditions block merge).
2. **`.env.example` (finding 5):** owner adds the commented lines in §2 finding 5 above. Agents cannot read that file.
3. **First manual real run is the real verification** (finding 8): run `npm run db:weekly` by hand with both flags, with the DB-Backups drive mounted. Watch `logs/weekly.log`, confirm the macOS notification, and check `ps` for leftover `ssh -L` / `railway` processes afterwards. Only then install the weekly plist (not loaded by this PR). The real CLI tunnel, two concurrent real tunnels, the refactored backup on the real CLI and the notification have not been exercised by any agent.
4. **Accept the known residuals:** two prod flags (the plist sets both); weekly depends on the DB-Backups drive; the daily backup may notify "another backup is running" at wake; the follow-ups in F4, specifically that a fake backup in the real folder (finding 2 backup half / R3-1) can still be reused until follow-up 1 lands.
5. Deploy needs no separate approval for this PR (no app deploy); installing the plist is the owner's own action after item 3.

## Handoff (final pass)

- **Done:** final Lead pass of PR #6 at `dac36c3`. Checked all four fix instructions against the diff (all done), confirmed `backup.mjs` unchanged, ran `npm test` (80/0), confirmed CI 41709082436 green. Accepted Sec R3-1 and the W23/R4 deviation as follow-ups; no fix cycle 2.
- **Files touched:** `docs/reviews/M5/lead.md` (appended this section; not committed). No source edits.
- **Open questions:** none for Dev. Owner: the Gate 2 items in F5.
- **Recommended next role:** Coordinator: log the F4 follow-ups in `docs/STATUS.md`, write the readiness report, and ask the owner for Gate 2 merge approval.
