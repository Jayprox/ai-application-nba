# M4 Lead review: backup tunnel ssh child (PR #5)

- **PR:** #5, branch `fix/backup-ssh-child`, head `0e9c299` (`dc4174c` fixture/drill red + `0e9c299` fix). Base `main` `ee89270`.
- **Against:** `docs/plans/M4-backup-ssh-child.md` (M4-AC1..AC8), `docs/STANDARDS.md`, `docs/reviews/M4/qa.md` (READY WITH CONDITIONS), `docs/reviews/M4/security.md` (READY).
- **Run by Lead:** root `npm test`: 55 pass / 0 fail. Code read of `scripts/backup-db.mjs` (full), `scripts/lib/backup.mjs:201-315`, both fixtures, drill case list. CI run 41583974979 green (4/4, per Coordinator + Sec `gh pr checks 5`). Nothing run against Railway or production; `BACKUP_CONFIRM_PROD` not set; drill not re-run by Lead (QA and Sec each ran it: 99/0).

VERDICT: READY WITH CONDITIONS

Condition (in this PR, one fix cycle, drill-only): finding 1. Everything else is a follow-up.

## Plan conformance

| Plan item | Where | Result |
|---|---|---|
| §2.A snapshot (1) after ready, recorded in `tunnel.json` | `backup-db.mjs:350-353`, `:145-152` | Matches |
| §2.A snapshot (2) before railway is signalled | `:130` before `:133` | Matches |
| §2.B kill order: ssh TERM, railway SIGINT -> TERM -> KILL, ssh wait/KILL with re-verify, port post-check, one orphan sweep, `stage=cleanup` exit 2 | `:127-143`, `:86-97`, `:425` | Matches. Double SIGTERM to ssh (`:132` and `:87`) is harmless (Sec note 3) |
| §2.B exit handler ssh SIGKILL after sync re-verify | `:165-174` | Matches |
| §2.C stale-lock reaper with strict railway match; preflight orphan reaper | `:226-245`, `:319-323` | Matches |
| §2.D matchers / `reapDecision` pure and unit-tested | `lib/backup.mjs:216-290` | Matches. lsof uses `-Fpn` and requires exactly `n127.0.0.1:<port>` (`:301-309`): stricter than the plan's `-Fp`, accepted |
| §2.E fixed log strings only | `:262`, `:321`, `:425` | Matches |
| §3 fixture + drill (red then green) | QA: 45 failed at `dc4174c`, 99/99 at head | Matches |
| §4 T4 docs | `docs/backup-restore.md`, `docs/architecture.md:712-715,773`, `docs/plans/M3-backup.md:36` | Matches. Drill count 99 is correct |
| AC7 no new deps, absolute tool paths, `prodGuard` unchanged | `lib/backup.mjs:295,312`; `:128-139` untouched | Matches |

**Deviation: the fixture uses `/usr/bin/perl` setsid+exec, not a node launcher (`scripts/fixtures/fake-railway.sh:25-28`). Accepted.**
- It does what the plan asked: the forwarder has its own session and group (`pgid === pid`, like `process_group(0)`), its PPID is the fake, and `ps` shows argv0 `ssh`.
- It is simpler than the planned launcher. `exec` keeps the pid, so `$!` is the forwarder's real pid and `FAKE_RAILWAY_SSH_PIDFILE` is exact. A node launcher would have had to report its grandchild's pid.
- It is test-only. `/usr/bin/perl` ships with macOS, and the drill is already macOS-only (`hdiutil`, `lsof`) and not run in CI. Sec reviewed the list-form `exec`: there is no shell re-parse.
- The only cost is in finding 5: if perl is missing, `start_ssh` fails silently, because it runs in the background with stderr sent to `/dev/null`.

## Findings

**1. Minor (fix in this PR): the `FAIL stage=cleanup` path is never drilled.** This is QA finding 1.
- **Evidence:**
  - `scripts/backup-db.mjs:140-142` sets `portStillHeld`, `:425` throws `Fail('cleanup', …, 2)`, and `:180` appends the port note on other failures.
  - None of the drill cases reach this path: `grep -n "stage=cleanup" scripts/backup-drill.sh` returns nothing.
- **Why now and not later:** this path is the plan's mitigation for R1 and R5, where the real CLI's argv differs from what the matcher expects. That is the most likely way the owner's first real run after merge could go wrong. If it does, `stage=cleanup` exit 2 plus a notification is the only signal the owner gets. It should be proven before the owner relies on it.
- **Cost:** low, and there are no source changes. The existing knob already models it.
- **Fix:** add one drill case, e.g. "port still held after run (matcher miss)". Do a normal `run_case` with `FAKE_RAILWAY_SSH_LABEL_PORT=<some other free port>`. The forwarder listens on `$TP`, but its `-L` names another port, so `isRailwaySshForward` rejects it. Assert all of the following:
  - rc is 2
  - `last_log` contains `FAIL stage=cleanup reason="tunnel port $TP still in use after run"`
  - the new dump file is committed and there is no `.partial`
  - the lock is released
  - the mismatched forwarder is **still alive**, which proves the fail-safe direction
  - `secret_scan` passes

  Then kill the forwarder from `$WORK/ssh.pid`, check the port is free, and update the drill count in `docs/architecture.md:773`.
- **Re-review:** QA re-runs the drill. Sec re-review is not needed if the diff touches only `scripts/backup-drill.sh` and the docs count. If any of `scripts/backup-db.mjs`, `scripts/lib/backup.mjs` or the fixtures change, Sec re-reviews too.

