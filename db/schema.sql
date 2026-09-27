-- Chalk That NBA — Postgres schema
-- Source of truth for decisions: docs/architecture.md (§3.2 sources, §4 schema,
-- §6.1 split definitions) and PLATFORM.md §2 (canonical ids + crosswalk,
-- situational data tagged at ingestion, no stored derived stats).
--
-- Conventions:
--   * Canonical ids are minted here, never a vendor's id. Vendor ids live
--     only in entity_id_crosswalk.
--   * Enumerations are TEXT + CHECK (cheap to extend without a type migration).
--   * Situational split tags are plain columns written at ingestion:
--       game-level  -> games   (season_type, is_neutral_site, national_tv_tier, arena -> altitude)
--       team-level  -> team_games (venue_split, rest_days, b2b_night)
--   * No aggregates are stored. Season averages, leaderboards, and split
--     results are computed at query time and cached in Redis.
-- Requires Postgres 13+ (gen_random_uuid() in core).

BEGIN;

-- ---------------------------------------------------------------------------
-- Reference: arenas, teams, players
-- ---------------------------------------------------------------------------

CREATE TABLE arenas (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  city              TEXT NOT NULL,
  state             TEXT,                          -- null outside US/Canada
  country           TEXT NOT NULL DEFAULT 'USA',
  elevation_ft      INTEGER,                       -- stored for every arena
  -- Derived at ingestion from elevation_ft (Denver + Utah per §6.1). Kept as a
  -- plain column so the altitude split is a WHERE, not a threshold compare.
  is_high_altitude  BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (name, city)
);

CREATE TABLE teams (
  id               SERIAL PRIMARY KEY,             -- canonical team id
  abbreviation     TEXT NOT NULL UNIQUE,           -- canonical (NBA.com style: GSW, UTA, NOP)
  city             TEXT NOT NULL,
  name             TEXT NOT NULL,                  -- "Warriors"
  full_name        TEXT NOT NULL UNIQUE,           -- "Golden State Warriors"
  conference       TEXT NOT NULL CHECK (conference IN ('East', 'West')),
  division         TEXT NOT NULL,
  home_arena_id    INTEGER REFERENCES arenas (id)
);

CREATE TABLE players (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- canonical player id
  full_name        TEXT NOT NULL,
  first_name       TEXT,
  last_name        TEXT,
  birth_date       DATE,
  listed_position  TEXT,                           -- roster listing (G, F, C, G-F, ...)
  height_in        SMALLINT,
  weight_lb        SMALLINT,
  current_team_id  INTEGER REFERENCES teams (id),  -- roster display only; per-game team lives on stat rows
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX players_full_name_idx    ON players (lower(full_name));
CREATE INDEX players_current_team_idx ON players (current_team_id);

-- One table for every vendor id of every entity type (PLATFORM.md §2).
-- canonical_id is TEXT because it points at different key types
-- (teams.id int, players.id uuid, games.id uuid).
CREATE TABLE entity_id_crosswalk (
  id             BIGSERIAL PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('team', 'player', 'game')),
  canonical_id   TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('nba_stats', 'highlightly', 'odds_api')),
  source_id      TEXT NOT NULL,
  match_status   TEXT NOT NULL DEFAULT 'matched'
                 CHECK (match_status IN ('matched', 'manual_review', 'rejected')),
  match_method   TEXT,                             -- e.g. 'exact_id', 'name+team+date', 'manual'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, source, source_id)
);
CREATE INDEX crosswalk_canonical_idx ON entity_id_crosswalk (entity_type, canonical_id);
CREATE INDEX crosswalk_review_idx    ON entity_id_crosswalk (match_status) WHERE match_status = 'manual_review';

-- ---------------------------------------------------------------------------
-- Season structure: playoff_series (play-in + bracket), games
-- ---------------------------------------------------------------------------

