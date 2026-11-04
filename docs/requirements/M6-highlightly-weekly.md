# M6: Weekly job on Highlightly (NBA.com best-effort)

STATUS: APPROVED by the owner 2026-11-03 (final answers to Q1-Q11 in `docs/STATUS.md`, M6 Approvals)

Author: Product Analyst. Date: 2026-11-03. Branch: `feat/m6-highlightly-weekly`.
Inputs read: `scripts/lib/sources.mjs`, `scripts/weekly.mjs`, `scripts/lib/weekly.mjs`, `scripts/load-schedule.mjs`, `scripts/load-positions.mjs`, `scripts/backfill.mjs`, `scripts/db-status.mjs`, `worker/src/*.js`, `db/schema.sql`, the four recorded Highlightly fixtures in `worker/test/fixtures/`, `docs/architecture.md` §3.1/§3.2/§7.4, `docs/vibe-coding-checklist.md`, `logs/weekly.log`. No live API, database, `.env` or `.env.example` was touched.

## 1. Goal

The first real weekly run (2026-11-03) died at `stage=schedule` because `stats.nba.com` hangs and `cdn.nba.com` returns Akamai "Access Denied" from the owner's home wifi and cellular (`logs/weekly.log:5-6`). The weekly job (schedule, positions, backfill `--season 2026-27`, status) must finish on an ordinary week using Highlightly, whose key and quota the app already pays for and which is reachable, as the primary source. NBA.com stays as a best-effort enrichment and reconcile source that is tried quickly, skipped cleanly when blocked, and never required for the run to succeed. Existing behaviour that works (the tunnel/backup/guard flow from M5, NBA.com reconcile when reachable, the ingestion worker) must not be removed or weakened, and good data in the database must never be overwritten with worse or empty data.

## 2. Findings

### 2.1 Loaders the weekly stages call that depend on NBA.com

Weekly step table: `scripts/lib/weekly.mjs:21-26` (schedule, positions, backfill, status). Step loop: `scripts/weekly.mjs:267-275`; any non-zero exit fails the run (`weekly.mjs:274`).

Correction to the mission wording: the weekly job never touches `cdn.nba.com`. Its only caller, `nbaSchedule()` (`sources.mjs:70-73`), is used by `seed.mjs:41` only. Every weekly call goes to `stats.nba.com` through `nbaStats()` (`sources.mjs:40-46`). The log confirms it: `https://stats.nba.com/stats/scheduleleaguev2 failed after 3 attempts` (`logs/weekly.log:5`). (§3.1 of the architecture doc describes the cdn file as the schedule source; the code uses the stats endpoint.) cdn.nba.com being blocked matters only for `db:seed`.

