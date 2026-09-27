-- Constraint tests for db/schema.sql. Runs inside one transaction and rolls
-- back, so it's safe against any database that has the schema applied.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/schema_constraints.sql
-- Happy path uses a real game: MEM @ HOU, 2026-04-12 (box score verified
-- identical in NBA.com and Highlightly, architecture.md §3.1).

\set QUIET on
\o /dev/null
-- (results suppressed; PASS/FAIL lines arrive as NOTICEs on stderr)

BEGIN;

-- Assert that a statement is rejected by a constraint.
CREATE FUNCTION pg_temp.expect_fail(label TEXT, stmt TEXT) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN check_violation OR foreign_key_violation OR unique_violation OR not_null_violation THEN
    RAISE NOTICE 'PASS  rejected: %', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  accepted but should be rejected: %', label;
END $$ LANGUAGE plpgsql;

-- ---- happy path ------------------------------------------------------------
INSERT INTO arenas (id, name, city, state, country, elevation_ft, is_high_altitude) VALUES
  (901, 'Toyota Center', 'Houston', 'TX', 'USA', 43, FALSE),
  (902, 'FedExForum', 'Memphis', 'TN', 'USA', 337, FALSE),
  (903, 'Ball Arena', 'Denver', 'CO', 'USA', 5280, TRUE),
  (904, 'Delta Center', 'Salt Lake City', 'UT', 'USA', 4226, TRUE);

INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division, home_arena_id) VALUES
  (901, 'HOU', 'Houston', 'Rockets', 'Houston Rockets', 'West', 'Southwest', 901),
  (902, 'MEM', 'Memphis', 'Grizzlies', 'Memphis Grizzlies', 'West', 'Southwest', 902),
  (903, 'DEN', 'Denver', 'Nuggets', 'Denver Nuggets', 'West', 'Northwest', 903),
  (904, 'UTA', 'Utah', 'Jazz', 'Utah Jazz', 'West', 'Northwest', 904);

INSERT INTO players (id, full_name, listed_position, current_team_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Jae''Sean Tate', 'F', 901),
  ('00000000-0000-0000-0000-000000000002', 'Amen Thompson', 'G-F', 901);

-- Crosswalk: same team known to two vendors under different abbreviations/ids
INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method) VALUES
  ('team', '904', 'nba_stats', '1610612762', 'exact_id'),
  ('team', '904', 'highlightly', 'UTAH', 'abbreviation_alias'),
  ('player', '00000000-0000-0000-0000-000000000001', 'highlightly', '47052722', 'name+team+date');

INSERT INTO games (id, season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id,
                   arena_id, status, home_score, away_score)
VALUES ('10000000-0000-0000-0000-000000000001', '2025-26', 'regular', '2026-04-12',
        '2026-04-13T00:30:00Z', 901, 902, 901, 'final', 132, 101);

INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split, rest_days, b2b_night, won) VALUES
  ('10000000-0000-0000-0000-000000000001', 901, 902, 'home', 1, NULL, TRUE),
  ('10000000-0000-0000-0000-000000000001', 902, 901, 'away', 0, 2, FALSE);

-- Jae'Sean Tate's real line: 26 min, 13 pts, 6-9 FG, 1-2 3P, 0-1 FT, 2+4=6 reb
INSERT INTO player_game_stats (game_id, player_id, team_id, started, minutes, pts, fgm, fga, fg3m, fg3a,
                               ftm, fta, oreb, dreb, reb, ast, stl, blk, tov, pf, plus_minus, source)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 901, TRUE,
        26, 13, 6, 9, 1, 2, 0, 1, 2, 4, 6, 2, 1, 0, 3, 1, 11, 'highlightly');
-- DNP row (Highlightly lists these with null stats)
INSERT INTO player_game_stats (game_id, player_id, team_id, dnp, source)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 901, TRUE, 'highlightly');

-- Season structure: play-in "series" + a playoff game + the Cup final
INSERT INTO playoff_series (id, season, round, conference, bracket_slot, best_of, higher_seed, lower_seed,
                            higher_seed_team_id, lower_seed_team_id, winner_team_id)
