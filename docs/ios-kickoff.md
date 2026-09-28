# Chalk That NBA iOS — Kickoff

Start here for the native iOS app. It's a **second client of the existing
`backend-api`**, not a new product: the same accounts, the same numbers, and
no backend changes needed to ship it. Written 2026-09-28, when the web app
was complete (v1 plus props, rankings, search and usage rate).

Read with:
- **`docs/api.md`**: the contract. Every endpoint, field, enum and error the
  app will see.
- **`PLATFORM.md`**: Chalk That platform rules (one API for every client,
  sample size on every number, no predictions).
- The **Chalk That NFL iOS app** (`ai-application-nfl-ios`): the architecture
  to copy. It's fully built and was submitted to the App Store (2026-09-24),
  so solved problems
  (auth actor, design tokens, networking) should be reused, not redesigned.

---

## 1. Ground rules

1. **Data parity with the web app.** Every number on a web screen is on the
   matching iOS screen, from the same endpoint with the same filters.
2. **No client-side stats.** No invented or derived numbers: no confidence
   scores, projections or win probability, and no recomputed averages. The
   app formats what the API returns. (Reshaping is fine, e.g. picking the
   row for tonight's opponent out of a list.)
3. **Sample size is always visible.** Every stat view shows `sample_size`
   ("38 games") and the team record, and renders every `meta.notes` line.
4. **Estimates say "est."**: team ratings and pace, and usage rate.
5. **Empty states are designed, not accidental**, for preseason, offseason,
   a rookie, a retired player, a split with zero games, and a season type
   not reached (e.g. the team missed the playoffs). The API returns
   `sample_size: 0` / empty arrays for all of these, never errors.
6. **Out of scope:** data operations (backfills, syncs, user and key
   creation) and self-serve signup, as on the web. Accounts are created by JD.

## 2. Architecture (mirror the NFL iOS app)

- Swift + SwiftUI, MVVM, `URLSession` + async/await, **no third-party
  dependencies**, minimum iOS 16 (match NFL unless there's a reason not to).
- Folders: `Models/ ViewModels/ Views/ Network/ Services/ Extensions/`.
- `Color+Brand.swift`: the single source of truth for design tokens (§5).
- **`Network/APIClient`**: base URL from the build config (Debug →
  localhost or staging, Release → the Railway `backend-api` domain).
  Snake-case JSON via `JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase`.
  Errors decode from `{ "error": String }`, and that message is safe to show.
- **`Services/AuthStore` (an `actor`)** owns the tokens (Keychain). It
  serializes refreshes: one refresh in flight at a time, so concurrent 401s
  wait for it. A reused refresh token revokes **every** session on the
  server (`api.md` §2), so this is a correctness requirement, not an
  optimization. On any refresh failure → sign out → Login.
- **Decoding:**
  - Numbers are always JSON numbers (the box score `minutes` string was fixed
    2026-09-28).
  - Dates (`YYYY-MM-DD`) are calendar dates: decode as `String` or a
    `DateComponents` wrapper, never as a `Date` in UTC.
  - `tipoff_utc` is ISO-8601 with fractional seconds.
  - IDs: players and games are `String` (UUID), teams are `Int`.
- **Query model:** one `StatQuery` struct that encodes to the `POST /query`
  body (`entity, id, scope, season, season_type, splits, stat, limit,
  lines`). Splits as an enum-keyed dictionary; `rest` / `player_rest` take
  `0 | 1 | 2 | "3+"`, so encode that as a small enum with a custom encoder.
- **Responses** are generic over `data`: `QueryResponse<T>` with `query`,
  `subject`, `data`, `props?`, `meta`. `data` differs by scope (object, the
  career `{totals, by_season}`, or an array), so use one type per scope.

## 3. Screens → endpoints

The web routes are in `frontend/src/App.jsx`. Tabs are a suggestion: the
web has 8 section links plus a Guide page, and iOS should fit them into 5 tabs.

| # | Screen | Endpoints | Notes / parity details |
|---|---|---|---|
| 1 | Login | `POST /login` | Username + password only. Show `retry_after_seconds` on a 429. |
| 2 | **Scoreboard** (landing) | `GET /games?date=` | Date arrows use `meta.prev_date` / `next_date` (skip empty days). Card: teams, score or tip time (viewer's timezone), status, TV (`national_broadcasters`), context line (playoff round + game, Cup stage, Play-In, preseason, "in Tokyo" for neutral sites). Optional: re-fetch about every 60 s while a game is `live` (the web doesn't poll; the worker updates scores about every 5 min). |
| 3 | Box score | `GET /games/:id` | Header, then per team (away first): split tags (venue, rest days, B2B night, altitude, TV), player table (Min, Pts, Reb, Ast, FG, 3PT, FT, Stl, Blk, TO, +/-), starters marked, DNPs listed with reason, team totals. |
| 4 | Standings | `GET /standings`, `GET /bracket`, `GET /seasons` | Table \| Playoffs toggle. Cut lines from `meta.format`. Bracket in classic order (1v8, 4v5, 3v6, 2v7) plus play-in; series score from `higher_wins` / `lower_wins`. |
| 5 | Teams | `GET /teams` | Grouped by conference, then division. |
| 6 | Team detail | `GET /teams/:id`, `POST /query` (entity team), `GET /teams/:id/players`, `GET /rankings/matchups?team_id=` | The same stat explorer as players (§4) with team fields (Opp pts, Off/Def/Net rtg est.). Also "who played for us" (trades included) and "Defense by position" (G/F/C allowed, rank, strong/weak). |
| 7 | Players | `GET /players?q=&active=&team=` | Search with an **Active toggle, on by default**; off searches everyone since 2003-04. Team filter. When `meta.truncated`: "Showing the first 100 of N players — type a name to narrow it down". |
| 8 | **Player detail** | `GET /players/:id`, `POST /query`, `GET /players/:id/props` | The core screen (§4). Injury badge from `current_injury` (hidden while `null`). |
| 9 | Leaders | `POST /query` scope `leaderboard` | Stat tabs: Points, Rebounds, Assists, 3-pointers, Steals, Blocks, Usage (web order). Season + Regular/Playoffs/All. "Who qualifies" card from `meta.qualifier` (70% of team games; usage also 15+ min). Usage shown as `28.3%` with the "est." note. |
| 10 | Rankings | `GET /rankings/players\|teams\|matchups` | Three views. Players: position G/F/C, scope Season/Last 10, score plus a breakdown of all eight z-scores. Teams: sort by net/off/def/pace with ranks. Matchups: position × market table, strong/weak marks. |
| 11 | Props | `GET /props?date=&market=` | Date arrows (dates with lines only), market picker (12 markets from `meta.markets`). Per line: line and movement (open → close), prices, L10 and season hit rates, matchup note, result after the final. Counts, not picks. |
| 12 | Ask | `POST /ask` | Search box and example questions. Answer = `sentence` + a view by `view.type` + removable chips (re-POST `{plan}`) + clarify buttons. Map `link` to a native screen. Page eyebrow: "Plain English · verified numbers". |
| 13 | Guide | none (static) | The user guide: port the text of `frontend/src/pages/Guide.jsx` (sections plus jump links). Reachable from the More/League tab or a "?" in the nav bar. Keep it in sync when screens change. |

## 4. The stat explorer (player and team detail)

This is the heart of the app. On the web it's
`frontend/src/components/StatExplorer.jsx`.

- **Scope tabs:** Season Avg · Last 5 · Last 10 · Career · Game Log.
- **Season picker:** from `/players/:id` `seasons` (or `/seasons`).
  **Season type:** Regular (default) / Play-In / Playoffs / All / NBA Cup,
  with types he didn't play (`season_types[season]`) disabled or explained.
- **Splits panel:**
  - Rest measured by *His games* (default: `player_rest` / `player_b2b`) or
    *Team's schedule* (`rest` / `b2b`).
  - Venue All/Home/Away; Back-to-back All/Night 1/Night 2; Rest days
    All/0/1/2/3+; National TV All/Major/NBA TV/Local; Altitude
    All/At altitude/Not.
  - A "Clear splits" button. Footnote: splits apply first, then Last 5/10.
- **Result header:** "Season average · 79 games", then the record in these
  games and the season/type ("33-46 in these games · 2003-04 regular
  season").
- **Tiles (player):** Points, Rebounds, Assists, 3PM, FG%, Steals, Blocks,
  Turnovers, Minutes, +/-.
  **Efficiency & usage:** TS%, eFG%, FT rate, Pts/36, Reb/36, Ast/36,
  Usage (est.).
- **Tiles (team):** Points, Opp points, Rebounds, Assists, 3PM, FG%, 3P%,
  Steals, Blocks, Turnovers. **Efficiency:** Off rtg (est.), Def rtg (est.),
  Net rtg (est.), TS%, eFG%.
- **Career:** a totals row plus a by-season table (GP, MIN, PTS, REB, AST,
  3PM, STL, BLK, TOV, FG%, TS%). Show the "stats begin 2003-04" note when present.
- **Game log:** newest first; tapping a row opens the box score. Columns
  (player): Date, Opp, Result, Min, Pts, Reb, Ast, 3PM, FG, +/-, Pts line
  (DraftKings line + result, blank when `props` is null), Tags. Team: Date,
  Opp, Result, Tags.
- **Prop check (players):** when `/players/:id/props` has `upcoming`, show
  tonight's lines. Send them as `lines` on the current query and show
  "over 25.5 in 7 of his last 10 road games" from `props` in the response.
- **Footer:** "From NBA.com game logs · synced 1 day ago", from `meta.freshness`.

## 5. Design tokens (dark, the Chalk That family)

These match the NFL app and the web's `frontend/src/index.css`:

| Token | Hex | Use |
|---|---|---|
| paper | `#0B0F14` | App background |
| card | `#121820` | Cards / surfaces |
| card-2 / rule | `#1A222C` | Raised surface, row dividers |
| line | `#2A3540` | Borders |
| strong | `#3E4B58` | Heavy table rules |
| field | `#3A4652` | Input borders |
| ink | `#F5F7FA` | Primary text |
| muted | `#9AA7B4` | Secondary text |
| faint | `#62717D` | Tertiary text, "NBA" in the wordmark |
| link | `#4D9FEC` (hover `#7AB8F2`) | Links / tappable names |
| accent | `#F4762B` (hover `#FF8A45`) | Selected pill/tab, primary button |
| on-accent | `#0B0F14` | Text on accent |
| alt-bg / alt-ink | `#3A2415` / `#FFB27A` | Highlight chips |
| live | `#F2545B` | Live games |
| positive / positive-bg | `#34D399` / `#0F2E24` | Over / strong |
| caution | `#E8B64A` | Warnings, estimates |

Fonts: **Oswald** for display (titles, big numbers; bundle it) and
**Inter** or the system font for text. Numbers use tabular figures
(`.monospacedDigit()`). The wordmark is "CHALK THAT **NBA**" with NBA in
`faint`.

## 6. Formatting (must match the web: `frontend/src/lib/format.js`)

| Value | Format |
|---|---|
| Per-game averages, per-36, ratings | 1 decimal: `20.9`, `2.0` (not `2`) |
| FG%, 3P%, FT%, TS%, eFG%, FT rate | `.488`; `1.000` at 100% |
| Usage | `28.3%` |
| +/-, net rating, vs avg | Signed: `+1.5`, `-2.6` |
| Box-score minutes | Rounded whole number |
| Dates | `Sunday, April 12, 2026` / `Sun, Apr 12, 2026` / `Apr 12` (no timezone math) |
| Tip-off | Viewer's local time, `7:30 PM`; `Time TBD` when `null` |
| Rest | `1 day rest` · `0 days rest · 2nd night of a back-to-back` · `no prior game this season` |
| Playoff context | `First round · Game 2`, `NBA Finals · Game 7` (from `series_round` values) |

## 7. Build order (suggested)

1. Project skeleton, `Color+Brand`, fonts, `APIClient`, `AuthStore`
   (Keychain + single-flight refresh), Login. Test: sign in, force an
   expired token, confirm exactly one refresh.
2. Scoreboard → Box score (proves models, dates, live refresh).
3. Players search → Player detail with the full stat explorer (the biggest
   piece; do it early).
4. Teams → Team detail (reuses the explorer in team mode, plus defense by
   position).
5. Leaders, Standings (table + bracket).
6. Rankings, Props board, Prop check on player detail, Guide.
7. Ask.
8. Empty states pass, accessibility (Dynamic Type, VoiceOver labels on
   tiles), iPhone SE through Pro Max layouts, App Store assets.

## 8. Parity checklist (the done bar)

Pick the same filters on web and iOS, and the numbers must match exactly:

- [ ] LeBron 2003-04 regular: 79 GP, 20.9 / 5.5 / 5.9, TS .488, usage 28.3%.
- [ ] LeBron 2003-04 by his rest 0/1/2/3+: 20/40/12/7 games.
- [ ] Jokić 2025-26: 65 GP, 27.7 PPG; Last 10 + Away matches the web.
- [ ] Leaders 2025-26 points: Dončić 33.5 in 64; the qualifier card reads 58 of 82.
- [ ] A 2025-26 box score: every player line matches the web and NBA.com.
- [ ] Standings 2025-26 ranks and clinch marks match the web; bracket series scores match.
- [ ] Props board on a game day: same lines, hit rates and matchup notes as the web.
- [ ] Ask "Jokic on the second night of back to backs": same sentence and numbers as the web.
- [ ] Every empty state from §1.5 renders a message, never a blank or an error.
- [ ] Sign-out on another device's token reuse: the app returns to Login cleanly.

## 9. Decide at kickoff (with JD)

- Repo name (suggest `ai-application-nba-ios`) and bundle ID.
- Tab bar: which 5 (suggest Scores · Players · Leaders · Props · Ask, with
  Teams / Standings / Rankings reachable from a "More" or League tab).
- Whether Ask ships in 1.0 (it costs Anthropic credits per question) or 1.1.
- Staging backend: point Debug at production (read-only use), or add a
  Railway staging environment.
- Share links: map the web's URL state (`?season=…&venue=away`) to
  universal links now or later.