| Weekly stage | Script and call site | Loader (`sources.mjs`) | NBA.com endpoint | Calls |
|---|---|---|---|---|
| schedule | `load-schedule.mjs:34` | `nbaScheduleSeason` (76-79) | stats `scheduleleaguev2` | 1 |
| positions | `load-positions.mjs:19` | `nbaPlayerIndex` (61-64) | stats `playerindex` (Historical=1, season 2025-26) | 1 |
| backfill | `backfill.mjs:44` | `nbaScheduleSeason` | stats `scheduleleaguev2` | 1 |
| backfill | `backfill.mjs:45` | `nbaStandings` (54-56) | stats `leaguestandingsv3` | 1 |
| backfill | `backfill.mjs:51-52` (types Regular Season, Playoffs, PlayIn, IST; 2026-27 qualifies for all four per `backfill.mjs:43`) | `nbaGameLog` (81-85) | stats `leaguegamelog` T and P | 8 |
| backfill | `backfill.mjs:56-57` (Pre Season anchors for rest days) | `nbaGameLog` | stats `leaguegamelog` T and P | 2 |
| status | `db-status.mjs` | none (database only; reads the worker's stored Highlightly quota, lines 30-40) | none | 0 |

Total: 14 `stats.nba.com` requests per weekly run. Each fails slowly: 3 attempts x 30 s timeout + 1.5 s + 3 s back-off (`sources.mjs:17-28`) is about 95 s per call (log: 23:28:06 to 23:29:44 = 98 s). If NBA.com were simply "tried" as it is today, a fully blocked network costs about 14 x 95 s = 22 min and still fails the stage.

Not on the weekly path but NBA.com-dependent: `nbaStandings`/`load-standings.mjs:24`, `nbaAllPlayers`, `nbaRoster`, `nbaSchedule` (cdn), all `seed.mjs`. Out of scope (see §4).

### 2.2 What the app already knows about Highlightly

- Client: `worker/src/highlightly.js` (endpoints `/matches?league=NBA&date=&timezone=America/New_York&limit=100&offset=`, `/matches/{id}`, `/box-score/{id}`, `/lineups/{id}`; reads `x-ratelimit-requests-limit/remaining` headers; 20 s timeout; 404 returns null). Script-side: `sources.mjs:88-94` `highlightlyMatches(date, key)` has no pagination, no quota read, no `limit` parameter. Direct key goes to `nba.highlightly.net`; a RapidAPI key (contains `msh`) goes to the RapidAPI host.
- Dry-run (architecture.md §3.1, 2026-09-26) also probed `/players?name=`, `/players/{id}/statistics`, `/standings?leagueName=NBA&year=2025` (returned empty), and found no injuries and no broadcaster data. Raw responses were saved to a gitignored folder and are not in the repo; only four fixtures are committed.
- Recorded fixtures available for tests: `matches_2026-04-12.json` (15-ish finished games), `matches_2026-10-06.json` (4 preseason games, `state.description: "Scheduled"`), `box-score_1439038.json`, `lineups_1439038.json` (MEM @ HOU). A `/matches` item has only: `id`, `league`, `season` (end year: 2027 = 2026-27), `state{clock,score{homeTeam[],awayTeam[]},period,description}`, `homeTeam{id,displayName,name,logo,abbreviation}`, `awayTeam{...}`, `date` (UTC ISO). The response also carries `plan.tier: "PRO"` and `pagination`.
- No fixture contains an error body (401/403/429/5xx) or a `/players`, `/standings` or `/teams` response.
- Public docs (WebSearch; the endpoint reference and OpenAPI file were not retrievable): Highlightly lists live scores, box scores, player profiles and per-season stats, lineups, standings, NBA Cup and play-in coverage. The docs describe a daily request quota plus a per-second rate per tier. Free tier is 100 requests/day. I could not confirm field-level venue, broadcaster, or Cup-stage data, so treat those as absent until a recorded response proves otherwise.

### 2.3 Field-level coverage (Highlightly vs NBA.com)

Legend: Yes = proven in repo fixtures or dry-run notes; Unverified = documented or plausible but no recorded response; No = not in any known payload.

| Data / DB column | NBA.com source today | Highlightly | Gap and consequence |
|---|---|---|---|
| Game teams, tip-off time (`games.home/away_team_id`, `tipoff_utc`) | `scheduleleaguev2` | Yes: `/matches` `homeTeam.id`, `awayTeam.id`, `date` (UTC) | Team ids map through the `highlightly` team rows already seeded in `entity_id_crosswalk` (30 rows; `seed.mjs:258`; `worker/src/sync.js:11-14`). Neutral-site listings can flip home/away (`sync.js:49`). |
| Status and score (`status`, `home_score`, `away_score`) | game logs | Yes: `state.description`, per-period score arrays (`worker/src/map.js:5-19`) | Already handled by the worker. |
| Game ID and mapping | NBA.com `gameId` (10 chars, e.g. `0022600123`) is the canonical key: `entity_id_crosswalk(entity_type='game', source='nba_stats')` -> `games.id` (UUID) (`load-schedule.mjs:59-62`, `backfill.mjs:141-144`) | Numeric match id (e.g. 1545655), no type prefix | Highlightly ids are linked lazily to an existing game by team pair + tip-off within 8 h, stored as `source='highlightly'`, `match_method='teams+tipoff'` (`worker/src/sync.js:17-33`). Highlightly can therefore update games that already exist; it cannot supply the NBA id. A game created from Highlightly alone would have no `nba_stats` crosswalk row, and a later NBA.com schedule load would create a duplicate (it looks up by NBA id only). |
| Season type (`preseason / regular / cup_final / play_in / playoffs`) | NBA id prefix 001/002/004/005/006 (`load-schedule.mjs:25`, `tagging.mjs:6`) | No field seen on `/matches` | Cannot be derived for new games. For existing games it is already stored. Season: `season` is the end year (2027 = 2026-27), derivable. |
| Cup stage (`cup_stage`) | `gameSubtype/gameLabel/gameSubLabel` (`tagging.mjs:62-73`) | No | Cannot be set. Group-stage rows exist already. Knockout games (placeholders with no teams, skipped by `load-schedule.mjs:43`) need NBA.com or a manual step to appear. |
| National TV (`national_tv_tier`, `national_broadcasters`) | `broadcasters.nationalBroadcasters` (`tagging.mjs:45-59`) | No (dry-run: "No broadcaster data") | Keep existing. TV schedules change, so stored values go stale without NBA.com; accepted degradation. |
| Arena (`arena_id`, `arenas`) and neutral site (`is_neutral_site`) | `arenaName/arenaCity/arenaState/isNeutral` (`arenas.mjs:26-42`, `tagging.mjs:19-27`) | No venue field seen | Keep existing. Elevation is a separate free source (Open-Meteo, `arenas.mjs`) and unaffected. |
| Local game date (`game_date_local`) | `homeTeamTime` (`tagging.mjs:76-81`) | Only UTC `date`; query `timezone=America/New_York` | A 10:30 pm PT tip lands on the next ET/UTC day (architecture.md §3.1: back-to-back tagging must use the local date). Do not derive `game_date_local` from the ET date for west-coast games unless the home team's timezone is known. |
| Rest days / back-to-back (`team_games.rest_days`, `b2b_night`) | computed from dates in the loaders | Derived; not a vendor field | Can be recomputed from stored games when a tip-off date changes. |
| Positions (`players.listed_position`: G, F, C, G-F, F-C) | `playerindex` POSITION (`positions.mjs:5-12`) | Partly: `/lineups/{id}` gives `positionAbbreviation` PG/SG/SF/PF/C/G/F per player, bench included (`lineups_1439038.json`). A player-profile position is plausible but unverified. | Lineup positions look like slot labels, not roster listings (fixture: Josh Okogie "Point guard", Jeff Green "Forward"), so they are noisy. No hybrid values (G-F, F-C). Only players who appeared in a game are reachable, and the blank list is "mostly retired players" (`load-positions.mjs:2-3`), whom Highlightly lineups never include. Current-season players already have a roster listing from the seed. |
| Minutes (`player_game_stats.minutes`, `team_games.minutes`) | `MIN` | Yes: "Total Minutes Played" (integer, e.g. 26) | Verified exact on 18 players vs NBA.com (architecture §3.1). Whole minutes only; NBA.com `MIN` can be fractional, so the backfill compare allows 1 minute (`backfill.mjs:254`). Team minutes are computed (`map.js:22`). |
| Plus/minus | `PLUS_MINUS` | Yes: "Plus Minus" (e.g. 11) | Verified. Team plus/minus computed from the final score (`sync.js:127`). |
| Other 15 box-score columns, starters, DNP | `leaguegamelog` | Yes (17 stats in `map.js:25-43`, starters from `/lineups`, DNP as empty statistics) | Highlightly includes DNP rows with null stats; NBA.com omits them. Already handled. |
| Standings rank (`team_seasons`) | `leaguestandingsv3` | No: `/standings?...&year=2025` returned empty (param format unknown) | Rank is optional: the app falls back to win percentage with a note when no rank matches our W-L (architecture §7.5). Skipping standings is a tolerable degradation. |
| Playoff series / play-in structure | `buildSeries` from game ids (`backfill.mjs:122-138`) | No | Not needed for 2026-27 until April. Out of scope for now; flag in risks. |
| Players not in the roster seed | NBA ids | Highlightly player id, name only | Worker already resolves, links, or holds them (`worker/src/players.js`, `docs/architecture.md` §7.4). Reuse as is. |

Summary: Highlightly fully covers game results, box scores, minutes, plus/minus, starters and DNPs. It partly covers schedule times and status for games we already have. It cannot supply arena, neutral site, national TV, Cup stage, season type, standings rank, series structure, or historical positions. Those columns must be preserved, not nulled, when the source is Highlightly.

### 2.4 Quota

Documented facts:
- Plan and header: PRO, `x-ratelimit-requests-limit: 7500`, period never confirmed (architecture.md §3.1; checklist line 116 "period TBC"). The worker logged `7,466/7,500` on its first run (checklist line ~351), which does not settle the period.
- Public docs describe a daily quota and a per-second rate for each tier; the free tier is 100/day. A "7,500 requests/day PRO" figure also appears for a different vendor (API-Sports), so the number should be confirmed on the owner's Highlightly dashboard before it is relied on.
- Worker design assumes it might be monthly: "Estimated < 4,500 requests/month even if the 7,500 quota is monthly" (architecture.md §7.4). Low-quota mode below 500 remaining slows polling to 30 min (`worker/src/planner.js:15-16`). The Odds API has its own, separate credits.

Existing spend (worker, one key shared with the weekly job):
- Polls: one `/matches` per active ET date every 5 min while a game is in its window (tip-10 min to tip+8 h, not final) (`planner.js:31-35`).
- Per final game: `/box-score` + `/lineups` = 2 requests, and one re-check 3 h later = 2 more, so 4 per game (`sync.js:61,73`; `highlightly.js:44-46`).
- Daily sweep: yesterday + today (+ up to 5 stale dates): 2 to 7 requests (`planner.js:48-50`).
- Estimate, assumptions: a game day averages about 60 polls (a slate runs about 5 h; fewer on light days, up to about 72 on full ones); about 28 game days and about 190 games per month in season (1,230 games over about 6.5 months); about 3 re-check polls per day.
  - Polls: 28 x 60 = 1,680. Box and lineups with re-check: 190 x 4 = 760. Sweeps: 30 x 3 = 90. Re-check polls: 28 x 3 = 84.
  - Total about **2,600 per month (about 90 per day average, peak day about 200)**. The repo's own ceiling is 4,500 per month.

Weekly job, proposed Highlightly design (PA assumptions for sizing; the Lead may change the design, but the budget must hold):
- Schedule: one `/matches` per ET date in a rolling window, 7 days back to 60 days ahead = 68 requests (1 request per date; no day has more than 100 matches). First run only, a full-season sweep 2026-10-06 to 2027-04-12 = 26 + 30 + 31 + 31 + 28 + 31 + 12 = 189 requests. Highlightly's schedule horizon is unknown (it had 10-21 loaded on 09-26).
- Positions: 0 requests if skipped or taken from data already stored; if lineups are used for recent finals, about 52 (typical week: about 7.5 games/day x 7) to 105 (15-game days).
- Backfill (current season, Highlightly reconcile): the 7 dates reuse the schedule window responses (0 extra when a per-run cache is used; 7 if not). Box and lineups only for final games whose box score is missing or unchecked: typical 5 games = 10 requests; worst case the worker was down all week = about 52-105 games x 2 = 104-210 requests.
- Status: 0.

| Scenario | Schedule | Positions | Backfill | Status | Weekly total |
|---|---|---|---|---|---|
| Typical week (worker healthy, positions from NBA.com or skipped) | 68 | 0 | 10 | 0 | **about 80** |
| Typical week, positions from lineups | 68 | 52 | 10 | 0 | **about 130** |
| Worst week (worker down, busy slate, positions from lineups) | 68 | 105 | 210 | 0 | **about 385** |
| First run (full season sweep, worst week otherwise) | 189 | 105 | 210 | 0 | **about 505** |

Comparison against 7,500:
- If 7,500 is per day: worker 90/day avg (200 peak) + a weekly run of 80 to 505 = at most about 705 of 7,500, under 10%. No issue.
- If 7,500 is per month (worst case): worker 2,600 to 4,500 + 4.3 weekly runs x (80 to 385) = +344 to +1,656, giving 2,944 to 6,156 (39% to 82%); the first full-season run adds up to about 505, giving up to about 6,660 (89%). Leaves roughly 840 to 4,500 for ad hoc work (dry-runs, `worker sync --date`, injuries probe). Tight in the worst case but within budget. A run-level cap and a reserve (below) prevent it from starving the worker's live polling.
- Unknown: the quota's reset timing and the per-second rate. Observed latency is 0.5 to 1.1 s per request, so 385 sequential requests take about 3 to 7 minutes, well inside the 3,600 s step timeout (`lib/weekly.mjs:51`).

## 3. Scope

### In scope
1. Schedule stage sourced from Highlightly: keep existing game rows current (tip-off time, status, postponements), report unmatched matches. Preserve every column Highlightly cannot supply.
2. Backfill stage for the current season sourced from Highlightly: catch up final-game box scores, player minutes/plus-minus and statuses the worker missed, with the existing `source` precedence rules.
3. Positions stage: complete without a hard NBA.com dependency; fill only blanks, never overwrite.
4. Status stage unchanged except for reporting the new facts (source used, fallback, quota).
5. NBA.com kept as best-effort: fast-fail probe, skipped cleanly when blocked, and used exactly as today when reachable (enrichment of arena/TV/Cup/season type, reconcile that overwrites Highlightly rows, standings rank).
6. Quota guardrails, logging and notifications, fixture-only automated tests.

### Out of scope
- `db:seed`, `db:standings` (standalone), `db:review`, one-time historical backfill (2003-04 to 2025-26): these stay NBA.com-only and manual.
- Fixing the owner's network block or routing NBA.com through a proxy/VPN.
- Playoff/play-in series building for 2026-27 (April 2027).
- Injuries (still unconfirmed, §3.2).
- Changes to the worker's cadence, the M5 backup/tunnel/guard logic, the production deploy, the launchd plist.
- Any live call to Highlightly, NBA.com or production during requirements, planning or tests, unless the owner approves a named recording session (Q5).

## 4. User stories and acceptance criteria

IDs are for QA traceability. "Fixture" = recorded or clearly labelled synthetic JSON under a fixtures directory, read through the existing `SEED_FIXTURES` / `HIGHLIGHTLY_FIXTURES` style switch.

### US-1: The weekly run completes while NBA.com is unreachable
As the owner, I want `npm run db:weekly` to finish with a clear result when NBA.com is blocked, so that I stop getting a failed run and a failure notification for a problem I cannot fix.

1. Given NBA.com is unreachable (every NBA.com request times out or returns 403) and Highlightly responds normally, when the weekly job runs against a test database, then all four stages run and the process exits 0.
2. The final log line is distinguishable from a fully clean run: it states the run was degraded and names which NBA.com-only enrichments were skipped (for example `OK-DEGRADED ... skipped=nba:arena,tv,cup,standings`). A fully clean run keeps the current `OK season=...` line.
3. The macOS notification text no longer says "Weekly NBA.com run OK". It distinguishes OK, OK with warnings, and FAILED.
4. Given Highlightly is also unreachable, when the job runs, then the stage that needed it fails with `FAIL stage=<name> reason="highlightly ..."` and exit non-zero, and the tunnel is still closed on every path (M5 behaviour unchanged).
5. The M5 pre-steps are unchanged: production guard, lock, backup reuse/abort, tunnel open/close, port verification.
6. The failure mode seen on 2026-11-03 (stage fails after about 99 s with `exit 1`) cannot recur in a test that simulates it: the stage either succeeds via Highlightly or fails with a reason that names the real cause rather than a bare `exit 1`.

### US-2: Schedule stage keeps existing games current from Highlightly
As the owner, I want the schedule stage to refresh tip-off times and statuses from Highlightly, so that time changes and postponements reach the app without NBA.com.

1. Given a fixture `/matches` response for a date in the window and a database game that matches by team pair and tip-off within 8 h, when the stage runs, then that game's `tipoff_utc` and `status` are updated, and a `highlightly` game crosswalk row is created if absent.
2. Given a Highlightly match whose tip-off differs from the stored one, when the stage runs, then `tipoff_utc` is updated and the change appears in the log with old and new values.
3. Given the game's status in the database is `live` or `final`, when the stage runs, then status and scores are never downgraded (same rule as `load-schedule.mjs:76` and `sync.js:53`).
4. Given a Highlightly match with no matching database game, when the stage runs, then no game row is created (unless Q1 is answered otherwise) and the match is listed in the log and in `ingestion_runs.details` as unmatched with date and teams.
5. Given a match for a non-NBA team (preseason exhibition vs a non-NBA club), then it is counted as skipped, not as an error.
6. Fields Highlightly cannot supply (`arena_id`, `is_neutral_site`, `national_tv_tier`, `national_broadcasters`, `cup_stage`, `season_type`, `series`) are not changed by a Highlightly-sourced update (assert unchanged before/after on a game that has non-default values).
7. `game_date_local` is not recomputed from the ET date for a late west-coast tip (fixture: a 2026-10 game with `date` 03:30Z, a west-coast home team): the stored local date is preserved, or computed from the home team's timezone. A test covers it.
8. Given a tip-off change moves a game to a different local date, then `rest_days` and `b2b_night` are recomputed for both teams' affected games (same rule as `load-schedule.mjs:83-106`); if the date does not change, no tags are touched.
9. Running the stage twice with the same fixtures leaves the database unchanged after the first run (idempotent; second run reports 0 changes).
10. A Highlightly response with an unknown team id or malformed body does not abort the whole stage for one match: that match is reported and the rest are processed; a malformed whole-response (not JSON, missing `data`) fails the stage with a clear reason and writes nothing (transaction rolls back).
11. The `ingestion_runs` row for the stage has `source='highlightly'`, the date window, counts (matches, updated, unmatched, skipped) and request count.

### US-3: Back-fill the current season's results from Highlightly
As the owner, I want the weekly backfill to catch up any final games, box scores, minutes and plus/minus the live worker missed, so that the season stats are complete even without NBA.com.

1. Given a final game in the window with no box score (`box_score_checks` 0) or only a first load (1), when the stage runs, then box score and lineups are fetched and `player_game_stats` rows are written with `minutes`, `plus_minus`, `started`, `dnp` and the other 14 stat columns, and `source='highlightly'`.
2. Minutes and plus/minus equal the fixture values for the real MEM @ HOU game (`box-score_1439038.json`): for example the first listed player's "Total Minutes Played" 26 and "Plus Minus" 11 (QA to pick two more from the fixture).
3. Given any `player_game_stats` row with `source='nba_stats'`, when the stage runs, then that row is not modified and the game is left alone (same rule as `worker/src/sync.js:85-89`). A test seeds an `nba_stats` row and asserts it is byte-identical afterwards.
4. Given a Highlightly player with no confident match, then stats for that player are held and listed (existing `manual_review` behaviour), not guessed. Count shown in the log.
5. Given a game with `box_score_checks = 2`, then no box-score request is made for it (no wasted quota).
6. Given NBA.com is reachable, when the stage runs, then the existing NBA.com reconcile still runs afterwards exactly as today (overwrites Highlightly rows with `nba_stats`, reports differences, marks games done). Given it is unreachable, the stage logs `nba reconcile skipped` and still succeeds.
7. The existing NBA.com path's one-transaction-per-season and checks are preserved: a failed check rolls the season back and leaves nothing written.
8. `team_games` totals and the `won`/`plus_minus` update only touch rows for games just loaded.
9. The stage's `ingestion_runs` row records `source='highlightly'` (or `nba_stats` when the reconcile ran), the number of games and rows written, requests used and quota remaining.

### US-4: Positions stage never blocks the run and never makes data worse
As the owner, I want the positions stage to fill blanks when it can and to skip quietly when it cannot, so that it never fails the weekly run or overwrites a good position.

1. Given NBA.com is unreachable, when the stage runs, then it logs `positions: NBA.com unreachable, skipped (N players still unlisted)` and exits 0.
2. Given NBA.com is reachable, then behaviour is exactly as today (fills only players with a blank `listed_position`; roster listing wins; `positions.test.mjs` cases still pass).
3. If Highlightly positions are used (only after Q4 is answered yes): a player with a non-blank `listed_position` is never changed; Highlightly values map only to `G`, `F`, `C` using a documented table (PG/SG/G to G, SF/PF/F to F, C to C); a conflicting or unmappable value leaves the field blank; hybrids (G-F, F-C) are never inferred from a single game.
4. A test fixture covers the fixture players whose lineup position is a slot label (Okogie "Point guard", Green "Forward") to show the documented mapping and that no existing value is touched.
5. The log line reports how many players were filled, from which source, and how many remain unlisted.

### US-5: NBA.com is best-effort: fast to try, quick to give up, never required
As the owner, I want NBA.com tried once, quickly, and enrichment applied only when it answers, so that a blocked network costs seconds, not 20 minutes, and my existing tagged data keeps improving when it works.

1. Given an NBA.com host that never answers, when the first NBA.com call is made, then it gives up within a bounded time that is far below the current ~95 s (target: 15 s or less, no retry loop) and marks NBA.com unavailable for the rest of the run; later NBA.com calls in the same run are skipped immediately (no repeated timeouts). The total NBA.com time wasted in a fully blocked run is under 30 s.
2. Given NBA.com answers, then the existing endpoints, headers and ~1.4 req/s pacing (`sources.mjs:32-46`) are used and all existing outputs (arena, neutral site, national TV, Cup stage, season type, standings rank, series) are produced as today.
3. Given NBA.com answers for schedule but a Highlightly time conflicts, then NBA.com's `tipoff_utc` wins for games where `source` data is NBA-derived (no flip-flop between runs). Rule to be fixed in the plan; the test asserts the result is stable across two consecutive runs.
4. A setting lets the owner turn NBA.com attempts off entirely for a run (for example `WEEKLY_NBA=0`) with the log showing `nba.com disabled by config`. Default is "try, best-effort" (Q9).
5. The NBA.com error that is logged names the host and the failure type (timeout vs 403 "Access Denied") without dumping response bodies or headers.
6. An unreachable NBA.com is never reported as `FAIL`; a reachable NBA.com that returns malformed data is a warning and the stage falls back to the Highlightly result, not a partial write.

### US-6: No destructive overwrite of good data
As the owner, I want the weekly job to prefer keeping what is already correct, so that a thinner source can never degrade the database.

1. A Highlightly-sourced write never sets a column to NULL, empty, or its default when Highlightly has no value for it (arena, neutral site, TV tier and list, Cup stage, season type, listed position, height, weight, birth date).
2. A Highlightly-sourced write never changes a row whose `source = 'nba_stats'`, a `final` game's status or score, or a `box_score_checks = 2` game.
3. The existing destructive NBA.com steps (replace Highlightly rows, delete Highlightly rows NBA.com lacks, `backfill.mjs:259-271`) run only when NBA.com data for that season loaded completely and passed checks. They never run on a partial or empty NBA.com fetch. A test with an NBA.com fixture that has zero rows asserts no Highlightly rows are deleted.
4. Every stage writes inside one transaction per season/run; a thrown error leaves the database unchanged (`ROLLBACK`), as today.
5. Before any write the M5 backup is still required (reuse a validated backup under 24 h old, abort if none can be made). Unchanged.
6. A dry-run mode (no database writes; prints would-insert/update/skip counts and the request budget) exists and is used by QA tests. Default for the weekly job remains write mode.
7. A game created or edited from Highlightly alone cannot cause a duplicate when NBA.com later loads the same game: the NBA schedule loader finds an existing row by team pair and tip-off before creating a new one. (Applies if Q1 chooses "create".)

### US-7: Quota guardrails protect the live worker
As the owner, I want the weekly job to stay within a request budget and leave the worker enough quota, so that it cannot cause the live scores to go stale.

1. Every Highlightly request in the weekly job is counted per endpoint (`/matches`, `/box-score`, `/lineups`, `/players`, other) and the totals are logged and stored in `ingestion_runs.details` with `quota.remaining/limit` taken from the response headers.
2. A per-run hard cap (default 600 requests, configurable) is enforced: on reaching it, remaining Highlightly work is skipped, the log says `request cap reached`, and the run ends as degraded, not failed. Test with a fixture set larger than a tiny cap.
3. A reserve is enforced: when `x-ratelimit-requests-remaining` is below the reserve (default 1,000, two times the worker's `LOW_QUOTA` of 500, `planner.js:16`), the weekly job makes no further Highlightly requests that run and reports `quota reserve`. If the header is absent the job proceeds but logs `quota unknown`.
4. The job order spends the cheap, high-value requests first: the schedule window is requested nearest-date-first so a cap cuts the far future, not this week.
5. A 429 response is honoured: wait `Retry-After` (bounded, at most 3 retries, total wait capped) and then skip with a warning; 401/403 fails the stage immediately with `highlightly auth rejected` (no retries, key never logged); 5xx and network errors retry twice with back-off, then count as a Highlightly failure (US-1.4).
6. Per-second pacing is applied (default at most 4 requests/s, configurable) because the rate limit is unknown.
7. Before the run, `docs/` (or the README) states the estimated requests per weekly run (80 typical, 385 worst, 505 first full-season sweep per §2.4) and what to check on the Highlightly dashboard (quota period).

### US-8: Observability: logs, notification and status
As the owner, I want one glance at the log and the notification to know what happened, so that I do not have to read stack traces.

1. For each stage the log has one summary line: stage name, source used (`highlightly`, `nba_stats`, or `highlightly+nba_stats`), games or rows read/updated/skipped/unmatched/held, requests used, and duration.
2. The final line reports overall result (`OK`, `OK-DEGRADED`, `FAIL`), backup info (as today), total Highlightly requests, quota remaining, and the list of skipped enrichments.
3. `npm run db:status` shows the last weekly run's source, whether it was degraded, and the Highlightly quota remaining at the end of it (it already shows the worker's quota; the new run must not hide it).
4. Log output contains no API key, no `x-rapidapi-key` header, and no request URL with credentials. `HIGHLIGHTLY_API_KEY` is added to the secrets the weekly runner redacts (today `weekly.mjs:263` registers only the tunnel password). A test injects a fake key value into a step's stderr and asserts it is redacted in `logs/weekly.log`.
5. Held players, unmatched games and fallback warnings are listed, capped at a readable count (for example 15 with `+N more`), as `backfill.mjs:332` does.
6. `logs/weekly.log` keeps its current line format for existing lines so any tooling that reads it still works.

### US-9: Tests use fixtures only
As the team, we want the new behaviour verified without live network or production access, so that CI is safe and repeatable.

1. All new automated tests run from fixtures and a local test database only (as `worker/test` already does with `WORKER_TEST_DATABASE_URL`); no test requires `HIGHLIGHTLY_API_KEY` or network.
2. New fixtures are either copies of the committed recorded ones or are labelled `synthetic` in the file name or a header comment; no real-looking data is passed off as recorded.
3. Required fixture cases: normal day; empty day; paginated (more than 100) day; match with unknown team; shifted tip-off; postponed; status regress attempt (`final` -> `live`); late west-coast tip; box score present and not-yet-ready; player held; 401, 403, 429 with `Retry-After`, 500, timeout, malformed JSON; header with and without quota; NBA.com unreachable and NBA.com malformed.
4. `npm test` (root) and `npm test` (worker) both pass; CI passes before merge is recommended (CLAUDE.md rule 7).
5. A fake-weekly drill (the existing `weekly-drill.sh` / fake railway pattern) covers: NBA.com down + Highlightly up (exit 0, degraded), Highlightly down (exit non-zero, tunnel closed, port free), and quota-reserve hit.
6. No test or script in the PR calls a production URL, the Railway tunnel, or the real Highlightly/NBA hosts. The Sec review checks this.

## 5. Non-functional requirements

- Performance: fully blocked NBA.com costs under 30 s total; Highlightly weekly work at the typical size (about 80 to 130 requests) finishes in under 5 minutes; worst case (about 385 to 505 requests) under 15 minutes; hard ceiling remains the 3,600 s step timeout.
- Reliability: the run is idempotent (re-running the same week writes nothing new) and safe to interrupt (existing signal handling and tunnel cleanup unchanged).
- Security: `HIGHLIGHTLY_API_KEY` is read by the step children as today, never put in argv, logs, `ingestion_runs.details`, notification text or error messages; redacted line by line; `.env`/`.env.example` are never read by agents. No new secrets in the repo. Responses are parsed as untrusted input (type-checked, size-bounded, no `eval`, no path/URL building from response fields).
- Data: no destructive migration. Any schema change (for example storing a Highlightly source flag on `games`) needs the Lead's plan and an owner OK; none is assumed.
- Accessibility: not applicable (CLI and macOS notification text only).
- Compatibility: existing scripts (`db:schedule`, `db:positions`, `db:backfill`, `db:status`) keep their flags and exit codes when run by hand.

## 6. Open questions and assumptions

### Needs owner answer (each with recommended default)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Highlightly cannot give arena, neutral site, national TV, Cup stage, season type. Should the Highlightly schedule stage only update games that already exist (and report unmatched), or also create new games? | Update-only plus a report. The 2026-27 schedule (about 1,274 games) is already loaded from NBA.com in September, so only Cup knockout games (placeholders until the group stage ends, mid-December) and new post-Cup games need new rows, and those need NBA.com-only tags anyway. Creating games from Highlightly risks duplicates and wrong season type. Cup knockout rows stay a best-effort NBA.com job (or a one-off manual run from a different network). |
| Q2 | Is a weekly run where Highlightly finished and NBA.com enrichment was skipped a success? | Yes: exit 0, `OK-DEGRADED`, notification "OK with warnings", a failed-enrichment list in the log. Only a Highlightly failure or a database error is `FAIL`. |
| Q3 | Is the Highlightly 7,500 quota per day or per month, and what plan is active? (Public docs suggest a daily quota; the repo never confirmed.) | Owner checks the Highlightly dashboard once. Until answered, size the guardrails for the worst case (monthly): per-run cap 600, reserve 1,000. |
| Q4 | Positions: accept NBA.com-only best-effort (skipped when blocked), or add Highlightly as a source? Highlightly lineup positions are slot labels (PG/SG/SF/PF/C/G/F), no hybrids, only for players who appear in games, and cannot reach the retired players who make up the blank list. | NBA.com best-effort only for M6. The stage always completes (skipped with a warning). Reconsider Highlightly positions only if Q5 shows a clean position field on a player profile. |
| Q5 | May the team make a one-time recording of live Highlightly responses to build fixtures? Missing today: `/matches/{id}` on a 2026-27 game (venue/broadcast/stage fields), `/players/{id}`, `/standings` (right parameters), `/teams`, and one 429/401 body. | Yes, limited to 10 requests on named endpoints, a developer-run script that saves to a fixtures folder (key never printed), under owner approval. If declined, error fixtures are synthetic and labelled. |
| Q6 | Schedule window: how far back/ahead should the weekly job look? Highlightly's horizon is unknown. | 7 days back, 60 days ahead (68 requests); first run one full-season sweep (189 requests). |
| Q7 | Quota guardrails: per-run cap and reserve. | Cap 600 requests per run, reserve 1,000 remaining, pacing 4 req/s. |
| Q8 | Should NBA.com be tried at all? | Try, best effort, with a single short probe and a switch to disable (`WEEKLY_NBA=0`). The home block may be temporary and the NBA.com path holds the only source for arena/TV/Cup/standings. |
| Q9 | When Highlightly and NBA.com disagree on tip-off or score for the same game, which wins? | NBA.com wins when it answered completely (current behaviour, "NBA.com gets the last word", checklist line 486); otherwise Highlightly. |
| Q10 | Standings rank (`team_seasons`) stays NBA.com-only; the app falls back to win percentage with a note when absent. Acceptable? | Yes for M6. |
| Q11 | What should happen to the first-run catch-up? The weekly job has not completed since the worker started on 2026-09-27; is a one-time full-season Highlightly sweep (about 505 requests worst case) acceptable? | Yes, one time, but only after Q3 is answered, scheduled when quota remaining is above 3,000. |

### Assumptions (not verified)
1. Highlightly `/matches` for a future date returns scheduled games with correct `date` for the full 2026-27 season; only 10-06 and 10-21 are known to be loaded as of 2026-09-26.
2. One `/matches` request per ET date is enough (fewer than 100 matches per day).
3. Highlightly match ids are stable across the season.
4. The worker's current-season rows (source `highlightly`) are the data the weekly Highlightly backfill is allowed to refresh.
5. The weekly job and the worker can run at the same time; row-level writes use the existing `WHERE source = 'highlightly'` guards. The Lead should confirm there is no write race.
6. Highlightly request estimates in §2.4 depend on a game-day mix I could not measure from production (`ingestion_runs.details` holds the real numbers; reading it needs an owner-approved read-only query).

## 7. Risks

1. Duplicate games: a Highlightly-created game has no NBA id; a later NBA.com schedule load keys on NBA id and would create a second row. Mitigation: US-6.7 and Q1 default (no creation).
2. Stale tags: arena, neutral site, TV tier and Cup stage drift if NBA.com stays blocked for weeks (TV schedules change). Mitigation: degraded status is visible every run; the owner can trigger a manual run from another network.
3. Wrong local date for west-coast games if the ET date is used; this breaks back-to-back and rest splits (architecture.md §3.1). Mitigation: US-2.7, US-2.8.
4. Quota ambiguity: if 7,500 is monthly and a worst-case week plus a first full-season sweep runs in the same month, usage can reach about 89% and starve live polling. Mitigation: cap, reserve, Q3, Q11.
5. Highlightly data differences: whole-minute precision, positions as slot labels, DNP rows NBA.com omits. Mitigation: NBA.com reconcile still wins when it runs; positions kept NBA.com-only (Q4).
6. Unknown error shapes: no recorded 401/429/5xx. Mitigation: Q5 and synthetic labelled fixtures; US-7.5.
7. Secret leakage: the runner redacts only the tunnel password today. Mitigation: US-8.4; Sec review mandatory.
8. Coverage of the end-of-season structure (play-in, playoffs, series) has no Highlightly equivalent: not a November problem but must be re-scoped before April 2027.
9. Concurrent writers (worker + weekly) on the same game rows. Mitigation: Lead to verify guards (Assumption 5).
10. Over-trusting a single source: Highlightly's data was verified on one game (MEM @ HOU). Mitigation: keep the NBA.com reconcile path, report difference counts each run.

## Handoff

- **Done:** mapped every NBA.com dependency on the weekly path (14 `stats.nba.com` requests per run; none on `cdn.nba.com`), produced the field-level Highlightly gap table, sized the quota (typical about 80 to 130 requests per week, worst about 385, first full sweep about 505, against 7,500 with worker use of about 2,600 to 4,500 per month), wrote 9 stories with testable acceptance criteria, and listed 11 owner questions with defaults. Document status DRAFT.
- **Files:** created `/Users/jayprox_pro/Documents/Projects/git/ai-application-nba/docs/requirements/M6-highlightly-weekly.md`. No code, `.env`, or `.env.example` touched; no live API or database calls made.
- **Open questions (need the owner):** Q1 (create vs update-only games), Q2 (degraded = success?), Q3 (quota period), Q4 (positions source), Q5 (permission for a limited live recording for fixtures), Q6 to Q11 as listed. The Lead should also check the concurrency assumption (worker + weekly writes) and the duplicate-game risk.
- **Recommended next role:** Owner for Gate 1 (approve or amend the requirements and answer Q1 to Q5), then the Engineering Lead for the plan (`docs/plans/M6-highlightly-weekly.md`).
