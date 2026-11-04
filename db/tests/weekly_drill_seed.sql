-- Seed for the weekly drill cases W26-W32 (scripts/weekly-drill.sh, M6). Loaded into the throwaway
-- postgres:18 container after db/schema.sql and db/tests/backup_drill_seed.sql. Fake data only.
-- psql variables (from scripts/fixtures/make-weekly-drill-fixtures.mjs): g1_tip g1_local fin_tip fin_local.
-- 30 teams with nba_stats crosswalk rows (the NBA.com loaders refuse fewer), Highlightly ids for the four
-- teams in the fixtures, a scheduled game LAL @ GSW (tip a day ahead) and a final MEM @ HOU (132-101) with no box score.
BEGIN;
INSERT INTO teams (abbreviation, city, name, full_name, conference, division)
SELECT a, c, n, c || ' ' || n, 'West', 'Southwest' FROM (VALUES
  ('ATL','Atlanta','Hawks'),('BOS','Boston','Celtics'),('BKN','Brooklyn','Nets'),('CHA','Charlotte','Hornets'),('CHI','Chicago','Bulls'),
  ('CLE','Cleveland','Cavaliers'),('DAL','Dallas','Mavericks'),('DEN','Denver','Nuggets'),('DET','Detroit','Pistons'),('GSW','Golden State','Warriors'),
  ('HOU','Houston','Rockets'),('IND','Indiana','Pacers'),('LAC','Los Angeles','Clippers'),('LAL','Los Angeles','Lakers'),('MEM','Memphis','Grizzlies'),
  ('MIA','Miami','Heat'),('MIL','Milwaukee','Bucks'),('MIN','Minnesota','Timberwolves'),('NOP','New Orleans','Pelicans'),('NYK','New York','Knicks'),
  ('OKC','Oklahoma City','Thunder'),('ORL','Orlando','Magic'),('PHI','Philadelphia','76ers'),('PHX','Phoenix','Suns'),('POR','Portland','Trail Blazers'),
  ('SAC','Sacramento','Kings'),('SAS','San Antonio','Spurs'),('TOR','Toronto','Raptors'),('UTA','Utah','Jazz'),('WAS','Washington','Wizards')
) AS t(a, c, n) ON CONFLICT (abbreviation) DO NOTHING;

INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
SELECT 'team', id::text, 'nba_stats', '16106127' || lpad(id::text, 3, '0'), 'exact_id' FROM teams ON CONFLICT DO NOTHING;
INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
SELECT 'team', t.id::text, 'highlightly', h.hl, 'drill' FROM (VALUES ('GSW','43'),('LAL','4'),('HOU','28'),('MEM','42')) AS h(ab, hl)
  JOIN teams t ON t.abbreviation = h.ab ON CONFLICT DO NOTHING;

INSERT INTO games (id, season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id, status)
SELECT '00000000-0000-4000-8000-0000000000c1', '2026-27', 'regular', :'g1_local'::date, :'g1_tip'::timestamptz, h.id, a.id, 'scheduled'
  FROM teams h, teams a WHERE h.abbreviation = 'GSW' AND a.abbreviation = 'LAL';
INSERT INTO games (id, season, season_type, game_date_local, tipoff_utc, home_team_id, away_team_id, status, home_score, away_score)
SELECT '00000000-0000-4000-8000-0000000000c2', '2026-27', 'regular', :'fin_local'::date, :'fin_tip'::timestamptz, h.id, a.id, 'final', 132, 101
  FROM teams h, teams a WHERE h.abbreviation = 'HOU' AND a.abbreviation = 'MEM';
INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split)
SELECT g.id, g.home_team_id, g.away_team_id, 'home' FROM games g WHERE g.id IN ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2')
UNION ALL
SELECT g.id, g.away_team_id, g.home_team_id, 'away' FROM games g WHERE g.id IN ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2');
COMMIT;
