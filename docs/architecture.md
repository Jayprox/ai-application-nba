# Chalk That NBA — Architecture

This document is Chalk That NBA's own record, same role `docs/architecture.md`
plays in `ai-application-nfl`: a pointer to the sport-agnostic platform
patterns (kept in `PLATFORM.md` at this repo's root, copied unchanged from
Chalk That NFL) plus this app's own sport-specific decisions below. Update
it after every real design decision or deviation from plan, not just at the
end — same convention NFL's own doc follows.

**Status: decisions made 2026-09-25/26, nothing built yet.** This is the
founding doc for this repo, worked out in a brainstorm before any code was
written — read this and `PLATFORM.md` first in any session building here.

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
- Altitude (Denver + Utah — revised 2026-09-26 from "Denver only", see §6.1)

### 6.1 Split definitions — decided 2026-09-26

All resolved into plain columns at ingestion (PLATFORM.md §2):

- **Altitude** — Denver (Ball Arena, ~5,280 ft) **and Utah** (Delta
  Center, ~4,200 ft). Stored as `arenas.elevation_ft` for every arena plus
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
- **Back-to-back / rest** — per *team*, not per game (`team_games.
  b2b_night` null/1/2, `team_games.rest_days` 0/1/2/3+), computed from
  each team's local game dates.

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
