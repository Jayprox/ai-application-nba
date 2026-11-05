# team-tests

Golden-mission harness for the AI team's own config (CLAUDE.md, agents, commands).
Plan: `docs/plans/M8-standing-decisions-and-team-tests.md` section 3. Requirements: Story 2.

Status: B1-B2. `src/paths.mjs`, `safe-rm`, `fixture`, `config-source`, `canary`, `env`, `shims/` and `templates/` exist; the CLI in
`bin/team-tests.mjs` is a stub that exits 2. Later tasks (B2-B7) add fixtures, missions,
checkers, dry run, reports and the guarded `run` path. Nothing here has run a real session.

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
