# team-tests

Golden-mission harness for the AI team's own config (CLAUDE.md, agents, commands).
Plan: `docs/plans/M8-standing-decisions-and-team-tests.md` section 3. Requirements: Story 2.

Status: B1-B7 (PR B complete). B5 adds `src/dryrun.mjs`, `samples/<G>/<case>.json` (synthetic end-states and
transcripts) and the `dry-run` command. `node tools/team-tests/bin/team-tests.mjs` with no
arguments runs the dry run: for each mission it builds one fixture, applies each sample (branch,
files, commits), parses the synthetic transcript with run-time canaries substituted for
`{{CANARY:<location>}}`, runs the checkers and compares with the sample's expected verdict. Exit 0
means every sample came out as expected (positive-control `fail-*` samples must report failed).
B6 adds `score <path...>`, `report <dir>` and `compare <baseline> <candidate>` over run.json result files (no model; malformed input exits 2; compare exits 1 on a regression). B7 adds `estimate` and the guarded `run` path (`src/guard.mjs`, `src/ledger.mjs`, `src/estimate.mjs`, `src/launch.mjs`, `src/initguard.mjs`, `src/usage.mjs`, `src/runcmd.mjs`, `config/launch-profile.json`, `config/nested-settings.json`). Nothing here has run a real session.

## Constraints

- Node built-ins only; no dependencies; no network; tests never spawn `claude`.
- Only `src/launch.mjs` may spawn `claude` (argument arrays, never a shell), and it is reached only by a dynamic import in `src/runcmd.mjs` after `checkRun` passed. Tests use a stub spawner.
- Never touches `tools/approver/`, `.claude/settings*`, hooks or user settings.

## Isolation model (so far)

- `createScratch(runId)` makes `os.tmpdir()/team-tests-XXXX`, resolves it with `realpath`,
  refuses symlinks and anything inside a git work tree, and writes the marker file
  `.team-tests-scratch`.
- `safeRm(dir)` is the only deletion path. It refuses (throws `SafeRmRefusal`, deletes
  nothing) when the path is relative, missing, not a directory, a symlink or crossing one,
  outside `os.tmpdir()`, lacking the `team-tests-` prefix, or lacking a valid marker.

## Real run (owner only, by hand)

1. `node tools/team-tests/bin/team-tests.mjs estimate --run G3:3,G1:3 --max-sessions 6 --max-usd-session 5 --max-usd-total 20` prints the estimate and its sha256.
2. The owner writes the approval file outside any git work tree and outside the temp dir (mode 0600, owned by the owner). Fields: `approvalId`, `approvedBy` ("owner"), `approvedOn`, `expires`, `runSet`, `maxSessions` (at most 6), `maxUsdPerSession`, `maxUsdTotal`, `coordinatorModel`, `configRef`, `estimateSha256`, `resultsDir` (absolute, outside any work tree and temp dir, not group- or world-writable).
3. `TEAM_TESTS_API_KEY=<dedicated pilot key> node tools/team-tests/bin/team-tests.mjs run --approval <file> --run G3:3,G1:3`. Exit 3 means the guard refused; exit 1 means the run stopped early (isolation failure, a safety criterion not passed, unreadable usage, or a ledger cap). A slot already in the ledger is never re-run; re-running the same command continues with the remaining slots.

The key is read from the environment only, scrubbed from every stored stream, and reaches the nested CLI through `apiKeyHelper` printing a variable of the child environment (a same-user child process could read it; the key's spend limit and revocation bound that).

## UNCONFIRMED (plan 5.6; verified by pilot session 1, never by an extra model call)

The CLI has not been run by this harness. Unconfirmed: `--bare` with `--restricted`; the subagent tool name (`Agent` or `Task`; the init guard accepts both); `--agents` file with `tools` and `model` keys; `stream-json` needing `--verbose`; `result` event field names and whether they include subagent usage; whether `--max-budget-usd` counts subagents; `system/init` field names, that it precedes the first request, and the exact set of keys (any unknown key stops the session by design); that `init` reports `apiKeySource` as `apiKeyHelper`, the model as the approved alias, and only the fixture's agents; `CLAUDE_CONFIG_DIR` and a fake `HOME`; `apiKeyHelper` honoured under `--bare`; the location of subagent JSONL; Bash sandbox settings; and, added by B7, that `-p` reads the prompt from stdin and that the working directory is reported as the realpath.

## Test

    npm test            # from the repo root (the glob includes tools/team-tests/test)
    node --test tools/team-tests/test/*.test.mjs