-- Play-in games are modeled as best-of-1 "series" so the whole path to the
-- title is one structure. bracket_slot examples:
--   play-in:  'E-7v8', 'E-9v10', 'E-8seed'   (loser 7v8 vs winner 9v10)
--   playoffs: 'E-R1-1v8', 'E-R2-A', 'E-CF', 'FINALS'
CREATE TABLE playoff_series (
  id                   SERIAL PRIMARY KEY,
  season               TEXT NOT NULL CHECK (season ~ '^[0-9]{4}-[0-9]{2}$'),  -- '2025-26'
  round                TEXT NOT NULL
                       CHECK (round IN ('play_in', 'first_round', 'conf_semis', 'conf_finals', 'finals')),
  conference           TEXT CHECK (conference IN ('East', 'West')),
  bracket_slot         TEXT NOT NULL,
  -- best-of-2: the 2019-20 bubble play-in (8th seed needed 1 win, 9th needed 2).
  best_of              SMALLINT NOT NULL CONSTRAINT playoff_series_best_of_check CHECK (best_of IN (1, 2, 7)),
  higher_seed          SMALLINT CHECK (higher_seed BETWEEN 1 AND 10),
  lower_seed           SMALLINT CHECK (lower_seed BETWEEN 1 AND 10),
  higher_seed_team_id  INTEGER REFERENCES teams (id),  -- null until the matchup is set
  lower_seed_team_id   INTEGER REFERENCES teams (id),
  winner_team_id       INTEGER REFERENCES teams (id),  -- a fact, not a derived count
  UNIQUE (season, bracket_slot),
  CHECK ((round = 'finals') = (conference IS NULL)),
  CONSTRAINT playoff_series_playin_length CHECK (round <> 'play_in' OR best_of IN (1, 2)),
  CONSTRAINT playoff_series_playoff_length CHECK (round = 'play_in' OR best_of = 7),
  CHECK (winner_team_id IS NULL OR winner_team_id IN (higher_seed_team_id, lower_seed_team_id))
);

CREATE TABLE games (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- canonical game id
  season                 TEXT NOT NULL CHECK (season ~ '^[0-9]{4}-[0-9]{2}$'),
  -- cup_final is its own type because it does NOT count toward season stats
  -- (NBA.com game-id prefix 006). Cup group/QF/SF games are 'regular'.
  season_type            TEXT NOT NULL
                         CHECK (season_type IN ('preseason', 'regular', 'cup_final', 'play_in', 'playoffs')),
  cup_stage              TEXT CHECK (cup_stage IN ('group', 'quarterfinal', 'semifinal', 'final')),
  playoff_series_id      INTEGER REFERENCES playoff_series (id),
  series_game_number     SMALLINT CHECK (series_game_number BETWEEN 1 AND 7),
  -- Local calendar date of tip-off at the venue. Back-to-back / rest tags are
  -- computed from this, never from the UTC date (a 7:30pm ET tip is the next
  -- day in UTC).
  game_date_local        DATE NOT NULL,
  tipoff_utc             TIMESTAMPTZ,
  home_team_id           INTEGER NOT NULL REFERENCES teams (id),  -- as listed by the league
  away_team_id           INTEGER NOT NULL REFERENCES teams (id),
  arena_id               INTEGER REFERENCES arenas (id),
  is_neutral_site        BOOLEAN NOT NULL DEFAULT FALSE,
  national_tv_tier       TEXT NOT NULL DEFAULT 'local'
                         CHECK (national_tv_tier IN ('major', 'nba_tv', 'local')),
  national_broadcasters  TEXT[] NOT NULL DEFAULT '{}',            -- raw, e.g. {ESPN,ABC}
  status                 TEXT NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'live', 'final', 'postponed', 'cancelled')),
  home_score             SMALLINT,
  away_score             SMALLINT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id),
  -- cup_final <-> cup_stage 'final', both directions
  CHECK (season_type <> 'cup_final' OR cup_stage = 'final'),
  CHECK (cup_stage IS DISTINCT FROM 'final' OR season_type = 'cup_final'),
  -- only regular-season games (and the final) carry a cup_stage
  CHECK (cup_stage IS NULL OR season_type IN ('regular', 'cup_final')),
  -- only play-in / playoff games belong to a series
  CHECK (playoff_series_id IS NULL OR season_type IN ('play_in', 'playoffs')),
  CHECK (series_game_number IS NULL OR playoff_series_id IS NOT NULL),
  CHECK (status <> 'final' OR (home_score IS NOT NULL AND away_score IS NOT NULL))
);
CREATE INDEX games_season_idx ON games (season, season_type);
CREATE INDEX games_date_idx   ON games (game_date_local);
CREATE INDEX games_home_idx   ON games (home_team_id, game_date_local);
CREATE INDEX games_away_idx   ON games (away_team_id, game_date_local);
CREATE INDEX games_series_idx ON games (playoff_series_id) WHERE playoff_series_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-team-per-game rows: where team-level split tags live
-- ---------------------------------------------------------------------------

