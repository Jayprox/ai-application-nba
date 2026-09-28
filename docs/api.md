# Chalk That NBA — API Reference

The contract every client builds against: the React web app today, the
iOS app next, and AI agents. One service (`backend-api`), JSON over HTTPS.
The web app is the reference client; anything it shows comes from an
endpoint below, and **no client derives or invents a stat** of its own.

- **Production:** the `backend-api` Railway domain (the web app's `VITE_API_URL`).
- **Local:** `http://localhost:3000` (`cd backend && npm run dev`).
- **Source of truth:** `backend/src/server.js` + `backend/src/routes/*`. The
  examples here are real responses from the test database, trimmed to one or
  two rows.

Updated 2026-09-28.

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Body | JSON in and out (`content-type: application/json`); request bodies are capped at 32 KB. |
| Envelope | Most endpoints return `{ data, meta }`. `POST /query` adds `query`, `subject`, and sometimes `props`. `POST /ask` has its own shape (§9). |
| Errors | Always `{ "error": "<message>" }` with a 4xx or 5xx status and never a stack trace. The message is written for a human and is safe to show. |
| Numbers | Always JSON numbers, never numeric strings. Averages have 1 decimal. |
| Percentages | Stored **0–1** with 3 decimals: `fg_pct`, `fg3_pct`, `ft_pct`, `ts_pct`, `efg_pct`, `ft_rate`, `pct`, and `usg_pct`. Show the shooting ones the NBA way (`.488`, from 0.488) and usage as a percent (`28.3%`, from 0.283). |
| Signed values | `plus_minus`, `net_rtg`, `vs_avg`, `gb` can be negative. Show with a sign (`+1.5`). |
| Missing | `null` means unknown or not applicable (shown as `—`). A missing stat is never `0`. |
| Dates | `date` / `game_date_local` = `YYYY-MM-DD`, the **home venue's local date**. Parse it as a calendar date (no timezone), or it can move a day. |
| Times | `tipoff_utc`, `*_at`: ISO-8601 UTC. Show tip-off in the viewer's own timezone. |
| Seasons | `"2025-26"` (start year + 2 digits). History starts at `2003-04`. |
| IDs | Players and games: UUID strings. Teams: integers 1–30. |
| Caching | Responses carry `cache-control: no-store`. The server caches `/query` itself: finished seasons for 1 day, the current season and careers for 5 minutes. `meta.cached` tells you when a response was served from that cache. |

### Enumerations

| Name | Values |
|---|---|
| `season_type` (query param) | `regular` (default), `play_in`, `playoffs`, `all` (regular + play-in + playoffs), `cup` (NBA Cup games, 2023-24 on). |
| `season_type` (on a game) | `preseason`, `regular`, `cup_final`, `play_in`, `playoffs`. The Cup final doesn't count toward season stats. |
| `status` (game) | `scheduled`, `live`, `final`, `postponed`, `cancelled`. |
| `cup_stage` | `group`, `quarterfinal`, `semifinal`, `final`, or `null`. |
| `national_tv_tier` | `major` (ESPN/ABC/TNT/NBC/Prime), `nba_tv`, `local`. |
| `venue_split` / `venue` | `home`, `away`, `neutral`. Neutral games are in "All" but in neither Home nor Away. |
| `round` (series) | `play_in`, `first_round`, `conf_semis`, `conf_finals`, `finals`. |
| Positions | `G`, `F`, `C` (NBA.com's listing; a hybrid like `G-F` counts as its first position). |
| Prop markets | `pts`, `reb`, `ast`, `fg3m`, `pra` (pts+reb+ast), `pr`, `pa`, `ra`, `stl`, `blk`, `stocks` (stl+blk), `tov`. Labels come in `GET /props` `meta.markets`. |

---

## 2. Authentication

Two credentials, the same middleware, and the same API surface:

- **Humans (web, iOS):** a JWT access token (15 min) plus a rotating refresh
  token (30 days). Send `Authorization: Bearer <access_token>`.
- **Agents and services:** a long-lived API key (`ctnba_…`), sent as
  `X-API-Key: <key>`. Created with `npm run create-api-key -- <name>`.

Everything except `/health`, `/login`, `/refresh` and `/logout` needs one of
the two. There is no signup: JD creates accounts (`npm run create-user`).

### POST /login

```json
{ "username": "jd", "password": "…" }
```
→ `200`
```json
{ "access_token": "<jwt>", "refresh_token": "<opaque>", "token_type": "Bearer", "expires_in": 900 }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `username and password are required` / `… too long` | Bad input. |
| 401 | `invalid_credentials` | Wrong username **or** password; the two look the same on purpose. |
| 429 | `too_many_attempts` (+ `retry_after_seconds`, `Retry-After` header) | 10 failures for one account, or 30 from one IP, in 15 minutes. Only failures count. |

### POST /refresh

```json
{ "refresh_token": "<opaque>" }
```
→ `200` with a **new pair** (same shape as login). The old refresh token is
now dead.

| Status | `error` | Client should |
|---|---|---|
| 401 | `invalid_refresh_token` / `refresh_token_expired` | Sign out and show the login screen. |
| 401 | `refresh_token_reused` | Sign out. A rotated token was presented again, which is treated as theft, so the server has **revoked every session for that user**. |
| 429 | `too_many_attempts` | Wait `retry_after_seconds`. |

**Rotation rules for clients:**

- Store both tokens securely (iOS: Keychain; never UserDefaults).
- Only **one refresh may be in flight at a time**. If two requests hit a 401
  together and both refresh with the same token, the second attempt counts as
  reuse and signs the user out everywhere. The web app serializes refreshes;
  iOS must too (e.g. one actor that owns the tokens).
- On a 401 of `access_token_expired` or `invalid_access_token`: refresh once,
  retry the original request once, and sign out if it fails again.

### POST /logout

`{ "refresh_token": "<opaque>" }` → `204`. The call is idempotent; drop the
tokens locally either way.

### GET /health

Public. `{ "ok": true }`, or `503 { "ok": false }` when the database is down.

### Other auth errors (any protected endpoint)

`401` with `authentication_required` (no credential), `access_token_expired`,
`invalid_access_token`, or `invalid_api_key`.

---

## 3. POST /query — the stats engine

Every stat on every screen comes from here. It returns filtered averages or
totals computed at request time, **always with the sample size**.

### Request

| Field | Type | Notes |
|---|---|---|
| `entity` | `player` \| `team` | Default `player`. |
| `id` | UUID (player) / int (team) | Required except for `leaderboard`. |
| `scope` | `season` \| `last5` \| `last10` \| `career` \| `game_log` \| `leaderboard` | Default `season`. `leaderboard` is players only. |
| `season` | `"2025-26"` | Required for every scope except `career`. |
| `season_type` | see enums | Default `regular`. Types never mix unless `all`. |
| `splits` | object | Optional, below. **Splits apply first, then the window**: `last10` + `venue: "away"` = his last 10 road games. |
| `stat` | string | Leaderboards: `pts` (default), `reb`, `ast`, `stl`, `blk`, `fg3m`, `tov`, `minutes`, `plus_minus`, `usg_pct`. |
| `limit` | 1–50 | Leaderboards; default 10. |
| `lines` | `{ "<market>": <number> }` | Players, scopes `season` / `last5` / `last10` / `career`: adds `props` with over/under/push counts at each line over exactly these games. |

**Splits** (any combination):

| Key | Values | Meaning |
|---|---|---|
| `venue` | `"home"`, `"away"` | Neutral sites are in neither. |
| `player_rest` | `0`, `1`, `2`, `"3+"` | Days since **his** last game (matches NBA.com's player splits). Players only. |
| `player_b2b` | `1`, `2` | Night 1 / night 2 of **his** back-to-back. Players only. |
| `rest` | `0`, `1`, `2`, `"3+"` | Days since the **team's** last game. |
| `b2b` | `1`, `2` | Night of the **team's** back-to-back. |
| `national_tv` | `"major"`, `"nba_tv"`, `"local"` | |
| `altitude` | `true`, `false` | Denver, Utah, Mexico City (arenas at 4,000 ft or higher). |

The web player page defaults to `player_rest` / `player_b2b`, with a
"Team's schedule" toggle that switches to `rest` / `b2b`.

### Response (all scopes)

```json
{
  "query":   { "entity": "player", "id": "…", "scope": "season", "season": "2003-04", "seasonType": "regular", "splits": { "venue": "home" }, "stat": "pts", "limit": 10, "lines": { "pts": 20.5 } },
  "subject": { "type": "player", "id": "…", "name": "LeBron James" },
  "data":    { … },
  "props":   { "pts": { "line": 20.5, "over": 20, "under": 18, "push": 0, "games": 38 } },
  "meta": {
    "sample_size": 38,
    "record": "21-17",
    "filters_applied": { "season": "2003-04", "season_type": "regular", "venue": "home" },
    "notes": ["Neutral-site games (international, NBA Cup knockouts in Las Vegas, the 2020 Orlando bubble) are excluded from home/away."],
    "freshness": { "synced_at": "2026-09-27T04:05:06.873Z", "source": "nba_stats" },
    "cached": false
  }
}
```

- `query` echoes the validated request (note `seasonType` is camelCase here).
- `subject.type` is `player`, `team` (adds `abbreviation`), or `league` (leaderboards).
- `props` is present only when `lines` was sent.
- `meta.record` is the team's W-L in these games (`null` on leaderboards).
- **Show every `meta.notes` line** near the numbers. They explain exclusions and estimates.
- `sample_size: 0` with `data: null` is a normal empty state (e.g. no games on
  the second night of a back-to-back), not an error.

### `data` by scope

**`season` / `last5` / `last10` (player)**: one object (per-game averages +
season-sum ratios):

```json
{ "gp": 38, "pts": 21.3, "reb": 5.6, "ast": 6, "stl": 1.5, "blk": 1.1, "tov": 3, "fg3m": 0.8,
  "fgm": 8.1, "fga": 19.2, "fg3a": 2.7, "ftm": 4.3, "fta": 5.6, "oreb": 1.2, "dreb": 4.4, "pf": 1.7,
  "plus_minus": 1.5, "minutes": 39.1,
  "fg_pct": 0.422, "fg3_pct": 0.297, "ft_pct": 0.765,
  "ts_pct": 0.492, "efg_pct": 0.443, "ft_rate": 0.292,
  "pts_per36": 19.6, "reb_per36": 5.2, "ast_per36": 5.5, "usg_pct": 0.281 }
```

`usg_pct` is a box-score **estimate** (NBA.com uses play-by-play), so label
it "est.".

**Team** (same scopes): the same box-score averages minus the per-36 fields
and `usg_pct`, plus `opp_pts`, `off_rtg` and `def_rtg` (per 100 estimated
possessions, labelled "est."). `minutes` is team minutes (240 plus 25 per
overtime).

**`career` (player)**: `{ "totals": {…same fields as season…}, "by_season": [ { "season": "2003-04", "team": "CLE", …same fields… } ] }`.
`team` is `"CLE/MIA"`-style when he played for several teams that season. A
note appears when his career started before 2003-04, because those seasons
aren't included.

**`game_log`**: an array, newest first.

Player row:
```json
{ "game_id": "…", "date": "2004-04-14", "season": "2003-04", "season_type": "regular", "venue": "away",
  "opponent": "NYK", "won": true, "rest_days": 1, "b2b_night": null, "national_tv_tier": "local",
  "altitude": false, "player_rest_days": 1, "player_b2b_night": null, "started": null,
  "pts": 17, "reb": 1, "ast": 5, "stl": 3, "blk": 0, "tov": 5, "fg3m": 0, "fgm": 8, "fga": 17,
  "fg3a": 3, "ftm": 1, "fta": 1, "oreb": 0, "dreb": 1, "pf": 1, "plus_minus": -6, "minutes": 35,
  "props": { "pts": { "line": 25.5, "result": "under" } } }
```
`props` is `null` when no DraftKings line was pulled for that game; otherwise
it maps market → closing line (opening if no close) and `result`: `over`,
`under` or `push`.

Team row: `game_id, date, season, season_type, venue, opponent, won, pts, opp_pts, rest_days, b2b_night, national_tv_tier, altitude`.

**`leaderboard`**:
```json
"data": [ { "rank": 1, "player_id": "…", "full_name": "LeBron James", "gp": 79, "value": 20.9, "team": "CLE" } ],
"meta": { "qualifier": { "min_games": 58, "team_games": 82, "qualified_players": 142 }, "notes": ["Qualifier: played in at least 70% of team games (58 of 82) — Chalk That's rule, not the NBA's official one."] }
```
`value` is a per-game average, or for `usg_pct` a 0–1 share. The usage board
also requires 15+ minutes per game (`qualifier.min_minutes: 15`) and adds an
"estimated" note. Leaderboards take no splits and no `play_in` / `cup` type.

### Errors

`400` for bad input, with the problem named (`season must look like 2025-26`,
`unknown split "x" (allowed: …)`, `split venue must be one of "home", "away"`,
`splits are not supported on leaderboards (v1)`, …). `404` with `player not
found` / `team not found`. Tests guarantee a bad request never returns 500.

---

## 4. Browse

### GET /seasons
Seasons with finished games (no preseason), newest first. Drives every
season picker.
```json
{ "data": [ { "season": "2025-26", "types": ["play_in", "playoffs", "regular"], "final_games": 1320 } ],
  "meta": { "current_season": "2026-27", "latest_with_games": "2025-26" } }
```
Default the season picker to `latest_with_games`. `current_season` can be
ahead of it before opening night.

### GET /teams
All 30, ordered by conference, division, then name.
```json
{ "data": [ { "id": 4, "abbreviation": "BOS", "city": "Boston", "name": "Celtics", "full_name": "Boston Celtics",
  "conference": "East", "division": "Atlantic", "arena": "TD Garden", "arena_city": "Boston",
  "elevation_ft": 46, "is_high_altitude": false } ] }
```

### GET /teams/:id
The team row plus `roster` (active players: `id, full_name, listed_position,
height_in, weight_lb, birth_date`) and `season_types` (season → types played,
including `"cup"` when it played Cup games). Use `season_types` to disable
season types the team didn't play. `404 team not found`.

### GET /teams/:id/players?season=YYYY-YY&season_type=
Everyone who played for the team that season, trades included, sorted by
points: `[ { "player_id", "full_name", "gp", "minutes", "pts", "reb", "ast" } ]`,
`meta: { season, season_type, count }`. `season` is required.

### GET /players?q=&active=&team=
Name search that ignores accents, suffixes and punctuation (`jokic`, `pj`,
`cook`). `active` defaults to `true`; send `active=false` to include retired
players. `team` = team id. Capped at 100 results.
```json
{ "data": [ { "id": "…", "full_name": "LeBron James", "listed_position": "F", "is_active": true,
  "first_season_start": 2003, "team_id": 13, "team": "LAL" } ],
  "meta": { "total": 1, "truncated": false, "active_only": false } }
```

### GET /players/:id
The player row (`full_name, first_name, last_name, birth_date, listed_position,
height_in, weight_lb, current_team_id, is_active, first_season_start, team,
team_name`) plus:
- `seasons`: seasons he played, newest first.
- `season_types`: season → types he played, so the UI can say "didn't play
  in the playoffs" instead of showing an unexplained zero.
- `current_injury`: `{ status, description, reported_at, source }` or `null`.
  No injury feed is live yet, so this is always `null` for now (see §10).

### GET /games?date=YYYY-MM-DD
The scoreboard for one local date.
```json
{ "data": [ { "id": "…", "season": "2003-04", "season_type": "regular", "cup_stage": null, "date": "2003-10-30",
  "tipoff_utc": "2003-10-31T03:30:00.000Z", "status": "final", "is_neutral_site": false,
  "national_tv_tier": "major", "national_broadcasters": ["TNT"], "home": "PHX", "home_score": 95,
  "away": "CLE", "away_score": 86, "arena": "US Airways Center", "arena_city": "Phoenix",
  "series_round": null, "series_game_number": null } ],
  "meta": { "date": "2003-10-30", "count": 2, "prev_date": "2003-10-29", "next_date": "2003-10-31" } }
```
`prev_date` / `next_date` are the nearest dates that have games, so date
arrows can skip the All-Star break and the offseason. Scores are `null` until
a game starts. The worker updates live scores about every 5 minutes, so a
screen showing live games can re-fetch on that interval.

### GET /games/:id
The box score.
```json
{ "data": {
  "game": { "id": "…", "season": "…", "season_type": "…", "cup_stage": null, "playoff_series_id": null,
    "series_game_number": null, "game_date_local": "2003-10-30", "tipoff_utc": "…", "home_team_id": 1,
    "away_team_id": 18, "is_neutral_site": true, "national_tv_tier": "nba_tv", "national_broadcasters": ["NBA TV"],
    "status": "final", "home_score": 109, "away_score": 100, "arena": "Saitama Super Arena", "arena_city": "Tokyo",
    "is_high_altitude": false, … },
  "teams": [ {
    "team_id": 18, "abbreviation": "LAC", "full_name": "LA Clippers", "opponent_team_id": 1,
    "venue_split": "neutral", "rest_days": null, "b2b_night": 1, "won": false,
    "minutes": 240, "pts": 100, "fgm": 38, "fga": 91, … "plus_minus": -9,
    "players": [ { "player_id": "…", "full_name": "LeBron James", "team_id": 7, "started": true, "dnp": false,
      "dnp_reason": null, "minutes": 41, "pts": 21, … "player_rest_days": 0, "player_b2b_night": 2 } ] } ] } }
```
`teams[0]` is the **away** team. Players come starters first, then by
minutes, with DNPs last (`dnp: true`, `dnp_reason`). `started` is `null` for
older games where NBA.com doesn't say. The split tags (`venue_split`,
`rest_days`, `b2b_night`, and the player versions) are the same tags the
filters use.

---

## 5. League

### GET /standings?season=
Defaults to the latest regular season with games.
```json
{ "data": { "East": [ { "team_id": 4, "abbreviation": "BOS", "name": "Boston Celtics", "conference": "East",
  "division": "Atlantic", "wins": 56, "losses": 26, "pct": 0.683, "home": "31-10", "road": "25-16",
  "conf": "36-16", "last10": "7-3", "streak": "W 2", "rank": 2, "rank_source": "nba_stats",
  "clinch": "x", "gb": 4 } ], "West": [ … ] },
  "meta": { "season": "2025-26", "games": 1230, "format": { "playoff_seeds": 6, "play_in_seeds": [7, 8, 9, 10] },
    "notes": ["Home/road leave out neutral-site games, as NBA.com does."] } }
```
Rows arrive already in rank order. `clinch` is NBA.com's clinch mark as
given (e.g. `x`, `y`, `z`, `pi`, `o`), or `null`. `rank_source` is `nba_stats` (NBA.com's
official rank, tiebreakers included) or `computed` (win %, until the official
standings sync). Use `meta.format` to draw the playoff and play-in cut
lines; it changes by era (8 seeds before 2019-20, the 2019-20 bubble's 8v9,
6 + play-in from 2020-21).

### GET /bracket?season=
One row per series (play-in games count as series with `best_of` 1 or 2):
```json
{ "data": [ { "id": 7, "round": "play_in", "conference": "West", "bracket_slot": "W-8v9", "best_of": 2,
  "higher_seed": 8, "lower_seed": 9, "higher_id": 15, "higher_abbr": "POR", "higher_name": "Portland Trail Blazers",
  "lower_id": 26, "lower_abbr": "MEM", "lower_name": "Memphis Grizzlies", "winner_team_id": 15,
  "higher_wins": 1, "lower_wins": 0, "first_game": "2020-08-15", "last_game": "2020-08-15" } ],
  "meta": { "season": "2019-20", "format": { … }, "count": 1 } }
```
`conference` is `null` for the Finals. Team fields are `null` until a
matchup is set. The web draws the classic order: 1v8, 4v5, 3v6, 2v7.

---

## 6. Rankings

Shared parameters: `season` (default latest), `season_type` (`regular` |
`playoffs` | `all`), `scope` (`season` | `last10`).

### GET /rankings/players?position=G|F|C&limit=1-200
Players ranked by an equal-weight z-score composite over eight stats (pts,
reb, ast, stl, blk, fg3m, ts_pct, and tov counted negatively). Same 70% games
qualifier as the leaderboards. Each row has the stats **and every z-score**,
so the UI can show how the score was built:
```json
{ "rank": 1, "player_id": "…", "name": "Nikola Jokić", "team": "DEN", "listed_position": "C", "gp": 65,
  "pts": 27.7, "reb": 12.9, "ast": 10.7, "stl": 1.4, "blk": 0.8, "fg3m": 1.8, "tov": 3.3, "minutes": 36.2,
  "ts_pct": 0.66, "z": { "pts": 2.1, … }, "score": 1.63 }
```
`meta`: `position_label`, `stats` (the eight names), `qualifier`, `count`, `notes`.

### GET /rankings/teams
```json
{ "team_id": 24, "abbr": "DAL", "name": "Dallas Mavericks", "gp": 82, "w": 50, "l": 32, "pts": 117.9,
  "opp_pts": 115.4, "off_rtg": 116.2, "def_rtg": 113.8, "net_rtg": 2.4, "pace": 101.4,
  "ranks": { "off_rtg": 5, "def_rtg": 12, "net_rtg": 8, "pace": 9 } }
```
Rows are sorted by net rating. Rank 1 = best; for `def_rtg` the lowest wins.
Ratings are estimates (see `meta.notes`).

### GET /rankings/matchups?team_id=
What each defense allows per game to guards, forwards and centers, in every
prop market:
```json
{ "data": { "G": [ { "team_id": 11, "abbr": "ATL", "games": 82,
      "allowed": { "pts": 49.1, "reb": 14.2, … }, "vs_avg": { "pts": 1.3, … },
      "rank": { "pts": 24, … }, "label": { "pts": "weak", … } } ], "F": [ … ], "C": [ … ] },
  "league_avg": { "G": { "pts": 47.8, … }, "F": { … }, "C": { … } },
  "meta": { "teams": 30, "unlisted_share": 0, "notes": [ … ] } }
```
Rank 1 = allows the fewest (a strong defense). `label` is `strong` (best 5),
`weak` (worst 5) or `null`, and only appears once 10 or more teams have
games. `team_id` filters to one team (used on the team page).

---

## 7. Props (DraftKings via The Odds API)

These are counts against real lines, not picks. Lines are pulled twice per
game: the opening line (morning) and the closing line (about 30 minutes
before tip). Every endpoint uses the closing line once it exists.

### GET /props?date=&market=
The board for one ET date (default: today if it has lines, else the next
date that does). `market` defaults to `pts`.
```json
{ "data": [ {
    "game_id": "…", "player_id": "…", "name": "Jayson Tatum", "team": "BOS", "opponent": "NYK", "venue": "away",
    "line": 26.5, "over_price": -115, "under_price": -105, "snapshot": "close", "fetched_at": "…", "open_line": 25.5,
    "actual": null, "result": null,
    "last10": { "over": 6, "under": 4, "push": 0, "games": 10, "avg": 27.9 },
    "season": { "over": 0, "under": 0, "push": 0, "games": 0, "avg": null },
    "last_season": { … },
    "matchup": { "position": "F", "position_label": "Forwards", "rank": 27, "of": 30, "allowed": 51.2,
                 "vs_avg": 3.1, "label": "weak", "games": 12, "opponent": "NYK" } } ],
  "games": [ { "id": "…", "tipoff_utc": "…", "status": "scheduled", "home": "NYK", "away": "BOS",
               "home_score": null, "away_score": null, "season_type": "regular", "lines": 14,
               "open_pulled": true, "close_pulled": false } ],
  "meta": { "date": "2026-10-21", "market": "pts", "market_label": "Points",
            "markets": [["pts", "Points"], ["reb", "Rebounds"], …], "season": "2026-27",
            "prev_date": null, "next_date": "2026-10-22", "book": "DraftKings", "count": 14, "notes": [ … ] } }
```
- Prices are American odds (integers).
- `result` is `over`, `under` or `push` once the game is final, `dnp` if he
  didn't play (no action), and `null` before then. `actual` is his number.
- Hit rates count only his games **before** this date, at **this** line.
  `last_season` appears while he has fewer than 10 games this season.
- `matchup` is `null` until the opponent has played 5 games, or when the
  player has no listed position.
- `prev_date` / `next_date` jump between dates that have lines.

### GET /players/:id/props
```json
{ "data": {
    "upcoming": { "game": { "id": "…", "date": "2026-10-21", "tipoff_utc": "…", "status": "scheduled", "home": "NYK", "away": "BOS" },
                  "lines": [ { "market": "pts", "label": "Points", "line": 26.5, "over_price": -115, "under_price": -105,
                               "snapshot": "close", "fetched_at": "…", "open_line": 25.5 } ] },
    "record": { "pts": { "label": "Points", "over": 12, "under": 9, "push": 1, "games": 22 } } },
  "meta": { "player": "Jayson Tatum", "book": "DraftKings" } }
```
`upcoming` is his next scheduled or live game that has lines, or `null`.
`record` is his over/under record against every line we have for finished
games. The web player page's "Prop check" sends `upcoming.lines` as
`POST /query` `lines`, to see how he did at tonight's numbers under any split.

---

## 8. Health and data freshness

`meta.freshness.synced_at` on `/query` is when the last successful ingestion
run finished. The worker keeps the current season fresh (scores every 5 min
during game windows, box scores at the final whistle), and NBA.com
reconciles weekly.

---

## 9. POST /ask — plain-English search

Claude Haiku turns the question into a **plan** (which query to run). The
server resolves names, runs the plan through this same API with the
caller's own credentials, and builds the sentence from a template over the
returned numbers. The model never writes a number.

**Request:** `{ "q": "Jokic on the second night of back to backs" }` (2–300
characters), **or** `{ "plan": { … } }` to re-run an edited plan with no
model call (this is what removing a chip does).

**Response:**
```json
{ "question": "…", "plan": { "kind": "player_stats", "player": "LeBron James", "season": "2003-04", "venue": "away" },
  "cached": false, "model": "claude-haiku-4-5",
  "subject": { "player": { "id": "…", "name": "LeBron James" }, "team": null, "opponent": null },
  "sentence": "LeBron James averaged 20.6 points, 5.3 rebounds and 5.8 assists in 41 2003-04 regular season games on the road (his team went 12-29).",
  "view": { "type": "stats", "query": { …a full POST /query response… } },
  "chips": [ { "key": "season", "label": "2003-04", "removable": true }, { "key": "venue", "label": "Away", "removable": true } ],
  "link": "/players/…?season=2003-04&venue=away",
  "season": "2003-04" }
```

- `plan.kind` is one of `player_stats`, `team_stats`, `leaders`,
  `player_rankings`, `team_rankings`, `matchups`, `props`, `standings`,
  `game`, `series`, `unsupported`.
- `view.type` says what to draw: `stats` (a `/query` response), `leaders`
  (`rows`, `stat`, `meta`), `player_rankings`, `team_rankings`, `matchups`,
  `props`, `standings`, `game`, `series`, `unsupported`, or `clarify`. The
  web renderer is `View` in `frontend/src/pages/Ask.jsx`.
- **Clarify:** for an ambiguous name, `sentence` is a question and
  `clarify: { field: "player" | "team" | "opponent", options: [ { id, name } ] }`.
  Show the options; picking one re-runs with `{ plan: { …plan, [field]: option.name } }`.
- **Chips:** removing chip `key` means deleting that key from `plan` and
  POSTing `{ plan }`. `unsupported` answers have no chips.
- `link` is a **web** path, so map it to the matching native screen.
- Limits: 20 model calls per minute and 300 per day per user (cached
  questions and `{plan}` re-runs are free). Returns `429` with a message.
  `503` if the server has no model key. `422` when the underlying query
  failed (the message says why).

---

## 10. Known gaps clients should expect

- **Injuries:** `current_injury` is always `null` until a feed is confirmed
  (injury probe running in preseason 2026-27). Build the badge so it hides
  when the value is `null`.
- **Estimates** (label them "est."): team ratings and pace, and usage rate.
  Everything else matches NBA.com, and tests pin real published numbers.
- **History starts 2003-04.** Careers that began earlier are partial, and a
  `meta.notes` line says so.
- **Props:** DraftKings only, from 2026-27 on (no history backfill).
