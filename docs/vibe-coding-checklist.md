# Vibe Coding — Project Checklist (Chalk That NBA)

> Reset from Chalk That NFL's filled-in copy on 2026-09-26 — NFL's answers and
> build log live in `ai-application-nfl/docs/vibe-coding-checklist.md` if you
> want a worked example. Fill this out top to bottom before writing code.
> Goal: quality portfolio apps, not just working demos.

---

## Phase 1 — Concept Clarity
*Time box: 15 minutes. Write, don't code.*

- [x] **One-paragraph pitch** — What does it do, who is it for, what problem does it solve?
- [x] **Why this stack?** — Be able to answer this in an interview. Write it down.
- [x] **What does "done" look like?** — Describe the app running successfully in 2–3 sentences.

*(Approved by JD 2026-09-26.)*

```
PITCH:
Chalk That NBA is a stats research app — no predictive calculations —
giving access to every active NBA player's and team's season averages,
last-5 and last-10 game trends, game logs, and full career stats (back to
1996-97, when NBA.com's complete box scores begin), filterable by
basketball-specific situational splits (home/away, 1st vs 2nd night of a
back-to-back, days of rest, national TV, altitude), plus real
leaderboards (top-N by season average). It models the NBA's full season
structure — regular season, NBA Cup, play-in, playoffs — rather than
treating the year as one flat schedule. It's Part 1 of the Chalk That
platform: Part 2 (a future, separate service) is a team of AI agents that
query this same API directly to condense hours of research into picks,
without depending on a third-party tool's rate limits or ToS.

STACK RATIONALE:
Same stack as Chalk That NFL, per PLATFORM.md — Node/Express API +
standalone Node ingestion worker (one language end to end), Postgres
because the data is relational (players x games x splits is a WHERE
clause), Redis for query-result caching, React/Vite/Tailwind web client
(Swift iOS fast-follow on the same API), JWT for humans + API keys for
agents, Railway hosting. NBA-specific: data sourcing is split — NBA.com
for history/schedule (it blocks datacenter IPs, so it's pulled from a
residential machine) and Highlightly for live current-season data from
Railway — decided after real dry-runs, not assumed (architecture.md §3).

DONE LOOKS LIKE:
A user can browse any current-season NBA team or player and see season
averages, recent-game trends, game logs, and career stats that match
NBA.com's official numbers — filterable by any of the 5 situational splits
with sample size shown, correctly separated by season type (regular
season / play-in / playoffs), plus working leaderboards. Deployed on
Railway with JWT auth, the ingestion worker keeping the current season
fresh from Highlightly, and graceful preseason/offseason/rookie empty
states. No props, no rankings/matchup layer, no iOS required to call it
done.
```

---

## Phase 2 — System Design
*Architecture first. This is what separates portfolio apps from demos.*

- [x] **Data model** — List your entities and their key fields. Note relationships.
- [x] **Architecture diagram** — Even a text sketch: frontend → API → DB → external services
- [x] **API surface** — What endpoints/routes exist? (REST routes, WebSocket events, etc.)
- [x] **Auth strategy** — None / JWT / Session / OAuth? Why?
- [x] **External dependencies** — APIs, SDKs, third-party services. Note rate limits and costs.

*(Full detail lives in `docs/architecture.md`. This is the condensed version.)*

