# Lead review: M3-backup (PR #4)

`VERDICT: READY WITH CONDITIONS`

The conditions are the fix cycle 3 items below (required before merge) and the owner items before T6.

## 1. Scope and evidence

- **PR:** #4, branch `feat/db-backup`, head `1f3a027e3da999da027f2d44b2799919186b3ff7`.
- **CI:** `gh run view 41480681670` reports headSha `1f3a027…` and conclusion `success`. All four jobs passed: root, backend, worker and frontend.
- **Diff reviewed:** the full `git diff main...1f3a027` (15 files, +1553/−1). I read these in full:
  - `scripts/backup-db.mjs`, `scripts/lib/backup.mjs`, `scripts/backup-drill.sh`;
  - `scripts/fixtures/fake-railway.sh`, `scripts/backup-db.sh`, the plist;
  - `docs/backup-restore.md`;
  - the diffs to `README.md`, `docs/architecture.md`, `ops/launchd/README.md`, `package.json` and `docs/STATUS.md`;
  - the names of the tests in `scripts/lib/backup.test.mjs`.
- **Checked against:**
  - the requirements: "Mission M3-backup" in `docs/STATUS.md` and the owner's `BACKUP_CONFIRM_PROD=1` opt-in;
  - the plan: `docs/plans/M3-backup.md` §2–§11;
  - `docs/STANDARDS.md`;
  - the verdicts: `docs/reviews/M3-backup/qa.md` and `security.md`, both READY WITH CONDITIONS after cycle 2.
- **Commands run:**
  - `npm test` (root): `tests 47, pass 47, fail 0`.
  - `gh pr view 4`, `gh run view`, and read-only git.
- **Not run, per the hard rules:** the real `railway` CLI, `db:backup` and the drill. The drill result (59/59) comes from QA's re-verification and the PR body.

## 2. Assessment

**Requirements.** Every point in the mission is met:
- The dump goes through the CLI SSH tunnel, with no public proxy.
- Dumps are timestamped and compressed (`--format=custom` compresses by default).
- They are stored off-repo on `/Volumes/DB-Backups/db-backups`.
- The newest N are kept (14).
- Each run logs one OK or FAIL line.
- There are no credentials in the repo (QA AC1).
- The restore procedure is in `docs/backup-restore.md`, and was tested only against throwaway `postgres:18` containers (QA ran step (b) as written).

The owner's production opt-in is met. `prodGuard` is the first step of `preflight` (`backup-db.mjs:177-178`), before the drive check, the lock and any CLI call. Without the exact value `1` it fails closed, and only the repo's fake is exempt, by realpath (`backup.mjs:127-138`).

**Plan conformance.** D-a through D-i are implemented as planned:
- the env-only credential flow with an allow-listed pg_dump env (`backup.mjs:105-114`);
- the localhost and requested-port identity check (`backup.mjs:81-82`);
- the port-free check (`backup-db.mjs:213`);
- the device-ID mount check before any network access (`backup-db.mjs:182-195`);
- write, validate, rename and fsync, then rotate (`:258-292`);
- the process-group kill on every catchable path (`:58-83`, `:95-97`);
- the `mkdir` lock (`:146-166`);
- the one-line log with redacted stderr (`:89`, `:255`).

**Deviations.** I accept all six in the PR body. Each is small, has a stated reason, and leaves the plan's security properties intact:
- Tunnel output on stderr. This is recorded in `docs/backup-restore.md:41-43`.
- `BACKUP_NOTIFY`.
- A forwarding fake.
- `realpathLoose` following dangling symlinks.
- The lock next to `BACKUP_LOG`.
- No CI change.

Cycle 2 also added three hardening items beyond the plan: the TM device deny, the PGID reaper and the allow-list guard. They answer Security findings, and none of them changes the architecture.

**Code quality and STANDARDS.**
- Plain ESM `.mjs` with no new dependencies.
- Pure helpers live in `scripts/lib/` and have `node:test` tests that CI picks up through the glob.
- The style matches the repo: dense one-liners, and comments that explain *why*.
- `scripts/lib/env.mjs` is not imported.
- Docs were updated in the same change (README table, `docs/architecture.md` §8 and §9.3), as STANDARDS §5 requires.
- The module-level mutable state in `backup-db.mjs` (`tunnel`, `activeChild`, `secrets`, `stage`) is acceptable for a single-run CLI script. Cleanup is idempotent (`finishing` flag, `tunnel = null` before the kill).

## 3. Findings

