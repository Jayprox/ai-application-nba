-- 003: player-level rest / back-to-back (decided 2026-09-27: "offer both").
-- team_games.rest_days/b2b_night = the TEAM's schedule; these = the player's
-- OWN previous/next game, which is how NBA.com's player "Days Rest" splits
-- work (they differ whenever a player sat out an adjacent game).
ALTER TABLE player_game_stats
  ADD COLUMN IF NOT EXISTS player_rest_days SMALLINT CHECK (player_rest_days >= 0),
  ADD COLUMN IF NOT EXISTS player_b2b_night SMALLINT CHECK (player_b2b_night IN (1, 2));
ALTER TABLE player_game_stats
  ADD CONSTRAINT player_game_stats_player_b2b_rest CHECK ((player_b2b_night = 2) <= (player_rest_days = 0));