CREATE TABLE team_games (
  game_id           UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  team_id           INTEGER NOT NULL REFERENCES teams (id),
  opponent_team_id  INTEGER NOT NULL REFERENCES teams (id),
  -- 'neutral' for both teams when games.is_neutral_site; neutral games are
  -- excluded from the Home and Away filters but included in "All" (§6.1).
  venue_split       TEXT NOT NULL CHECK (venue_split IN ('home', 'away', 'neutral')),
  -- Days off since this team's previous game (local dates): 0 = back-to-back.
  -- NULL for the team's first game of the season. Filter buckets 0/1/2/3+.
  rest_days         SMALLINT CHECK (rest_days >= 0),
  -- 1 = first night of a back-to-back, 2 = second night, NULL = neither.
  -- If a game is somehow both, 2 wins (fatigue is the effect being studied).
  b2b_night         SMALLINT CHECK (b2b_night IN (1, 2)),
  won               BOOLEAN,
  -- team box-score totals (same vocabulary as player_game_stats)
  minutes  SMALLINT, pts SMALLINT,
  fgm SMALLINT, fga SMALLINT, fg3m SMALLINT, fg3a SMALLINT, ftm SMALLINT, fta SMALLINT,
  oreb SMALLINT, dreb SMALLINT, reb SMALLINT, ast SMALLINT, stl SMALLINT, blk SMALLINT,
  tov SMALLINT, pf SMALLINT, plus_minus SMALLINT,
  PRIMARY KEY (game_id, team_id),
  CHECK (team_id <> opponent_team_id),
  CHECK ((b2b_night = 2) <= (rest_days = 0)),       -- night 2 implies 0 rest days
  CHECK (fgm <= fga AND fg3m <= fg3a AND ftm <= fta AND fg3m <= fgm),
  CHECK (reb IS NULL OR oreb IS NULL OR dreb IS NULL OR reb = oreb + dreb)
);
CREATE INDEX team_games_team_idx ON team_games (team_id);
CREATE INDEX team_games_splits_idx ON team_games (team_id, venue_split, b2b_night, rest_days);

-- ---------------------------------------------------------------------------
-- Player box scores: one wide, positionless table (§4)
-- ---------------------------------------------------------------------------

