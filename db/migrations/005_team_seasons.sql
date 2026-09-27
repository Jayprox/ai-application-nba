-- 005: NBA.com's official standings rank per team-season (decided 2026-09-27).
-- W-L, home/road, conference record, last 10 and streak are computed live from
-- games; the RANK comes from here because NBA tiebreakers (head-to-head,
-- division, conference record, ...) are NBA.com's call, not ours. Written by
-- db:backfill (which already fetches standings) and db:standings.
CREATE TABLE IF NOT EXISTS team_seasons (
  season            TEXT NOT NULL CHECK (season ~ '^[0-9]{4}-[0-9]{2}$'),
  team_id           INTEGER NOT NULL REFERENCES teams (id),
  conference        TEXT NOT NULL CHECK (conference IN ('East', 'West')),
  conference_rank   SMALLINT NOT NULL CHECK (conference_rank BETWEEN 1 AND 15),
  division_rank     SMALLINT,
  wins              SMALLINT NOT NULL CHECK (wins >= 0),
  losses            SMALLINT NOT NULL CHECK (losses >= 0),
  clinch            TEXT,                      -- NBA.com indicator: x, y, z, w, e, pi, o, ...
  source            TEXT NOT NULL DEFAULT 'nba_stats',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season, team_id)
);