VALUES (901, '2025-26', 'play_in', 'West', 'W-7v8', 1, 7, 8, 901, 902, 901),
       (902, '2025-26', 'first_round', 'West', 'W-R1-2v7', 7, 2, 7, 903, 901, NULL);
INSERT INTO games (season, season_type, playoff_series_id, game_date_local, home_team_id, away_team_id)
VALUES ('2025-26', 'play_in', 901, '2026-04-15', 901, 902),
       ('2025-26', 'playoffs', 902, '2026-04-19', 903, 901);
INSERT INTO games (season, season_type, cup_stage, game_date_local, home_team_id, away_team_id, is_neutral_site,
                   national_tv_tier, national_broadcasters)
VALUES ('2025-26', 'cup_final', 'final', '2025-12-16', 903, 904, TRUE, 'major', '{Amazon}'),
       ('2025-26', 'regular', 'group', '2025-11-14', 903, 904, FALSE, 'nba_tv', '{"NBA TV"}');

INSERT INTO injury_reports (player_id, team_id, status, description, reported_at, source)
VALUES ('00000000-0000-0000-0000-000000000002', 901, 'out', 'Left ankle sprain', now(), 'test');

-- 2019-20 bubble play-in: best-of-2, 8th (POR) vs 9th (MEM)
INSERT INTO teams (id, abbreviation, city, name, full_name, conference, division) VALUES
  (905, 'POR', 'Portland', 'Trail Blazers', 'Portland Trail Blazers', 'West', 'Northwest');
INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of, higher_seed, lower_seed, higher_seed_team_id, lower_seed_team_id, winner_team_id)
VALUES ('2019-20', 'play_in', 'West', 'W-8v9', 2, 8, 9, 905, 902, 905);

DO $$ BEGIN RAISE NOTICE 'PASS  happy path: real game, DNP row, crosswalk, play-in, best-of-2 bubble play-in, playoffs, cup final, injury'; END $$;

-- Split query shape sanity: 2nd night of a back-to-back, away, altitude join works
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
  FROM player_game_stats p
  JOIN team_games tg ON tg.game_id = p.game_id AND tg.team_id = p.team_id
  JOIN games g ON g.id = p.game_id
  JOIN arenas a ON a.id = g.arena_id
  WHERE tg.venue_split = 'home' AND tg.b2b_night IS NULL AND NOT a.is_high_altitude
    AND g.season = '2025-26' AND g.season_type = 'regular' AND NOT p.dnp;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL  split query returned % rows, expected 1', n; END IF;
  RAISE NOTICE 'PASS  split filter query shape (plain WHERE clauses)';
END $$;

-- ---- negative tests --------------------------------------------------------
SELECT pg_temp.expect_fail('duplicate vendor id in crosswalk',
  $q$INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('team','901','highlightly','UTAH')$q$);
SELECT pg_temp.expect_fail('unknown crosswalk source',
  $q$INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id) VALUES ('team','901','espn','x')$q$);
SELECT pg_temp.expect_fail('season label wrong format (Highlightly end-year style)',
  $q$INSERT INTO games (season, season_type, game_date_local, home_team_id, away_team_id) VALUES ('2026','regular','2026-01-01',901,902)$q$);
SELECT pg_temp.expect_fail('team plays itself',
  $q$INSERT INTO games (season, season_type, game_date_local, home_team_id, away_team_id) VALUES ('2025-26','regular','2026-01-01',901,901)$q$);
SELECT pg_temp.expect_fail('cup_final without cup_stage final',
  $q$INSERT INTO games (season, season_type, cup_stage, game_date_local, home_team_id, away_team_id) VALUES ('2025-26','cup_final','semifinal','2026-01-01',901,902)$q$);
SELECT pg_temp.expect_fail('cup_stage final on a regular game',
  $q$INSERT INTO games (season, season_type, cup_stage, game_date_local, home_team_id, away_team_id) VALUES ('2025-26','regular','final','2026-01-01',901,902)$q$);
