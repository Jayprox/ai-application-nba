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

## 4. Schema

**One unified `player_game_stats` table** — not split by position/role the
way NFL splits offense/defense/special-teams. NFL's split exists because
football's positions track fundamentally different stat vocabularies (a
passing stat means nothing for a defensive lineman); NBA's box-score stats
(points, rebounds, assists, steals, blocks, turnovers, FG/3P/FT, minutes)
apply to every player regardless of position, so one wide table matches
PLATFORM.md §5's own guidance to split "however that sport's positions
actually split — or not at all." NBA doesn't need the split.

## 5. MVP scope — what ships first vs. fast-follow

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
- Altitude (Denver specifically — the one real venue effect in the NBA)

## 7. Open — for the build session to work through

- Actual `nba_api` + Highlightly signup and a real dry-run test against
  live data before trusting either vendor, same as NFL required (don't
  skip the "confirmed against real data" step just because the docs above
  read confidently).
- Confirm Highlightly's real NBA free-tier request limits (unclear from
  public docs alone).
- Full schema (`db/schema.sql` equivalent): teams, players, games,
  `player_game_stats`, injury reports, the entity-crosswalk table per
  PLATFORM.md §2, play-in/playoff bracket representation.
- MVP screen/route list and build order — follow `docs/vibe-coding-
  checklist.md` (copied into this repo) phase by phase, same as NFL was
  built from it.
- Railway project setup, per PLATFORM.md §4's topology.