**2. Minor (follow-up): `isRailwaySshForward` accepts extra forwarding and command options.** This is Sec finding 1.
- **Evidence:**
  - `scripts/lib/backup.mjs:225` rejects only the `-R` and `-D` prefixes.
  - Sec's probe accepted `-g`, `-o RemoteForward=…`, `-o DynamicForward=…`, `-o LocalForward=…`, `-o GatewayPorts=yes`, `-o ProxyCommand=…` and `-o RemoteCommand=…`.
- **Why a follow-up:** the code does what plan §2.D specified ("Extra tokens are allowed"). Every kill still requires all of these:
  - the same uid
  - exactly one `-L 127.0.0.1:<port>:127.0.0.1:n`
  - a listener on exactly `n127.0.0.1:<port>`
  - a target of `@ssh.railway*.com`
  - PPID 1 (or a verified railway parent)

  So only an owner-started ssh to Railway on the backup port whose parent has died could be hit, and that is already disclosed in plan §7.1. The fix is fail-safe and small, but it would cost a full QA + Sec cycle for very little risk reduction.
- **Fix (follow-up):** reject `-g`, and reject `-o` keys (case-insensitive) `RemoteForward`, `DynamicForward`, `LocalForward`, `GatewayPorts`, `RemoteCommand`, `PermitLocalCommand`, `LocalCommand`. Add a unit case for each.

**3. Minor (follow-up): the reaper signals ssh's whole process group.** This is Sec finding 2.
- **Evidence:** `scripts/backup-db.mjs:84` signals `-pid` when `pgid === pid`. The reaper paths at `:113-115` and `:243` use it too.
- **Why a follow-up:** plan §2.B chose the group on purpose. It is correct for the real CLI (`process_group(0)`, ssh alone or with its `ProxyCommand` child). The risk only exists when §7.1's scenario combines with an ssh that leads a shell pipeline whose other members are still alive after the parent shell died. That is very unlikely.
- **Fix (follow-up):** in the reaper paths only (`reapOrphanedSsh`), signal the group only if every member in the snapshot is the ssh or one of its descendants. Otherwise signal the pid alone. The descendant path (`doKillTunnel`) stays unchanged.

**4. Note (follow-up, hygiene): `lsof` inherits `process.env`; `osascript` is resolved via PATH.** This is Sec finding 6.
- **Evidence:** `scripts/lib/backup.mjs:312`; `scripts/backup-db.mjs:60`. The `osascript` lookup predates M4.
- **Fix:** pass `env: { PATH: '/usr/bin:/bin' }` to lsof and use `/usr/bin/osascript`. Batch this with finding 2.

**5. Note (follow-up): the drill depends on `/usr/bin/perl` without checking for it.**
- **Evidence:** `scripts/fixtures/fake-railway.sh:25` and `scripts/backup-drill.sh:355` both use `/usr/bin/perl`. Its stderr goes to `/dev/null` (`fake-railway.sh:28`).
- **Impact:** without perl, the drill would fail with confusing "tunnel did not come up" errors instead of a clear prerequisite message.
- **Fix:** add `[[ -x /usr/bin/perl ]] || { print "drill needs /usr/bin/perl"; exit 2; }` to the drill's prerequisite checks.

**6. Note: the fixture prints the URL before it starts the forwarder, while the real CLI starts ssh first.**
- **Evidence:** `fake-railway.sh:42-57`.
- **Impact:** none. Snapshot (1) runs only after `canConnect` succeeds (`backup-db.mjs:350`), so the forwarder already exists. Snapshot (2) covers the silent-ssh timeout path (drill line 213). No action needed.

**7. Note: the real CLI can only be verified by the owner's post-merge run** (QA condition b, plan §7.2, R5). This does not block merge. The Coordinator's readiness report must list it as the owner's verification step:
- run `BACKUP_CONFIRM_PROD=1 npm run db:backup`
- then check that both `lsof -nP -iTCP:55432 -sTCP:LISTEN` and `pgrep -fl 'ssh .*-L 127.0.0.1:55432'` print nothing

If the run ends with `FAIL stage=cleanup`, the matcher missed the real argv: open a bug and do not retry in a loop.

**8. Note: Sec notes 3 (second SIGTERM without re-verify), 4 (no `lstart` for the railway record) and 5 (railway group signals, unchanged from M3) are accepted as is.** Each needs pid reuse within seconds by a process of our own uid with the exact argv. They can go in the same follow-up as findings 2-4 if it is cheap.

## Decision summary

| Item | Decision |
|---|---|
| QA 1 / Lead 1: `stage=cleanup` not drilled | **Fix in this PR** (fix cycle 1 of 3; drill-only; QA re-runs the drill) |
| QA condition b / Lead 7: real CLI | Owner's post-merge run; list it in the readiness report |
| Sec 1 / Lead 2: matcher extra options | Follow-up |
| Sec 2 / Lead 3: group signal in reaper | Follow-up |
| Sec 6 / Lead 4, Lead 5 | Follow-up (hygiene) |
| perl launcher deviation | Accepted |

Once finding 1 is in and QA confirms the drill is green, with the new case passing and the count updated, this PR is READY from Lead's side, provided CI is green on the new head.

## Handoff

- **Done:** I did the final technical review of PR #5 against the M4 plan:
  - read the full code of the kill, reap and matcher paths
  - ran root `npm test` (55/55)
  - reconciled the QA and Sec verdicts
  - accepted the perl fixture deviation
- **Files created:** `docs/reviews/M4/lead.md` (not committed). No source files or `docs/STATUS.md` were edited.
- **Open questions:** none for the owner. The follow-ups (findings 2-5, and 8 optionally) should be tracked as one hardening item in STATUS.
- **Recommended next role:**
  - **Dev:** fix cycle 1, finding 1 (drill case + count).
  - **QA:** re-run the drill.
  - **Coordinator:** readiness report, with the owner's post-merge verification step (finding 7).
