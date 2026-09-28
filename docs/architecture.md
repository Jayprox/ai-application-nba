# Chalk That NBA — Architecture

This document is Chalk That NBA's own record, same role `docs/architecture.md`
plays in `ai-application-nfl`: a pointer to the sport-agnostic platform
patterns (kept in `PLATFORM.md` at this repo's root, copied unchanged from
Chalk That NFL) plus this app's own sport-specific decisions below. Update
it after every real design decision or deviation from plan, not just at the
end — same convention NFL's own doc follows.

**Status: built and live 2026-09-27** (backend-api, web, ingestion-worker on
Railway; see §7-§8 for the as-built record). Sections 1-6 are the founding
decisions from the 2026-09-25/26 brainstorm, updated as they changed — read
this and `PLATFORM.md` first in any session building here.

---

## 1. Platform patterns — see PLATFORM.md, not repeated here

Everything sport-agnostic (one shared query engine, no predictive
calculations in Part 1, canonical ID + crosswalk table per vendor,
ingestion as its own worker service, two-tier JWT/API-key auth, situational
data tagged at ingestion, the stale-async-state fetch-hook bug pattern, and
the full Node/Postgres/Redis/React/Railway stack + deploy topology) is
copied unchanged from `PLATFORM.md` at this repo's root — do not
re-litigate any of it here. That file was written specifically so a new
sport-app doesn't have to rediscover these decisions.

## 2. On ai-agent-nba (the other NBA repo)

There's a separate, older `ai-agent-nba` repo already in this workspace
(commits Nov 2025-Mar 2026, predates Chalk That NFL entirely) — Python/
FastAPI backend, Azure deployment, OpenAI for narrative generation, its own
"Pick Lab" pick-tracking concept, built through ChatGPT/Copilot recovery
prompts. **Explicit decision (2026-09-25): ignore it, build this app fresh
on the Chalk That pattern.** It's unrelated prior work, not a foundation —
different stack, different philosophy (an AI narrative/risk-score layer is
exactly the kind of invented-number approach Chalk That's Part 1 explicitly
avoids). Nothing from it carries over architecturally.

## 3. Data sources

Three-vendor split, same division of labor as NFL (historical/roster/
schedule, current-season live + injuries, odds/props), chosen after
checking each vendor's real current NBA coverage (2026-09-25) rather than
assuming parity with NFL's vendor landscape:

