-- Small sample data for the backup restore drill (scripts/backup-drill.sh).
-- Loaded into a throwaway local postgres:18 container after db/schema.sql.
-- Satisfies every CHECK in db/schema.sql. Fake credentials only.
BEGIN;

INSERT INTO arenas (name, city, state, elevation_ft, is_high_altitude)
VALUES ('American Airlines Center', 'Dallas', 'TX', 430, FALSE),
       ('Crypto.com Arena', 'Los Angeles', 'CA', 270, FALSE);

INSERT INTO teams (abbreviation, city, name, full_name, conference, division, home_arena_id)
VALUES ('DAL', 'Dallas', 'Mavericks', 'Dallas Mavericks', 'West', 'Southwest', (SELECT id FROM arenas WHERE city = 'Dallas')),
       ('LAL', 'Los Angeles', 'Lakers', 'Los Angeles Lakers', 'West', 'Pacific', (SELECT id FROM arenas WHERE city = 'Los Angeles'));

INSERT INTO players (id, full_name, first_name, last_name, birth_date, listed_position, height_in, weight_lb, current_team_id)
VALUES ('00000000-0000-4000-8000-000000000001', 'Luka Dončić', 'Luka', 'Dončić', '1999-02-28', 'G', 79, 230, (SELECT id FROM teams WHERE abbreviation = 'LAL')),
       ('00000000-0000-4000-8000-000000000002', 'Test Center', 'Test', 'Center', '2000-01-01', 'C', 84, 250, (SELECT id FROM teams WHERE abbreviation = 'DAL'));

INSERT INTO games (id, season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id, arena_id, status, home_score, away_score)
VALUES ('00000000-0000-4000-8000-0000000000a1', '2026-27', 'regular', '2026-10-25', '2026-10-26 01:30:00+00',
        (SELECT id FROM teams WHERE abbreviation = 'DAL'), (SELECT id FROM teams WHERE abbreviation = 'LAL'),
        (SELECT id FROM arenas WHERE city = 'Dallas'), 'final', 110, 112);

INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split, won, pts)
VALUES ('00000000-0000-4000-8000-0000000000a1', (SELECT id FROM teams WHERE abbreviation = 'DAL'), (SELECT id FROM teams WHERE abbreviation = 'LAL'), 'home', FALSE, 110),
       ('00000000-0000-4000-8000-0000000000a1', (SELECT id FROM teams WHERE abbreviation = 'LAL'), (SELECT id FROM teams WHERE abbreviation = 'DAL'), 'away', TRUE, 112);

INSERT INTO player_game_stats (game_id, player_id, team_id, started, minutes, pts, fgm, fga, fg3m, fg3a, ftm, fta, source)
VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', (SELECT id FROM teams WHERE abbreviation = 'LAL'), TRUE, 36.5, 30, 10, 20, 3, 8, 7, 8, 'nba_stats');

INSERT INTO users (id, username, password_hash, email)
VALUES ('00000000-0000-4000-8000-0000000000b1', 'drill_user', 'not-a-real-hash', 'drill@example.invalid');

INSERT INTO api_keys (name, key_prefix, key_hash)
VALUES ('drill-key', 'drill', 'not-a-real-key-hash');

COMMIT;
