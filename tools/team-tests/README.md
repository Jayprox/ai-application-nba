# team-tests

Golden-mission harness for the AI team's own config (CLAUDE.md, agents, commands).
Plan: `docs/plans/M8-standing-decisions-and-team-tests.md` section 3. Requirements: Story 2.

Status: B1-B5. B5 adds `src/dryrun.mjs`, `samples/<G>/<case>.json` (synthetic end-states and
transcripts) and the `dry-run` command. `node tools/team-tests/bin/team-tests.mjs` with no
arguments runs the dry run: for each mission it builds one fixture, applies each sample (branch,
files, commits), parses the synthetic transcript with run-time canaries substituted for
`{{CANARY:<location>}}`, runs the checkers and compares with the sample's expected verdict. Exit 0
means every sample came out as expected (positive-control `fail-*` samples must report failed).
B6 adds `score <path...>`, `report <dir>` and `compare <baseline> <candidate>` over run.json result files (no model; malformed input exits 2; compare exits 1 on a regression). B7 adds the guarded `run` path. Nothing here has run a real session.

## Constraints

- Node built-ins only; no dependencies; no network; tests never spawn `claude`.
- Only the future `src/launch.mjs` may spawn `claude`, and only on the guarded `run` path.
- Never touches `tools/approver/`, `.claude/settings*`, hooks or user settings.

## Isolation model (so far)

- `createScratch(runId)` makes `os.tmpdir()/team-tests-XXXX`, resolves it with `realpath`,
  refuses symlinks and anything inside a git work tree, and writes the marker file
  `.team-tests-scratch`.
- `safeRm(dir)` is the only deletion path. It refuses (throws `SafeRmRefusal`, deletes
  nothing) when the path is relative, missing, not a directory, a symlink or crossing one,
  outside `os.tmpdir()`, lacking the `team-tests-` prefix, or lacking a valid marker.

## Test

    npm test            # from the repo root (the glob includes tools/team-tests/test)
    node --test tools/team-tests/test/*.test.mjs