- **Historical / roster / schedule**: [`nba_api`](https://github.com/swar/nba_api)
  — free, no API key, wraps stats.nba.com's own public endpoints. This is
  the closest thing to nflverse's role, but **not the same guarantee**:
  nflverse is a stable, versioned, CC-BY-licensed dataset; `nba_api` is an
  unofficial wrapper around undocumented NBA.com endpoints, so it carries a
  real risk nflverse doesn't — it can break if NBA.com changes their site.
  Worth monitoring, not treating as a permanent guarantee the way nflverse
  is.
- **Current-season live stats + injuries**: **Highlightly** — same vendor
  NFL already uses. Confirmed real NBA coverage (live scores, box scores,
  player data, rosters, odds) via their own NBA API docs. A free tier
  exists but exact request limits aren't stated in the public docs the way
  they were checkable for NFL — needs a real signup + dry-run test before
  being trusted, same discipline NFL's own vendor decisions used
  throughout (`docs/part2-roadmap.md` in `ai-application-nfl` is full of
  "confirmed against real data" corrections to assumptions that turned out
  wrong — don't skip that step here either).
- **Odds / player props**: **The Odds API** — same vendor NFL uses.
  Confirmed real NBA coverage: moneyline/spreads/totals game odds, plus
  player props (US/AU bookmakers). Not wired at MVP — see §5, deferred to
  the fast-follow phase with props.

**Ruled out: balldontlie.** Checked current pricing 2026-09-25: NBA free
tier is Teams/Players/Games only — player stats, injuries, standings, and
betting data all require a paid plan ($9.99/mo minimum, $39.99/mo for full
access). Same conclusion NFL's own vendor research reached for the same
reason (`docs/architecture.md` in `ai-application-nfl`: "BallDontLie's free
tier only covers teams/games").

### 3.1 Dry-run #1 results (2026-09-26) — confirmed against real data

**stats.nba.com / cdn.nba.com (what `nba_api` wraps) — data is excellent,
access from Railway is not.**

- From a residential IP (JD's Mac, via browser): works. One
  `leaguegamelog` call (`PlayerOrTeam=P`, `SeasonType=Regular Season`,
  2025-26) returned all **26,651 player-game rows in ~3s**, 32 columns
  covering every `player_game_stats` field (MIN, FGM/A, FG3M/A, FTM/A,
  OREB/DREB/REB, AST, STL, BLK, TOV, PF, PTS, PLUS_MINUS).
  `SeasonType=PlayIn` → 6 games, `SeasonType=Playoffs` → 85 games.
- Game-ID prefix encodes game type: `001` preseason, `002` regular season
  (incl. NBA Cup group + QF/SF games), `004` playoffs, `005` play-in,
  `006` NBA Cup championship (does **not** count toward season stats).
- `cdn.nba.com/static/json/staticData/scheduleLeagueV2.json` already has
  the full 2026-27 schedule (1,274 games; regular season opens
  2026-10-20) with per-game `broadcasters.nationalBroadcasters`,
  `arenaCity`, `isNeutral`, and NBA Cup labels (`gameLabel` /
  `gameSubLabel` / `gameSubtype`) — enough to tag national-TV,
  neutral-site, and Cup games at ingestion.
- **From Railway (throwaway `chalk-that-nba-probe` project, egress IP
  152.55.184.170): blocked.** Every stats.nba.com request (with and
  without browser headers) accepted the TLS connection and then hung until
  a 45s timeout, across repeated rounds. cdn.nba.com returned an immediate
  Akamai `403 Access Denied`. This is the well-known NBA.com datacenter-IP
  block. **The ingestion worker cannot pull NBA.com data directly from
  Railway** — how we get it there is now an open decision (see §7).
- Decision: ingestion calls these endpoints directly from Node (plain
  HTTP + browser-style headers), no Python `nba_api` dependency — keeps
  PLATFORM.md's one-language backend.

**Highlightly — dry-run done 2026-09-26 (`scripts/dryrun-highlightly.mjs`)**
- Key/host gotcha: a RapidAPI-issued key (50 chars, contains `msh`) only
  works against `nba-ncaab-api.p.rapidapi.com` *and* needs its own
  RapidAPI subscription to the NBA & NCAAB listing (NFL's subscription
  doesn't carry over); a Highlightly-direct key (UUID) works against
  `nba.highlightly.net`. We use the direct key. Plan: PRO, quota header
  `x-ratelimit-requests-limit: 7500` (period not yet confirmed — watch
  `remaining` over 24h). Latency ~0.5-1.1s/request.
- **Box scores verified exact against NBA.com**: MEM @ HOU 2026-04-12 —
  all 18 players who played match NBA.com's `leaguegamelog` on MIN, PTS,
  FGM/FGA, REB, AST, +/-. Highlightly also lists DNPs (null stats);
  NBA.com omits them. 17 per-player stats cover every `player_game_stats`
  column.
- `GET /lineups/{matchId}`: per-game starter flag + position (PG/SG/SF/
  PF/C) — useful later for the position-keyed matchup-insight layer.
- 2026-27 schedule already loaded (preseason 10/06: 4 games; 10/21: 11).
- **Injuries: not confirmed.** No injuries field appears anywhere — not on
  a finished game's detail, not on an upcoming game's detail (SAC @ LAC,
  2026-10-21), despite the docs. May only populate near tip-off; re-test
  during preseason before relying on it. Injury source is open again.
- No broadcaster data — national-TV tagging still needs NBA.com's
  schedule JSON.
- Crosswalk needed vs NBA.com: team abbreviations differ (`GS`/`GSW`,
  `UTAH`/`UTA`, `NO`/`NOP`, …), season labeled by end year (`2026` =
  2025-26), different game/player ids, and match `date` is UTC (a 7:30pm
  ET game lands on the next UTC day — back-to-back/rest tagging must use
  the local game date).
- `/standings?leagueName=NBA&year=2025` returned empty (likely param
  format) — not needed for MVP.
- Not yet tested: calling Highlightly from Railway (expected fine — the
  probe showed normal outbound traffic works — confirm on first worker
  deploy).

**The Odds API** — free Starter 500 credits/mo; paid from $30/mo (20K).
Signup deferred until the props phase.

### 3.2 Decided: which source feeds what (2026-09-26)

Follows directly from §3.1 — NBA.com is unreachable from Railway,
Highlightly is reachable and its box scores verified exact:

| Data | Source | Runs from |
|---|---|---|
| Historical seasons (backfill) | NBA.com `leaguegamelog` | JD's Mac, one-time script writing straight to Postgres |
| National-TV + neutral-site tags | NBA.com schedule JSON | JD's Mac, manual re-run when TV schedules change |
| Current-season games, box scores, lineups | Highlightly | Railway `ingestion-worker` |
| Injuries | Open — re-test Highlightly in preseason; ESPN's unofficial feed as fallback | Railway |

Consequence: two vendor id spaces from day one (NBA.com + Highlightly)
for teams, players, and games — exactly what the crosswalk table in
PLATFORM.md §2 exists for.

### 3.3 Player-name matching (decided 2026-09-26)

Chalk That NFL once hid James Cook because he's "James Cook III". Measured
on NBA.com's 2,989 players since 1996-97: 90 suffixes (33 active; even
NBA.com writes both "Jr." and "Jr"), 21 accented names (Highlightly drops
accents: "Nikola Jokic"), 63 with periods/apostrophes, 39 hyphenated.
Stripping all of that makes **20 pairs of different people collide**
(Tim Hardaway / Tim Hardaway Jr., Gary Payton / Gary Payton II, two
different Mike James), so a normalized name is never an identity.

`scripts/lib/names.mjs` (tests: `npm test`, 11 cases from real names):
- `nameKey()` — accents, case, punctuation, hyphens, suffix removed.
  Used to *find candidates* and for UI search (`matchesSearch`: "cook",
  "jokic", "pj", "lu don" all work).
- `matchPlayer()` — decides within a pool of players on *that team around
  that date*: unique key match -> matched; several -> exact suffix
  decides, else `manual_review`; none -> first initial + last name
  (Nic/Nicolas Claxton), else `manual_review`. Never guesses.
- Highlightly player ids are matched lazily at ingestion (option (a)), not
  bulk-matched up front. Dry-run: all 24 Highlightly names in MEM @ HOU
  2026-04-12 matched their NBA.com players.
- Per PLATFORM.md's no-shared-code rule, the worker and backend keep their
  own copies of this module *and its test file*.

## 4. Schema

**One unified `player_game_stats` table** — not split by position/role the
way NFL splits offense/defense/special-teams. NFL's split exists because
football's positions track fundamentally different stat vocabularies (a
passing stat means nothing for a defensive lineman); NBA's box-score stats
(points, rebounds, assists, steals, blocks, turnovers, FG/3P/FT, minutes)
apply to every player regardless of position, so one wide table matches
PLATFORM.md §5's own guidance to split "however that sport's positions
actually split — or not at all." NBA doesn't need the split.

### 4.1 Full schema — `db/schema.sql` (2026-09-26)

13 tables. Tested: `db/tests/schema_constraints.sql` (happy path on the
real MEM @ HOU 2026-04-12 game + 23 negative tests, all passing on
Postgres 16), and the stat-consistency CHECKs (`pts = 2*fgm + fg3m + ftm`,
`reb = oreb + dreb`, makes <= attempts, 3PM <= FGM) were run against
**every** NBA.com row of 2025-26 regular season (26,651), 2025-26 playoffs
(1,921), and 1996-97 (23,757) — zero violations, so they're safe to
enforce at write time and will catch vendor/ingestion bugs instead of
silently storing them.

- Reference: `arenas` (elevation + `is_high_altitude`), `teams`,
  `players` (canonical UUID), `entity_id_crosswalk` (one table, typed by
  `entity_type` team/player/game, sources `nba_stats`/`highlightly`/
  `odds_api`, `manual_review` state).
- Season structure: `games` (`season` as `'2025-26'`; `season_type`
  preseason/regular/cup_final/play_in/playoffs; `cup_stage`;
  `game_date_local` + `tipoff_utc`; `is_neutral_site`; `national_tv_tier`
  + raw broadcasters) and `playoff_series` (play-in = best-of-1 rounds in
  the same bracket structure; `bracket_slot` like `W-7v8`, `E-R1-1v8`).
- **`team_games`** — one row per team per game; holds the team-level
  split tags (`venue_split` home/away/neutral, `rest_days`, `b2b_night`)
  plus team box totals. Split queries join `player_game_stats` →
  `team_games` → `games` → `arenas` on keys and filter with plain WHEREs.
- `player_game_stats` — one wide positionless table; `team_id` per game
  (trades), `started`, `dnp`, `source`; FK to `team_games` so a stat row
  can't reference a team that wasn't in the game.
- Copied from NFL's shape: `injury_reports` (append-only),
  `ingestion_runs` (NBA's backfill also logs here, fixing NFL's
  `synced_at = null` gap), `users`, `refresh_tokens`, `api_keys`.

## 5. MVP scope — what ships first vs. fast-follow

*Added 2026-09-26 (Phase 3, full list in the checklist):* MVP also
includes a Scoreboard + Box Score screen, leaderboards with a 70%-of-team-
games qualifier, a season-type selector (Regular default) on player/team
pages, and an "Active" toggle (default on) on player search — retired
players since 1996-97 are searchable with it off.

Trend scopes are **last-5 and last-10** games (NBA's
82-game season makes last-5 alone a thin sample). Historical backfill
covers **1996-97 onward** — NBA.com's `leaguegamelog` has rows before
that, but `PLUS_MINUS` is null pre-1996-97; 1996-97+ covers every active
player's full career.

**Part 1 (MVP, ships first):**
- Full active rosters, real season/game-log stats from the unified stat
  table.
- Situational splits (see §6 below).
- Full season-structure handling — **not just the regular season**: the
  play-in tournament and playoff bracket structure are designed in from
  day one, not retrofitted later. (Explicit call, 2026-09-25 — the
  alternative, regular-season-only, was considered and rejected in favor
  of getting the calendar/structure right up front.)
- Simple real leaderboards (top 10 scorers, top 10 rebounders, etc.) —
  these are just real season averages sorted and capped at N, no
  computation beyond an aggregate query, so they belong in Part 1 the same
  way any other query-engine result does. Not a "ranking" in the Part 2
  sense below.

**Part 2 (fast-follow, once Part 1 is proven — matches NFL's actual build
order):**
- Player props (The Odds API wired in here, not at MVP).
- Composite position rankings (e.g. "top 5 point guards" by a real blended
  score) — same category as NFL's `Rankings` page / `backend/lib/
  ranking.js`, deterministic scoring, no LLM.
- Matchup-insight splits — "this team is weak against centers/rebounding,"
  "strong against power forwards" — NBA's version of NFL's `insights.js`
  `matchup` category (opponent's recent allowed stats), just keyed by NBA's
  5 positions instead of NFL's position groups.
- **Team-unit offense/defense rankings** (e.g. "bottom 10 defense") — genuinely
  new ground, not just an NBA adaptation of something NFL already has.
  Chalk That NFL doesn't rank defensive/offensive units either — it only
  ranks players. This came up when designing NFL's separate research-agent
  team (`ai-agents-nfl`) as a real, flagged gap. Worth deciding later
  whether this eventually gets backported to NFL too, once it's built here.

Explicit decision (2026-09-26): all of Part 2 above (props AND the
rankings/insight layer) fast-follows together, same sequencing NFL actually
used — not split differently between props and rankings.
**Superseded 2026-09-27 (JD):** player props ship first, on their own
(§7.6); the rankings / matchup-insight layer followed the same day (§7.7).

## 6. Situational splits (MVP)

No weather split at all — NBA is played indoors, so that entire NFL split
doesn't carry over (per PLATFORM.md §5's own note: "a sport without
weather-exposed play... drops that split entirely"). Replaced with splits
that are actually real for basketball:

- Home / away
- Back-to-back — specifically distinguishing 1st night vs. 2nd night of a
  back-to-back, since 2nd-night fatigue is one of the most statistically
  real situational effects in the NBA (no NFL equivalent).
- Days of rest (0 / 1 / 2 / 3+)
- National TV game vs. local broadcast
- Altitude (Denver + Utah + Mexico City games — see §6.1)

### 6.1 Split definitions — decided 2026-09-26

All resolved into plain columns at ingestion (PLATFORM.md §2):

- **Altitude** — Denver (Ball Arena, ~5,280 ft) **and Utah** (Delta
  Center, ~4,200 ft) as home arenas, **plus Mexico City** (~7,350 ft)
  for the neutral-site games played there (decided 2026-09-27: the split
  measures playing at altitude, and Mexico City is the highest venue in
  the data; ~1-2 games/yr). Rule = any arena >= 4,000 ft. Stored as `arenas.elevation_ft` for every arena plus
  a derived `is_high_altitude` flag, so the threshold can move later
  without re-ingesting.
- **National TV** — tiered, not boolean: `games.national_tv_tier` =
  `major` (ESPN/ABC, NBC/Peacock, Amazon — any of them present) /
  `nba_tv` (NBA TV is the only national outlet) / `local`. Raw
  `national_broadcasters` kept alongside. Source: NBA.com schedule JSON.
- **Neutral site** — `games.is_neutral_site`; neutral games are
  **excluded from both Home and Away** filters but included in "All".
- **NBA Cup** — `games.cup_stage` (group / quarterfinal / semifinal /
  final) stored for structure; no Cup split filter in MVP. Group + QF/SF
  games count as regular season; the final is `season_type = cup_final`
  and excluded from season stats (matches NBA.com, game-id prefix `006`).
- **Back-to-back / rest** — two flavours, both offered (JD, 2026-09-27):
  - *Team* rest (`team_games.rest_days` / `b2b_night`, filters `rest` /
    `b2b`): days since the team's previous game. Works for team and
    player queries.
  - *Player* rest (`player_game_stats.player_rest_days` /
    `player_b2b_night`, filters `player_rest` / `player_b2b`, player
    queries only): days since the games *he* played — this is what
    NBA.com's player "Days Rest" split uses (a player back from a 5-game
    injury has 10+ days of rest even if his team played last night).
  - Both count **preseason games as played** (incl. the 2020 bubble
    scrimmages) but never store them: an opener's rest runs from the last
    preseason game, as on NBA.com (Morant 2019-10-23 = 4 days after
    10-18; Memphis' first bubble game = 2 days after the 07-28
    scrimmage). With no earlier game at all, rest is null (only "All").
  - Buckets 0 / 1 / 2 / 3+; b2b_night null/1/2. All from local game dates.

## 7. Open — for the build session to work through

- ~~How NBA.com data reaches production~~ — decided, see §3.2.
- Injury source (§3.2) — re-test Highlightly once preseason starts (~Oct 2).
- ~~Split definitions (NBA TV, neutral sites, altitude)~~ — decided, §6.1.

- Actual `nba_api` + Highlightly signup and a real dry-run test against
  live data before trusting either vendor, same as NFL required (don't
  skip the "confirmed against real data" step just because the docs above
  read confidently).
- Confirm Highlightly's real NBA free-tier request limits (unclear from
  public docs alone).
- ~~Full schema~~ — done, §4.1 (`db/schema.sql`).
- MVP screen/route list and build order — follow `docs/vibe-coding-
  checklist.md` (copied into this repo) phase by phase, same as NFL was
  built from it.
- Railway project setup, per PLATFORM.md §4's topology.

## 7.1 Seed (as built) — `scripts/seed.mjs`

Reference data from real sources, one transaction, logged to
`ingestion_runs`, re-runnable (upserts on stable keys):
- Teams/conference/division: NBA.com standings. Canonical abbreviation =
  NBA.com tricode. Highlightly team ids matched **by nickname** (its
  abbreviations differ: GS, NO, NY, SA, UTAH, WSH).
- Home arena = the team's most common non-neutral regular-season arena in
  NBA.com's schedule (Spurs play 3 home games in Austin; home stays Frost
  Bank Center — the Austin games carry their own arena on the game row).
  TBD placeholder games (teamId 0) are ignored.
- Elevation: Open-Meteo geocoding (city elevation, state-matched, most
  populous). New Orleans has no elevation there -> stored NULL with a
  warning. `is_high_altitude` = elevation >= 4,000 ft; the seed fails
  unless that set is exactly DEN (5,279) + UTA (4,262).
- Players: every NBA.com player whose last season is 1996-97 or later,
  plus anyone on a 2026-27 roster not yet in that list (e.g. 2026
  draftees). Position/height/weight/birth date from rosters (current
  players only; blanks allowed for fresh signings).

## 7.2 Historical backfill (as built) — `scripts/backfill.mjs`

**Scope changed 2026-09-26: history starts at 2003-04, not 1996-97** (JD's
call). Every active player's full career is still covered — LeBron's
2003-04 rookie year is the earliest active start. It removes two problems
outright: NBA.com has no national-TV data before 2003-04 (0 games in
1996-97, 2 in 2002-03 vs ~230-330/yr after) and no local tip times before
2003-04. Retired players who started earlier (Kobe, Duncan, Dirk) show
partial careers — the UI labels "stats begin 2003-04". Older seasons can
be added later; the backfill is per-season. Seed now keeps players whose
last season is 2003-04+ (NBA.com's 2026-27 list: 2,519) and prunes the
rest (only if they have no stats).

Sources per season: `scheduleleaguev2` (arena, local tip time, playoff/Cup
labels, national TV — every season back to 1996-97), `leaguegamelog`
team + player for Regular Season / Playoffs / PlayIn (2019-20+) / IST
(2023-24+, only the 006 Cup final — the rest repeat Regular Season),
`leaguestandingsv3` (seeds + the W-L check). One transaction per season;
upserts keyed through the crosswalk; logged to `ingestion_runs`.

Rules (pure functions in `scripts/lib/tagging.mjs`, 13 tests):
- **Neutral site** — NBA.com only flags these from 2024-25. Rule: NBA.com
  flag, OR outside the US/Canada, OR 2019-20 Orlando bubble (from
  2020-07-30), OR Las Vegas. Alternate home venues stay home games
  (Clippers-Anaheim, Hornets-OKC 2005-07, Spurs-Austin, Raptors-Tampa
  2020-21). A generic "not the usual arena" rule was rejected: arenas get
  renamed mid-season (Cleveland, Phoenix 2024-25).
- **Altitude** — elevation by *city*, so renamed arenas keep it (Pepsi
  Center, EnergySolutions/Vivint arenas all flagged).
- **Series** — from game ids (004YY00RSG / 005…); seeds from standings;
  Finals higher seed = better record. Play-in slots `E-7v8`, `E-9v10`,
  `E-8seed`; 2019-20 bubble play-in `W-8v9` is **best-of-2** (schema
  migration `001`).
- **Franchises** — relocated/renamed teams (SEA, NJN, NOH) map to the
  franchise's permanent NBA.com team id, as NBA.com does (Seattle's
  games belong to the Thunder franchise). Historical team names aren't
  modeled yet.
- NBA.com's historical schedule sometimes uses *current* arena names
  (e.g. "Smoothie King Center" for 2003-04 New Orleans).

- **Rest** — team rest from each team's games, player rest from each
  player's games; `leaguegamelog` *Pre Season* (team + player) supplies
  the preseason/scrimmage dates that only anchor rest (§6.1). Verified vs
  NBA.com's Days Rest splits: LeBron 2003-04 20/40/12/7, Morant 2019-20
  8/42/11/6. Two games on one date get null rest (Shawn Marion,
  2007-12-19: played for PHX, and is in the MIA @ ATL game that was
  replayed from the 3rd quarter in March but is dated 12-19).

Games with no winner in NBA.com's log are skipped as "not played" (the
cancelled BOS-IND game of 2013-04-16 is the known case).

Checks per season (independent of the load): every team's regular-season
W-L equals NBA.com's standings; player rows loaded = rows in the logs;
every series has a winner. Spot checks: LeBron 2003-04 = 79 games, 20.9
PPG (matches his published rookie line); Jokić 2025-26 = 65 games, 27.7.
Tested end-to-end on real 2003-04 (CLE + Tokyo games) and 2019-20 (POR +
MEM: bubble + best-of-2 play-in) slices; re-run = no duplicates.

## 7.3 Upcoming-season schedule (as built) — `scripts/load-schedule.mjs`

`npm run db:schedule` (default 2026-27; re-runnable whenever the NBA edits
the schedule). Loads preseason + regular-season games with every tag
that's known in advance: venue incl. neutral sites, rest days and
back-to-back night (recomputed each run — added games change their
neighbours), national-TV tier, Cup group stage, arena/altitude.
- Placeholders with no teams yet (Cup quarterfinals/semis/final) are
  skipped + reported; they load on a later run once teams are set.
- Preseason exhibitions vs non-NBA clubs (2026-10-12 London @ POR) are
  skipped; an unknown team in a regular-season game is an error.
- Never overwrites status/score once a game is live/final (the worker
  owns results).
- Rest/b2b: preseason games are tagged among themselves; real games count
  the team's preseason games as played (opener rest runs from the last
  preseason game — same rule as the backfill, §6.1).
- Check: every team has the same number of known regular-season games
  (80 in Sept 2026; the NBA adds 2 per team after the Cup group stage).

## 7.4 Ingestion worker (as built) — `worker/`

Railway service `ingestion-worker` (rootDirectory `worker`, no public
domain, env: `DATABASE_URL` private URL, `HIGHLIGHTLY_API_KEY`,
`CURRENT_SEASON`). Pulls current-season scores + box scores from
Highlightly (§3.2). Decisions (JD, 2026-09-27):

- **Cadence "live-ish"** (`src/planner.js`, unit-tested): a game in its
  window (tip-off -10 min .. +8 h, not final) -> poll that ET date every
  5 min (30 min when fewer than 500 requests remain); box score when a game
  goes final + one re-check >= 3 h later for stat corrections
  (`games.box_score_checks` 0/1/2, migration 004); daily sweep after 6 am
  ET: yesterday + today + past games still not final. Estimated < 4,500
  requests/month even if the 7,500 quota is monthly; every run logs the
  remaining quota to `ingestion_runs.details` (watch it in `db:status`).
- **Only updates games the NBA.com schedule created** (`db:schedule`),
  matched by teams + tip-off within 8 h, then remembered in the crosswalk.
  Unmatched matches (e.g. Cup knockouts before `db:schedule` is re-run) are
  reported, never invented.
- **Unknown players: create if clearly new.** Order: crosswalk id -> name
  on that team (names.js, suffix-aware) -> unique exact name among active
  players (trades) -> nobody similar anywhere -> create
  (`created_by_worker`). Any near-match or ambiguity -> crosswalk
  `manual_review`, stats held back. Seed/backfill later LINK NBA.com's id
  to worker-created players instead of duplicating them.
- Player rest (§6.1) recomputed for affected players after each box score;
  DNPs stored (`dnp = true`); starters from `/lineups`.
- **Never overwrites NBA.com rows** (`source = 'nba_stats'`).
- **Weekly reconcile from JD's Mac:** `npm run db:backfill -- --season
  2026-27` overwrites with NBA.com, reports rows that differed, deletes
  Highlightly rows NBA.com doesn't have (a wrong link), and marks those
  games done for the worker.
- Manual one-off: `cd worker && npm run sync -- --date YYYY-MM-DD`.
- Held player: resolve by pointing the crosswalk row at the right player
  (`UPDATE entity_id_crosswalk SET canonical_id = '<player id>',
  match_status = 'matched', match_method = 'manual' WHERE source =
  'highlightly' AND source_id = '<highlightly id>'`); the next weekly
  reconcile fills his stats from NBA.com.
- Injuries: still open (§3.2) — re-test Highlightly in preseason.
- Tests: `worker/test` — mapping + planner always; the end-to-end sync
  suite (real MEM @ HOU dry-run files) needs `WORKER_TEST_DATABASE_URL`
  pointing at a local *test* database (it drops the schema).

## 7.5 Backlog quick wins (as built, 2026-09-27)

- **Standings** (`GET /standings?season=`, page `/standings`): W-L, home/
  road (neutral sites in neither, as NBA.com), conference record, last 10,
  streak and games back are computed live from games. The **rank** is
  NBA.com's official one (tiebreakers are the NBA's call), stored in
  `team_seasons` (migration 005) by `db:backfill` and `npm run db:standings`,
  and used only while its W-L equals ours; otherwise win % with a note.
  Seed lines by era: 1-6 + play-in 7-10 (2020-21+), 2019-20 bubble 8v9,
  1-8 before.
- **Bracket** (`GET /bracket?season=`, Playoffs tab): `playoff_series` +
  series wins counted from finished games; classic order (1v8, 4v5, 3v6,
  2v7), play-in 7v8, 9v10, then the 8th-seed game.
- **Advanced stats** in every POST /query scope (season sums, the way
  NBA.com computes them): TS%, eFG%, FT rate, per-36 pts/reb/ast (players),
  offensive/defensive rating per 100 *estimated* possessions (teams, labelled
  "est."; NBA.com counts possessions from play-by-play). Checked: LeBron
  2003-04 TS .488 / eFG .438 and Morant 2019-20 .556 / .509 = NBA.com.
- **NBA Cup** season type (`season_type: "cup"` = games with a Cup stage,
  group stage through the final; 2023-24 on). Not on leaderboards.
- **Auto-deploy**: Railway ignored pushes because the Railway GitHub App was
  not installed on `Jayprox/ai-application-nba` (diagnosis: NO_INSTALLATION
  on all three services). Fix: install the app for this repo (GitHub
  settings), then auto-deploy can be enabled per service. **Done
  2026-09-27:** app installed for the repo, auto-deploy on push to `main`
  enabled on backend-api, web and ingestion-worker.

## 7.5.1 Season-start prep (2026-09-27)

- **Weekly NBA.com run is automated on JD's Mac** (`scripts/weekly.sh`,
  `npm run db:weekly`; launchd job `ops/launchd/`, Mondays 09:07 local,
  runs at next wake if asleep): `db:schedule` (schedule/TV/Cup changes) +
  `db:backfill -- --season 2026-27` (reconcile) + `db:status`, logged to
  `logs/weekly.log`, macOS notification with the result. Still from the Mac
  because NBA.com blocks cloud IPs.
- Backfill's standings check now accepts 0-0 teams, so the weekly run
  works before opening night.
- **Injury re-test tool**: `npm run injuries-probe -- --date D` (worker)
  scans Highlightly's match detail, box score and lineups for any
  injury-looking field. Run on the first preseason dates (Oct 3+); §3.2
  stays open until it answers.

## 7.6 Player props (as built, 2026-09-27)

Decisions (JD, 2026-09-27):
- **Source: The Odds API only** — no hand-typed lines. Highlightly (already
  paid for) has game odds only (moneyline / spread / total), no player props.
- **Book: DraftKings** (`bookmakers=draftkings`).
- **Markets: all 12** — PTS, REB, AST, 3PM, PRA, P+R, P+A, R+A, STL, BLK,
  STL+BLK, TOV (`player_points` ... `player_turnovers`).
- **Two snapshots per game**: *open* (the morning of the game, from 09:00
  ET, retried hourly until DraftKings has posted, never later than 90 min
  before tip) and *close* (in the 35 min before tip; the line props are
  graded against). Preseason skipped.
- **No history backfill** (Odds API props exist from May 2023 but cost
  ~475k credits for three seasons). Lines start with the 2026-27 regular
  season; until then a current line is checked against his past games.
- **Plan**: each pull costs 10 credits per market returned (<= 120/game);
  open + close is ~55k credits in a busy month -> the 100K plan ($59/mo)
  before opening night. Free tier (500) is enough for development.

Built:
- **Migration 006**: `prop_lines(game_id, player_id, market, snapshot,
  book, line, over_price, under_price, book_updated_at, fetched_at)`, PK
  (game, player, market, book, snapshot); `games.props_open_at /
  props_close_at` are the worker's done markers.
- **Worker** (`worker/src/odds.js`, `odds-map.js`, `props.js`,
  `planner.planProps`): runs in the same one-minute loop when
  `ODDS_API_KEY` is set. Our game -> Odds API event by teams + tip-off
  (free `/events`; team names matched by nickname, since NBA.com says "LA
  Clippers"), stored in the crosswalk. Main line per player = the pair
  priced closest to even, both sides required. Names -> players like the
  scores worker, but it **never creates players**: a name it can't place
  safely goes to `manual_review` (crosswalk source `odds_api`) and its lines
  are skipped. Quota guard: < 1,000 credits = closing lines only, < 150 =
  nothing. Every pull is an `ingestion_runs` row (`sync_props`).
  `npm run props -- --check | --capture <eventId> | --date D --snapshot S`
  from the Mac.
- **Backend**: grading is at query time (over / under / push on an exact
  whole-number line; DNP = no action). `POST /query` takes `lines: {pts:
  25.5, ...}` on player season / last5 / last10 / career scopes and returns
  `props` = over/under/push over exactly the filtered games; the game log
  carries each game's line and result. `GET /props?date=&market=` = the
  board (closing line, else opening; movement; result; last-10 and season
  hit rates at that exact line from his games *before* that date).
  `GET /players/:id/props` = next game's lines + his record vs past lines.
- **Frontend**: Props page (date nav between dates with lines, market tabs,
  game filter, sort; cards on phones) and a "Prop check" panel on player
  pages that grades his next lines under whatever filters are on screen.
- Hit rates are counts, labelled as such. Nothing is predicted and there
  are no picks (PLATFORM.md: no predictive math).

## 7.7 Rankings + matchup insights (as built, 2026-09-27)

Decisions (JD):
- **Positions: G / F / C** from NBA.com's listing (it has no PG/SG/SF/PF);
  a hybrid counts toward its first-listed position (G-F = G, F-C = F). The
  listing is the player's current one, applied to every season (noted in
  the UI).
- **Player score: equal-weight z-scores** within the position group over
  PTS, REB, AST, STL, BLK, 3PM, TS% and TOV (fewer is better); population
  SD; score = the mean z. Same 70% qualifier as leaderboards. Every z is
  shown next to its stat, so the score is fully explainable.
- **Matchups: what each defense allows per game** to guards / forwards /
  centers (all 12 prop markets incl. combos), ranked 1-30 (1 = allows the
  fewest) and shown against the league average; the 5 best "strong", the 5
  worst "weak" (labels only with 10+ teams). Season or last 10 games.
- **Team units**: off / def / net rating and pace per 100 estimated
  possessions (same formula as the team tiles), ranked 1-30.
- **Where**: a Rankings page (Players / Teams / Matchups tabs), a matchup
  note on each Props board row (opponent's rank vs his position in that
  market, regular season before that date, once the opponent has 5 games),
  and "Defense by position" on team pages.

API: `GET /rankings/players?season=&season_type=&position=&scope=`,
`/rankings/teams`, `/rankings/matchups[?team_id=]`. Tests: the math by hand
(z-scores, ranks with ties, per-game allowed, labels) plus consistency
with the rest of the API on real data (a player's stats = POST /query,
team ratings = POST /query, every point allowed is accounted for by
position + unlisted).

## 8. Railway (as built)

Created 2026-09-26, per PLATFORM.md §4. Deploy configured 2026-09-27 (step 9). Project `chalk-that-nba`,
environment `production`, region europe-west4 (workspace default — same
as chalk-that-nfl).

| Service | Source | Domain | Variables |
|---|---|---|---|
| Postgres (18) | Railway template | private only | managed |
| Redis (8.2) | Railway template | private only | managed |
| backend-api | GitHub `Jayprox/ai-application-nba` @ `main`, rootDirectory `/backend`, `npm start`, healthcheck `/health` | backend-api-production-f05a.up.railway.app → :8080 | DATABASE_URL, REDIS_URL (refs), CORS_ORIGIN = https://web-production-081bcf.up.railway.app, PORT 8080, CURRENT_SEASON, NODE_ENV; **JWT_SECRET set by JD** |
| web | same repo, rootDirectory `/frontend`, `npm run build` then `npm start` (`server.js`: static dist/ + SPA fallback, zero deps), healthcheck `/health` | web-production-081bcf.up.railway.app → :8080 | VITE_API_URL = https://backend-api-production-f05a.up.railway.app (set before first build — PLATFORM.md §4 gotcha), PORT 8080, NODE_ENV |
| ingestion-worker | same repo, rootDirectory `/worker`, `npm start`, restart ALWAYS | none (by design) | DATABASE_URL (ref), CURRENT_SEASON, NODE_ENV; **HIGHLIGHTLY_API_KEY set by JD**; **ODDS_API_KEY set by JD** (props; without it the worker skips props) |

Backfill scripts run on JD's Mac against Postgres's public connection
string (`DATABASE_PUBLIC_URL`), since NBA.com blocks Railway IPs.
Postgres public endpoint: TCP proxy `iriguchi.proxy.rlwy.net:37012` ->
5432 (added 2026-09-26). `DATABASE_PUBLIC_URL` on the Postgres service was
added by hand with Railway's standard reference definition — the template
only creates it when a proxy exists at creation time.