### 1. Minor (fix cycle 3): the drill inherits `BACKUP_RAILWAY_BIN` and `BACKUP_CONFIRM_PROD` from the caller's shell (Sec R3.1, confirmed by my code read)

- **Evidence:** every launch is `env $LE node scripts/backup-db.mjs` (`scripts/backup-drill.sh:104`, `:204`, `:221`, `:242`). `build_env` (`:90-103`) validates only the assignments in `LE`, and `--no-bin` removes the bin from `LE` (`:93`). `env` without `-i`/`-u` passes the caller's exports through. So in `guard_run --no-bin` (`:205`), an exported `BACKUP_RAILWAY_BIN=<real railway>` plus `BACKUP_CONFIRM_PROD=1` reaches `prodGuard`, which allows the run, and then `resolveRailway` (`backup-db.mjs:169`).
- **Why it must be in this PR:** the drill is the harness agents run routinely, and this is the same failure class as the disclosed incident. The comment at `:72` ("the real railway binary can never be reached from here") is only true for a clean caller shell. The fix is a few lines and touches the drill only.
- **Fix:** see Fix cycle 3, item A.

### 2. Minor (fix cycle 3): the guard approves one path, and the script spawns another spelling of it (Sec R3.2 and R3.3)

- **Evidence:**
  - `prodGuard` resolves `BACKUP_RAILWAY_BIN` with `realpathSync.native` against the process cwd (`backup.mjs:132`).
  - `resolveRailway` returns the raw string (`backup-db.mjs:169`). That string is spawned for `whoami` (`:209`, which uses the PATH lookup for a bare name) and for `connect` (`:218-219`, with `cwd: REPO_ROOT`).
  - So a bare `fake-railway.sh` is exempt by cwd but executed from PATH, and a symlink can be retargeted between the check and the spawn.
- **Why now:** the guard is the owner-requested control added after the incident. "What the guard approved is exactly what runs" should hold by construction, not because nobody tries to break it. The fix is two small changes plus one unit test. The production default path (`BACKUP_RAILWAY_BIN` unset) does not change.
- **Fix:** see Fix cycle 3, item B.

### 3. Minor (fix cycle 3, PR text only): the PR body still describes the cycle-1 name-based guard

- **Evidence:** the PR body, section "Guard added (fix cycle 1, owner-directed)", says the run is exempt "unless `BACKUP_RAILWAY_BIN` is set to an executable whose name, and whose symlink target's name, is not `railway`". Since cycle 2 the rule is a realpath allow-list of the repo fixture (`backup.mjs:119-138`). The text "the fake (`exec node`)" is also stale: `fake-railway.sh:38-51` no longer uses `exec`.
- **Why it matters:** the owner approves the merge from this description.
- **Fix:** see Fix cycle 3, item C. This is not a source change.

### 4. Note (follow-up): the reaper's argv match could be stricter (Sec R3.4)

- **Evidence:** `backup-db.mjs:139` matches only `railway`, `connect` and `--tunnel-only`.
- **Assessment:** this fails safe. The window is a dead lock owner plus a reused PGID.
- **Follow-up:** also require `-P <cfg.port>`, or compare the process start time with the mtime of `tunnel.pgid`.

### 5. Note (follow-up): the reaper's negative paths are not tested (QA R5.2)

- **Evidence:** QA's decoy harness was denied by the permission system, so only a code read covers `backup-db.mjs:133-144`.
- **Follow-up:** add a drill case that writes a non-railway decoy PGID into a stale lock and asserts the decoy survives.

### 6. Note (follow-up): the `pg_restore --list` capture is capped at 256 KB

- **Evidence:** `backup-db.mjs:105` caps stdout at `BUF_CAP * 4`, and `:265` searches it for `TABLE DATA public teams`.
- **Assessment:** the production schema is about 16 tables, so the TOC is a few KB and this is not a risk today. If the schema grows a lot, a valid dump could fail `stage=validate`, which fails safe.
- **Follow-up:** match while streaming, or raise the cap.

### 7. Note (follow-up): small hardening items from Security

- The `mkdir` lock race and PID reuse (Sec finding 8). Accepted; document how to clear a stale lock.
- Pin the `postgres:18` drill image by digest (Sec §3).
- Optionally `chmod 700` an existing `BACKUP_DIR` in preflight (Sec finding 6).

None of these is needed before merge.

### 8. Note (owner, before T6; does not block merge)