```
ENTITIES:  (full DDL: db/schema.sql — rationale: architecture.md §4.1)
Arenas (elevation, high-altitude flag), Teams, Players (canonical UUID),
Entity ID Crosswalk (team/player/game ids from NBA.com + Highlightly +
Odds API -> canonical), Games (season, season_type incl. play-in /
playoffs / cup_final, cup_stage, local date, neutral site, national-TV
tier), Playoff Series (play-in + bracket), Team Games (per-team split
tags: home/away/neutral, rest days, back-to-back night + team box totals),
Player Game Stats (one wide positionless table), Injury Reports
(append-only), Ingestion Runs, Users, Refresh Tokens, API Keys.

ARCHITECTURE:
  [React Web / Swift iOS (fast-follow) / AI agents (Part 2)]
        -> [backend-api: Node/Express — JWT + API-key auth, POST /query]
        -> [Postgres + Redis]

  [ingestion-worker: Node, Railway, no public domain]
        -> Highlightly (current-season games, box scores, lineups)
        -> [Postgres + Redis]  (direct write, bypasses backend-api)

  [backfill scripts: Node, run from JD's Mac — NBA.com blocks Railway IPs]
        -> NBA.com stats/cdn (history 1996-97+, schedule, national-TV tags)
        -> [Postgres]  (direct write, logs to ingestion_runs)

KEY ROUTES:
Auth: POST /login, POST /refresh, POST /logout
Query: POST /query — the one shared engine (entity, stat, scope, splits ->
  data + sample size + freshness). NBA scopes: season | last5 | last10 |
  career | game_log | leaderboard. NBA splits: venue (home/away),
  b2b_night (1/2), rest_days (0/1/2/3+), national_tv (major/nba_tv/local),
  altitude (yes/no); plus season + season_type. Added in step 6: player
  queries also get player_b2b / player_rest (the player's own rest, as on
  NBA.com) next to the team's. Leaderboards are a /query
  scope, not a separate endpoint (PLATFORM.md §2).
Browse: GET /teams, GET /teams/:id, GET /players (?active=true default),
  GET /players/:id, GET /games?date=, GET /games/:id (box score)
Ops: GET /health

AUTH:
Unchanged from PLATFORM.md §2: short-lived JWT + rotating refresh token
(replay revokes every session) for humans; long-lived hashed API keys for
agents. Same middleware, same API surface.

EXTERNAL DEPS + LIMITS:
NBA.com stats/cdn — free, unofficial, undocumented; blocks datacenter IPs
  (verified from Railway) so only reachable from a residential machine.
Highlightly — PRO plan, quota header 7,500 (period TBC); box scores
  verified exact vs NBA.com. Injuries not yet confirmed.
The Odds API — free 500 credits/mo; paid from $30/mo. Fast-follow only.
```

---

## Phase 3 — MVP Scope
*Cut ruthlessly. Everything not in v1 goes in the backlog.*

*(Approved by JD 2026-09-26.)*

- [x] **v1 features (must have):**
  - Team browse (30 teams by conference/division) + team detail (roster,
    team-level stats with the same scopes/splits as players)
  - Player search/browse with an **"Active" toggle, on by default**
    (same pattern as CT NFL); toggling it off searches every player since
    1996-97 (retired players get career stats + graceful current-season
    empty states)
  - Player detail: scope tabs Season / Last 5 / Last 10 / Career / Game
    Log, season picker, **season-type selector (Regular default / Play-In
    / Playoffs / All)** — types never mix unless "All" is chosen
  - 5 situational splits: home/away (neutral excluded), back-to-back
    night 1/2, rest days 0/1/2/3+, national TV (major/NBA TV/local),
    altitude (DEN + UTA) — sample size shown with every result
  - **Scoreboard** (games by date, incl. preseason/Cup/play-in/playoff
    labels) + **box score** screen; game-log rows link into box scores
  - **Leaderboards** — top-N by per-game average for core stats;
    qualifier: played in >= 70% of the team's games so far (labeled on
    screen as Chalk That's rule, not the NBA's official one)
  - Injury badge on player records — *if* an injury source is confirmed
    (architecture.md §3.2); otherwise ships without and is tracked
  - Empty states: preseason, offseason, rookie, retired player, split
    with zero games, season type not reached (e.g. team missed playoffs)
  - JWT auth wired (single test account OK), deployed on Railway