SELECT pg_temp.expect_fail('cup_stage on a playoff game',
  $q$INSERT INTO games (season, season_type, cup_stage, game_date_local, home_team_id, away_team_id) VALUES ('2025-26','playoffs','group','2026-05-01',901,902)$q$);
SELECT pg_temp.expect_fail('regular-season game attached to a series',
  $q$INSERT INTO games (season, season_type, playoff_series_id, game_date_local, home_team_id, away_team_id) VALUES ('2025-26','regular',902,'2026-01-01',901,902)$q$);
SELECT pg_temp.expect_fail('final game without scores',
  $q$INSERT INTO games (season, season_type, game_date_local, home_team_id, away_team_id, status) VALUES ('2025-26','regular','2026-01-01',901,902,'final')$q$);
SELECT pg_temp.expect_fail('unknown national_tv_tier',
  $q$INSERT INTO games (season, season_type, game_date_local, home_team_id, away_team_id, national_tv_tier) VALUES ('2025-26','regular','2026-01-01',901,902,'regional')$q$);
SELECT pg_temp.expect_fail('play-in series with best_of 7',
  $q$INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of) VALUES ('2025-26','play_in','East','E-9v10',7)$q$);
SELECT pg_temp.expect_fail('playoff series that is not best-of-7',
  $q$INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of) VALUES ('2025-26','first_round','East','E-R1-4v5',2)$q$);
SELECT pg_temp.expect_fail('series of an impossible length',
  $q$INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of) VALUES ('2025-26','play_in','East','E-7v8x',3)$q$);
SELECT pg_temp.expect_fail('finals series with a conference',
  $q$INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of) VALUES ('2025-26','finals','East','FINALS',7)$q$);
SELECT pg_temp.expect_fail('series winner not in the series',
  $q$INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of, higher_seed_team_id, lower_seed_team_id, winner_team_id) VALUES ('2025-26','first_round','West','W-R1-1v8',7,903,904,901)$q$);
SELECT pg_temp.expect_fail('b2b night 2 with rest days > 0',
  $q$UPDATE team_games SET b2b_night = 2, rest_days = 1 WHERE team_id = 901$q$);
SELECT pg_temp.expect_fail('invalid venue_split',
  $q$UPDATE team_games SET venue_split = 'road' WHERE team_id = 901$q$);
SELECT pg_temp.expect_fail('player stats for a team not in that game',
  $q$INSERT INTO player_game_stats (game_id, player_id, team_id, source) VALUES ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',903,'highlightly')$q$);
SELECT pg_temp.expect_fail('duplicate player row for a game',
  $q$INSERT INTO player_game_stats (game_id, player_id, team_id, source) VALUES ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',901,'nba_stats')$q$);
SELECT pg_temp.expect_fail('fgm > fga',
  $q$UPDATE player_game_stats SET fgm = 10 WHERE player_id = '00000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('reb <> oreb + dreb',
  $q$UPDATE player_game_stats SET reb = 7 WHERE player_id = '00000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('pts inconsistent with makes',
  $q$UPDATE player_game_stats SET pts = 14 WHERE player_id = '00000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('DNP with minutes',
  $q$UPDATE player_game_stats SET minutes = 5 WHERE player_id = '00000000-0000-0000-0000-000000000002'$q$);
SELECT pg_temp.expect_fail('unknown injury status',
  $q$INSERT INTO injury_reports (player_id, status, reported_at, source) VALUES ('00000000-0000-0000-0000-000000000002','gtd',now(),'test')$q$);
SELECT pg_temp.expect_fail('negative records_written',
  $q$INSERT INTO ingestion_runs (job_type, source, triggered_by, records_written) VALUES ('x','manual','manual',-1)$q$);

DO $$ BEGIN RAISE NOTICE 'ALL SCHEMA CONSTRAINT TESTS PASSED'; END $$;

ROLLBACK;