CREATE TABLE player_game_stats (
  game_id     UUID NOT NULL,
  player_id   UUID NOT NULL REFERENCES players (id),
  team_id     INTEGER NOT NULL,                     -- team he played FOR in this game (trades!)
  started     BOOLEAN,
  dnp         BOOLEAN NOT NULL DEFAULT FALSE,       -- on the roster/box, did not play
  dnp_reason  TEXT,
  minutes     NUMERIC(5,2),
  pts SMALLINT, fgm SMALLINT, fga SMALLINT, fg3m SMALLINT, fg3a SMALLINT,
  ftm SMALLINT, fta SMALLINT, oreb SMALLINT, dreb SMALLINT, reb SMALLINT,
  ast SMALLINT, stl SMALLINT, blk SMALLINT, tov SMALLINT, pf SMALLINT,
  plus_minus  SMALLINT,                             -- NULL before 1996-97
  source      TEXT NOT NULL CHECK (source IN ('nba_stats', 'highlightly')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, player_id),
  FOREIGN KEY (game_id, team_id) REFERENCES team_games (game_id, team_id) ON DELETE CASCADE,
  CHECK (NOT dnp OR (minutes IS NULL OR minutes = 0)),
  CHECK (fgm <= fga AND fg3m <= fg3a AND ftm <= fta AND fg3m <= fgm),
  CHECK (reb IS NULL OR oreb IS NULL OR dreb IS NULL OR reb = oreb + dreb),
  CHECK (pts IS NULL OR fgm IS NULL OR fg3m IS NULL OR ftm IS NULL OR pts = 2 * fgm + fg3m + ftm)
);
CREATE INDEX pgs_player_idx ON player_game_stats (player_id);
CREATE INDEX pgs_team_game_idx ON player_game_stats (team_id, game_id);

-- ---------------------------------------------------------------------------
-- Injuries (append-only time series — never updated in place)
-- ---------------------------------------------------------------------------

CREATE TABLE injury_reports (
  id           BIGSERIAL PRIMARY KEY,
  player_id    UUID NOT NULL REFERENCES players (id),
  team_id      INTEGER REFERENCES teams (id),
  game_id      UUID REFERENCES games (id),         -- the game the report is for, if any
  status       TEXT NOT NULL
               CHECK (status IN ('out', 'doubtful', 'questionable', 'probable', 'day_to_day', 'available')),
  description  TEXT,                               -- e.g. 'Left ankle sprain'
  reported_at  TIMESTAMPTZ NOT NULL,
  source       TEXT NOT NULL,                      -- source still undecided (architecture.md §3.2)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX injury_reports_player_latest_idx ON injury_reports (player_id, reported_at DESC);

-- ---------------------------------------------------------------------------
-- Freshness / audit
-- ---------------------------------------------------------------------------

-- Unlike NFL's one-time backfill, the NBA backfill scripts also log here, so
-- meta.freshness.synced_at is never NULL for backfilled data.
CREATE TABLE ingestion_runs (
  id               BIGSERIAL PRIMARY KEY,
  job_type         TEXT NOT NULL,                  -- e.g. 'backfill_season', 'sync_box_scores'
  source           TEXT NOT NULL CHECK (source IN ('nba_stats', 'highlightly', 'odds_api', 'manual')),
  triggered_by     TEXT NOT NULL CHECK (triggered_by IN ('schedule', 'manual', 'backfill')),
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  records_written  INTEGER CHECK (records_written >= 0),
  details          JSONB,                          -- e.g. {"season":"2025-26","season_type":"regular"}
  error            TEXT
);
CREATE INDEX ingestion_runs_latest_idx ON ingestion_runs (job_type, finished_at DESC) WHERE status = 'success';

-- ---------------------------------------------------------------------------
-- Migrations applied (scripts/db-migrate.mjs). A fresh install from this file
-- already contains every migration below, so they're recorded as applied.
-- ---------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (id) VALUES ('001_playoff_series_best_of_2');

-- ---------------------------------------------------------------------------
-- Auth: two-tier (PLATFORM.md §2)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  email          TEXT,                             -- optional, unverified in v1
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rotating refresh tokens. Presenting a token whose revoked_at/replaced_by is
-- already set = replay -> revoke EVERY active token for that user.
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID REFERENCES refresh_tokens (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Long-lived agent/service credentials. No session, no expiry.
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                     -- e.g. 'ai-agents-nba'
  key_prefix    TEXT NOT NULL,                     -- first chars, for identification in logs
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

COMMIT;