- [x] **Backlog (explicitly out of scope for now):**
  - Everything in Part 2's fast-follow: player props (The Odds API),
    composite position rankings, matchup-insight splits, team-unit
    offense/defense rankings
  - NBA Cup split filter (Cup stage is stored, just not filterable)
  - Swift iOS app (same API, later)
  - Natural-language search bar
  - Standings page, playoff bracket *view* (bracket is in the schema)
  - User-adjustable leaderboard qualifier; advanced stats (TS%, usage…)
  - Self-serve signup / email verification
- [x] **Success metric** — How will you know v1 is shippable?
  A user can look up any NBA team, player, or game and see numbers that
  match NBA.com — season/L5/L10/career/game log, by season type, under
  any of the 5 splits with sample size shown — plus correct leaderboards
  and box scores, on a live Railway URL, with the ingestion worker keeping
  the current season fresh from Highlightly.

---

## Phase 4 — UI/UX Plan
*Wireframe before you write a component.*

- [x] **Screen inventory** — List every unique view/page
- [x] **Key user flows** — Walk through the 1–2 flows that matter most
- [x] **Component sketch** — Rough layout for the main screen (ASCII or Figma link)

*Approved by JD 2026-09-26.* Clickable mockup of all 8 screens, built on
real 2025-26 data: **"Chalk That NBA — MVP Screens"** design canvas in
JD's Claude artifacts (claude.ai/code/artifacts). Player Detail's scope
tabs, season-type selector and all 5 splits recompute live from
Jokić's real 65 regular-season + 6 playoff games.

```
SCREENS:
  1. Login — sign-in card only (single test account in v1)
  2. Scoreboard — games by date, date picker; LANDING PAGE after login
  3. Box score — both teams, starters marked, DNPs listed, team totals,
     plus the split tags written for each team at ingestion
  4. Leaderboards — Points / Rebounds / Assists / 3PM tabs, top 10,
     qualifier explained on screen (70% of team games)
  5. Player search — name search, team filter, "Active only" toggle (on
     by default; off = every player since 1996-97)
  6. Player detail (main screen) — scope tabs, season + season-type
     selector, 5 split filters, sample size + W-L of the sample
  7. Teams — 30 teams by conference/division; altitude arenas marked
  8. Team detail — record, home/away, team per-game stats, roster;
     same scopes/splits as player detail via POST /query (entity: team)
  Nav bar on every signed-in screen: Scoreboard · Teams · Players · Leaders

MAIN FLOW:
  Player (via search, leaderboard, box score or team roster) -> pick
  scope + season type -> apply splits -> read the filtered numbers with
  sample size and W-L. Second flow: Scoreboard -> box score -> player.

MAIN SCREEN LAYOUT (Player Detail) — see the mockup; condensed:
  [<- Players]                                [Injury badge / pending]
  Nikola Jokić  C · Denver Nuggets     Season [2025-26]  [Reg|PI|PO|All]
  [Season Avg] [Last 5] [Last 10] [Career] [Game Log]      <- scope
  Venue[All|Home|Away] B2B[All|N1|N2] Rest[All|0|1|2|3+]
  National TV[All|Major|NBA TV|Local] Altitude[All|Yes|No]  [Clear]
  Season average · 65 games   45-20 in these games · 2025-26 regular
  [PTS 27.7][REB 12.9][AST 10.7][3PM 1.7][FG% .569] ...10 stat tiles
  Real NBA.com data · Synced Xm ago

DECISIONS FROM THE MOCKUP (defaults as built, JD approved the screens):
  - Last 5 / Last 10 apply AFTER splits: "Last 10 + Home" = his last 10
    home games (not home games within his last 10). Query-engine rule.
  - Leaderboard ties get sequential ranks (no shared rank) in v1.
  - Team roster sorted by PPG with GP shown beside it (a 1-game player
    can rank high — GP column makes that visible).
  - Empty states seen in practice: Play-In for a top-6 seed; a split with
    zero games; national-TV data not yet loaded.
```

---

## Phase 5 — Build Order
*Always: data → server → UI. Never build UI against mocks if you can help it.*