- Sec finding 5 and QA AC14: after the disclosed pre-guard incident, check the SSH keys on the Railway account and confirm that no project resources or variables changed.
- Sec finding 6: decide whether to encrypt `DB-Backups` and whether to enable "Owners".
- Confirm the Railway service name is `Postgres`, or set `BACKUP_PG_SERVICE` (plan §9.2).
- T6, the first production run, needs its own owner approval. Install the plist only after that run succeeds.

### 9. Note: housekeeping for the Coordinator

- The `docs/STATUS.md` task boxes T2–T5 are still unchecked on the branch.
- The STATUS intake line says the tunnel "prints … to stdout". The source shows stderr, which is a recorded deviation.
- Update both when STATUS is next edited. No Dev action is needed.

## 4. Fix cycle 3 scope

This is the last allowed cycle (2 of 3 are used). The scope is limited to these three items. Anything else found during this cycle goes to the follow-up list, unless it is a Blocker.

**A. Make the drill hermetic (finding 1).** Change `scripts/backup-drill.sh` only.
- Every launch of `backup-db.mjs` (`:104`, `:204`, `:221`, `:242`) must go through one helper that drops inherited values. Two acceptable ways:
  - `env -u BACKUP_RAILWAY_BIN -u BACKUP_CONFIRM_PROD -u BACKUP_PG_SERVICE -u BACKUP_RAILWAY_ENV $LE node …`;
  - or `env -i` with explicit `HOME`, `PATH`, `TMPDIR` and `LANG` plus `$LE`.
- If `PGBIN` came from the caller, pass it explicitly as `BACKUP_PG_BIN_DIR=$PGBIN` in `BENV`.
- **Done when:** a new drill case exports `BACKUP_RAILWAY_BIN=$SHADOW/railway` and `BACKUP_CONFIRM_PROD=1` (the shadow, never the real CLI) and then runs `guard_run --no-bin`. The case asserts the run is refused with the "production run not confirmed" line and that `shadow.calls` does not exist. It then unsets both values. The drill reports all PASS.

**B. Spawn exactly what the guard approved (finding 2).** Change `scripts/lib/backup.mjs`, `scripts/backup-db.mjs` and the tests.
- `loadConfig` rejects a non-empty `BACKUP_RAILWAY_BIN` that is not absolute. The message is a fixed string, for example `BACKUP_RAILWAY_BIN must be an absolute path`, and the result is the existing `FAIL stage=preflight reason="bad configuration: …"`.
- When `BACKUP_RAILWAY_BIN` is set, `resolveRailway()` returns `fs.realpathSync.native(cfg.railwayBin)`, so `whoami` and `connect` both spawn the resolved file. The unset path, which is production, does not change.
- In `docs/backup-restore.md:62`, say "absolute path".
- **Done when:**
  - a unit test covers the relative-path rejection, and root `npm test` passes;
  - the drill passes, including the reaper case, whose `/railway/i` match must still hit the resolved fixture path;
  - CI is green on all 4 jobs.

**C. Correct the PR description (finding 3).** Rewrite the guard paragraph to describe the realpath allow-list, remove the "`exec node`" wording, and add a short "Fix cycle 3" section with the new drill count.

**Re-review after cycle 3:**
- QA re-runs `npm test` and the drill.
- Security re-reviews only the A and B delta.
- Lead checks the delta against this list.

Under CLAUDE.md, any disagreement after this cycle goes to the owner.

**Follow-ups, not in cycle 3:** findings 4, 5, 6 and 7. The Coordinator should list them in STATUS as M3 follow-ups.

## 5. Verdict

`VERDICT: READY WITH CONDITIONS`

The implementation meets the approved mission, the owner's opt-in and the plan, with acceptable recorded deviations. CI is green on the head, root tests pass 47/47, and QA's drill passes 59/59. The conditions:
1. **Before merge:** fix cycle 3 items A, B and C, with QA and Security re-checks of the delta.
2. **Before T6:** the owner completes the items in finding 8.

---

## Handoff

- **Done:** Lead review of PR #4 at `1f3a027`: the full diff against the mission, the owner guard, the plan and STANDARDS; QA and Security verdicts read; root `npm test` 47/47; CI run 41480681670 confirmed green on the head SHA. No source edits, no commit, and the real `railway`, the backup and the drill were not run.
- **Files created:** `docs/reviews/M3-backup/lead.md` (not committed).
- **Open questions:**
  - Owner, before T6: Railway SSH keys and resources after the incident, `DB-Backups` encryption and ownership, the `Postgres` service name, and the T6 approval.
- **Recommended next role:** Dev for fix cycle 3 (items A–C), then QA (drill and `npm test`) and Security (delta), then Lead delta check, then the Coordinator readiness report.
