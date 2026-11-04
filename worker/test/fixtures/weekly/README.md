# Weekly job fixtures (M6)

No live recording was authorised (owner Q5 not approved). Every file here is either a copy of a
fixture that was recorded earlier (read-only dry-run files) or **synthetic**, and is labelled so.

## Recorded (copies, unedited)

`recorded/` holds copies of `../matches_2026-04-12.json`, `../matches_2026-10-06.json`,
`../box-score_1439038.json` and `../lineups_1439038.json` (MEM @ HOU, 2026-04-12, verified against
NBA.com when they were recorded).

## Synthetic

Synthetic data is built only by editing the recorded shapes (same field names), never by inventing a
format. Error answers (401, 429, 5xx, malformed bodies) are synthetic: their *bodies* are made up and
the code never reads them; only the status code and the `x-ratelimit-*` / `retry-after` headers matter.

| Path | What it is |
|---|---|
| `synthetic_paginated/matches_2026-11-05.json`, `@100.json` | 112 matches over two pages (recorded match shape, ids 9000000+). |
| `synthetic_*` temp dirs built in tests (`test/helpers/fx.js`) | Edited copies of the recorded matches/box score: shifted tip-offs, postponed, exhibition side, 404 box score, errors, `_quota.json`. Created under the OS temp dir at run time. |
| `synthetic_drill_*` (added with the drill, T9) | Directories used by `scripts/weekly-drill.sh`. |

A fixture directory is read by `src/hl-fixture-fetch.js` (`HIGHLIGHTLY_FIXTURES=<dir>`): `<name>.json`
per request, `<name>@<offset>.json` for page 2+, optional `<name>.meta.json`
(`{status, headers, retryAfter, rawBody, delayMs}`) and an optional `_quota.json` (`{limit, remaining}`)
that is decremented per call to simulate the rate-limit headers.