*(To be worked out together once Phases 1–4 are settled. Check items off as
each is actually built, not as it's planned.)*

*(Order agreed with JD 2026-09-26.)*

- [x] Railway project — `chalk-that-nba`: Postgres + Redis, empty
      backend-api / web / ingestion-worker, both public domains generated
      and cross-wired (CORS_ORIGIN, VITE_API_URL) before any build.
      Details: architecture.md §8.
- [x] Schema live on Railway Postgres + constraint tests run against it
      *(Done 2026-09-26: `npm run db:apply` (scripts/db-apply-schema.mjs)
      from JD's Mac -> 13 tables on Railway Postgres 18.6, all 23
      constraint tests PASS. Needed a TCP proxy on Postgres (none by
      default) plus a DATABASE_PUBLIC_URL variable Railway hadn't created
      because the proxy came after the DB — script now rejects
      `*.railway.internal` hosts with a clear message.)*
- [x] Seed: arenas (elevation), 30 teams, team + player crosswalks
      (NBA.com + Highlightly) — `npm run db:seed`. *Live 2026-09-26: 30
      teams (60 team crosswalk rows), altitude DEN+UTA; re-run for the
      2003-04 scope pruned 471 pre-2003 players -> 2,519 players, 610
      active (2026-27 list).*
- [x] Historical backfill 2003-04 -> 2025-26 (scope revised from 1996-97),
      all season types, split tags derived at load, logged to
      ingestion_runs — `npm run db:backfill` (runs on JD's Mac).
      *Live 2026-09-26: 23/23 seasons, 29,653 games, 618,623 player rows,
      382 series (15/season through 2019-20 + the bubble play-in, 21/season
      from 2020-21), 0 failed runs (`npm run db:status`). Spot checks exact:
      LeBron 2003-04 79 GP / 20.9 PPG, Jokić 2025-26 65 GP / 27.7 PPG.
      First pass caught two real issues, both fixed: (1) the cancelled
      BOS-IND game of 2013-04-16 (Boston Marathon bombing) is still in
      NBA.com's log with no winner and 0 points -> counted as a loss for
      both until the standings W-L check rolled 2012-13 back; games with no
      winner are now skipped + reported. (2) 2019-20 hit the best-of-2 rule
      because migration 001 hadn't run (zsh doesn't allow inline `#`
      comments interactively — command lists I give JD carry no comments).
      2019-20 neutral = 175 (172 Orlando bubble + 2 Mexico City + 1 Paris).*
- [x] 2026-27 schedule + national-TV / neutral-site tags (JD's Mac) —
      `npm run db:schedule`. *Live 2026-09-27: 1,266 games (66 preseason,
      1,200 regular), 80 known per team, 432 second-night team-games, 6
      neutral (Macao x2, Las Vegas, Mexico City, Paris, Manchester); skipped
      7 Cup knockout placeholders + 1 exhibition (London @ POR). Re-run
      after the NBA adds post-Cup games / sets knockout matchups.
      **Data foundation complete: 24 seasons, 30,919 games.***
- [x] Core API: auth, POST /query (all scopes/splits/leaderboard), browse
      routes; verified against NBA.com numbers — `backend/`. *Two-tier
      auth (JWT + rotating refresh with replay revoke, `ctnba_` API keys);
      one `POST /query` for player/team season/career/game-log/leaderboard
      with venue, team rest/b2b, player rest/b2b, national TV, altitude,
      last 5/10; browse routes for teams/players/games. 28 tests pass on
      the fixture DB, checked against NBA.com: LeBron 2003-04 (79 g, 20.9;
      home/road, Days Rest 20/40/12/7, last 5/10), Morant 2019-20 (67 g,
      bubble games neutral, Days Rest 8/42/11/6). Migration 003 = player
      rest columns.*
- [x] Frontend scaffold + the 8 screens in mockup order (stale-key
      fetch-hook pattern from day one) — *JD: slice first, usable on phones.*
  - [x] Slice 1: scaffold (React + Vite + Tailwind v4 + React Router 7,
        `frontend/`), sign-in, Scoreboard (prev/next skip to the nearest
        game day), Box Score / game preview with split tags. `useFetch`
        stale-key hook + cross-tab-safe token refresh, both unit-tested
        (11 tests). Backend: `/games` returns prev/next game days; DATE
        columns come back as 'YYYY-MM-DD'; `npm run dev` reads the root .env.
  - [x] Slice 2: Teams, Team detail (explorer + season roster), Players
        (search, team filter, Active toggle), Player detail (5 scopes, season
        type, 5 splits, "rest measured by: his games / team's schedule"),
        Leaders (6 stats, 70% qualifier). One shared StatExplorer drives both
        detail pages; every control lives in the URL. Backend: GET /seasons,
        GET /teams/:id/players, team per season in career. 16 frontend tests.
- [x] Ingestion worker (Highlightly) — `worker/`, architecture §7.4. *Live-ish
      cadence, create-if-clearly-new players, weekly NBA.com reconcile via
      `db:backfill --season 2026-27` (reports differences). Migration 004.
      Worker tests: 10 unit + 3 end-to-end (local test DB). Deploys with step 9.*
  - [ ] Injuries: re-test Highlightly once preseason games start (~Oct 2)
- [x] Deploy — *2026-09-27: backend-api, web, ingestion-worker live on Railway from
      `main` (all SUCCESS). Verified from the browser: web serves deep links,
      unauthenticated API calls get 401, CORS allows only the web domain,
      worker's first run logged (quota 7,466/7,500).*
- [x] Phase 6 hardening (see Phase 6 section)

**Checkpoint after each feature:** Does it still match the system design? Any drift?

---

## Phase 6 — Hardening Pass
*This is what separates a demo from a portfolio app. Don't skip it.*

- [x] Error handling on all API calls (try/catch, user-facing error states) — *every
      fetch goes through `useFetch` -> ErrorBox (404 / 5xx / offline / retry);
      render crashes caught by an ErrorBoundary per route; backend error
      handler never leaks stacks; API-key lookup failures are a 500, not an
      unhandled rejection; worker logs and keeps looping.*
- [x] Loading states — *every async screen shows a status block while loading.*
- [x] Empty states — *scoreboard empty days (links to nearest game days),
      no matching splits, empty roster/leaders, no search results, preview games.*
- [x] Input validation (client-side + server-side) — */query `validate()`, id/date/
      season checks on every browse route, search capped at 80 chars, login
      field lengths, 32 kb body limit; Postgres statement timeout 15 s.*
- [x] Environment variables (no API keys in code, no `.env` committed) — *checked
      tracked files + full git history: only `.env.example` (empty values).*
- [x] Basic auth/access control review — *everything but /health, /login,
      /refresh, /logout needs a JWT or API key; JWT alg pinned to HS256;
      login + refresh brute-force limit (10 failures per account / 30 per IP
      per 15 min -> 429); security headers + no-store on the API; CORS
      allow-list; `create-user` rejects weak passwords (12+ chars, no
      "password"/"123456", not the username). Known limits: rate limit is
      in-memory (one replica, resets on deploy); Postgres has a public TCP
      proxy for the Mac scripts (strong generated password).*
- [x] Mobile responsiveness check — *all 8 screens checked at 390 px (Playwright):
      nav wraps, tables scroll with a sticky name column, splits fold away.*
- [x] Console errors cleared — *no errors in the Playwright runs or on the live
      site (only the expected 401 when a wrong password is typed).*

---

## Phase 7 — Portfolio Packaging
*An unpackaged app is invisible to recruiters and collaborators.*

- [x] **README.md** — what it is, stack, setup, live URL, screenshots, known limitations
      — *root README: features, NBA.com-verified numbers, architecture
      diagram (Mermaid), stack, layout, local setup, data operations, tests,
      API example, limitations. Screenshots from the live site in
      `docs/screenshots/` (scoreboard, player detail, box score, leaders).*
- [x] **Deployed** — live URL: https://web-production-081bcf.up.railway.app
- [ ] **Loom or screen recording** (optional)
- [x] **Can you explain it in 2 minutes?** — *draft below, in JD's words to adjust.*

### 2-minute explanation (draft)

"Chalk That NBA answers split questions fans and bettors actually ask: how
does Jokić play on the second night of a back-to-back, or on the road with
no rest, or at altitude? It covers every game since 2003-04, about 620,000
player box-score rows, and keeps the current season live.

The key design choice is that situational context is written onto each game
when it's loaded: home/away/neutral, days of rest, back-to-back night,
national TV, altitude. Any filter is then just a database WHERE clause, and
every client (the web app now, AI agents later) goes through one query API.

The hardest part was trust. NBA.com is the reference, so the tests pin its
published numbers: LeBron's rookie season by days of rest matches it game
for game. Getting there meant finding NBA.com's own rules. Rest is counted
from a player's own games, and an opener's rest runs from the last preseason
game. Bad data can't get in quietly either: database constraints reject
impossible stat lines, the team W-L is checked against standings on every
load, and ambiguous player names go to manual review instead of being
guessed.

It runs on Railway as three services: API, web, and a worker pulling live
box scores from Highlightly. NBA.com blocks cloud servers, so historical
loads and a weekly reconcile run from my laptop, and NBA.com always gets the
last word."

---

## Architect's Gut Check (Before Calling It Done)

Answer these. If you stumble on any, go back.

1. **Why did you choose this stack over alternatives?**
   *Draft:* It's the Chalk That platform stack (PLATFORM.md), proven on NFL:
   one language (JS) across API, worker and web; Postgres because the product
   is filtered aggregates over relational data, and CHECK constraints guard
   data quality; Railway for one-project-per-app with private networking.
   NBA-specific: plain Node HTTP instead of Python `nba_api` (it only wraps
   the same endpoints, and a second language wasn't worth it).
2. **What's the hardest technical problem you solved?**
   *Draft:* Matching NBA.com's rest splits exactly. Our first counts were
   off by one game here and there; the fixes were player-level rest (his
   games, not the team's), preseason and bubble scrimmages counting as
   "played", and a game dated to a day it wasn't finished (Marion, 2007).
   Runner-up: cross-vendor player identity without false merges (20 real
   NBA name collisions).
3. **What would you do differently if you rebuilt it?**
   *Draft:* Start with a local test database and fixture pipeline on day one
   (it came later). Pick the deploy branch (`main`) from the start. Plan for
   NBA.com's cloud-IP block before designing ingestion.
4. **What breaks first under load or edge cases?**
   *Draft:* Career and leaderboard queries aggregate hundreds of thousands
   of rows. Redis caching (24 h for finished seasons) and a 15 s statement
   timeout contain it, but many concurrent uncached career queries would be
   the first hotspot (fix: materialized per-season aggregates). Edge cases:
   Highlightly outages (the worker retries, and NBA.com reconciles weekly),
   and the in-memory sign-in lockout resetting on redeploy.
5. **If a junior dev joined, could they navigate the codebase in 30 min?**
   *Draft:* Yes. The README maps the folders to services. architecture.md
   records every decision with the reason, and the tests read as a spec
   ("LeBron 2003-04 PLAYER rest = NBA.com").

---

## Project Log
*Running notes as you build. Good for README + interview stories.*

| Date | What I built | Decision made | Why |
|------|-------------|---------------|-----|
| 2026-09-27 | Phase 7: README, pitch, gut-check drafts | README leads with NBA.com-verified numbers | Trust is the product: showing the checks is the fastest way to earn it |
| 2026-09-27 | Phase 6 hardening | Brute-force limit counts failures only, per account and per IP; weak passwords refused at account creation | The site is public: stop password guessing without ever slowing down normal users |
| 2026-09-27 | Deployed to Railway | Web served by a zero-dependency Node server instead of `vite preview`; build tools as regular dependencies | Nothing dev-only in production, and deep links like /players/:id work on refresh |
| 2026-09-27 | Ingestion worker | Scores every 5 min during game windows, box scores at final + one 3h re-check; unknown players created only when nobody similar exists; NBA.com reconciles weekly | Stays well inside the Highlightly quota; a wrong player link is worse than a delayed one; NBA.com is the source we verified, so it gets the last word |
| 2026-09-27 | Frontend slice 2 (Teams, Players, Player/Team detail, Leaders) | Player pages default to the player's own rest (NBA.com's definition) with a one-tap switch to the team's schedule; filters live in the URL | "Offer both" without doubling the filter rows; URL state makes any split view shareable and keeps Back working |
| 2026-09-27 | Frontend slice 1 (sign-in, Scoreboard, Box Score) | Both tokens in localStorage; refresh is single-flight per tab and serialized across tabs with a Web Lock | Refresh tokens rotate and a replay revokes every session, so two tabs refreshing with the same token would sign the user out everywhere |
| 2026-09-27 | Core API + player rest (migration 003) | Offer both team rest and player rest; preseason games count as "played" for rest | NBA.com's player Days Rest split uses the player's own games, and measures an opener from the last preseason game; matching it exactly is how the numbers can be verified |
| 2026-09-27 | Schedule loader | Altitude includes Mexico City (any arena >= 4,000 ft) | Mexico City (~7,350 ft) is higher than Denver; the split is about playing at altitude |
| 2026-09-26 | Backfill live: 23 seasons, 618K player rows | Games with no winner are "not played" and skipped | NBA.com keeps the cancelled 2013-04-16 BOS-IND game in its logs; the independent standings W-L check caught it before bad data landed |
| 2026-09-26 | Backfill design | History starts 2003-04 (not 1996-97); neutral-site rule for pre-2024-25; best-of-2 series (migration 001) | NBA.com has no national-TV data or local tip times before 2003-04, and still covers every active career; NBA.com only flags neutral sites from 2024-25, so the 2020 bubble/international games needed a rule |
| 2026-09-26 | Phase 4: clickable mockup of all 8 screens on real data | Landing page = Scoreboard; login = plain sign-in card; Last-N applies after splits | Building the mock on real data surfaced the Last-N/split ordering question before any query-engine code existed |
| 2026-09-26 | Phase 3 scope | Added Scoreboard + Box Score screens; leaderboard qualifier = 70% of team games; season-type selector (Regular default); Active toggle on player search (default on) | NBA fans think in games/nights; a qualifier keeps 1-game outliers off leaderboards; mixing playoff and regular stats silently would be wrong numbers |
| 2026-09-26 | `db/schema.sql` + `db/tests/schema_constraints.sql` | Split tags live on a per-team `team_games` row, not on `games`; stat-consistency CHECKs enforced at write time | Rest/back-to-back differ between the two teams in one game; the CHECKs passed against 52K real NBA.com rows, so any violation later is an ingestion bug worth failing loudly on |
| 2026-09-26 | Phase 1 decisions | Trend windows: last 5 AND last 10 (not NFL's last-5 only); backfill depth: 1996-97 onward | 82-game season makes 5 games a thin sample; 1996-97 is where NBA.com box scores gain +/- and it covers every active career (LeBron 2003-04: 79 games, verified) |
| 2026-09-26 | Vendor dry-run #1 (NBA.com via browser, Railway probe) | Ingestion worker calls stats.nba.com / cdn.nba.com directly from Node — no Python `nba_api` dependency | Keeps PLATFORM.md's one-language backend; `nba_api` is only a header wrapper around these endpoints |

---

*Template v1.0 — adapt as needed per project.*
