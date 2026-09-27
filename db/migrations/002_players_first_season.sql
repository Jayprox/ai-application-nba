-- 002: first NBA season per player (start year, e.g. 2003 = 2003-04), so the
-- API can say "stats begin 2003-04" only for careers that started earlier.
ALTER TABLE players ADD COLUMN IF NOT EXISTS first_season_start SMALLINT;
