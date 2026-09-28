-- 006: player prop lines from The Odds API (decided 2026-09-27, JD):
-- DraftKings only, two snapshots per game — 'open' (first pull the morning of
-- the game) and 'close' (~30 min before tip). Graded at query time against
-- player_game_stats; nothing is predicted. No history before we start pulling.
CREATE TABLE IF NOT EXISTS prop_lines (
  game_id          UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id        UUID NOT NULL REFERENCES players (id),
  market           TEXT NOT NULL
                   CHECK (market IN ('pts', 'reb', 'ast', 'fg3m', 'pra', 'pr', 'pa', 'ra', 'stl', 'blk', 'stocks', 'tov')),
  snapshot         TEXT NOT NULL CHECK (snapshot IN ('open', 'close')),
  book             TEXT NOT NULL DEFAULT 'draftkings',
  line             NUMERIC(5,1) NOT NULL CHECK (line >= 0 AND line < 200),
  over_price       SMALLINT,                    -- American odds, e.g. -115
  under_price      SMALLINT,
  book_updated_at  TIMESTAMPTZ,                 -- the book's own last_update for this market
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  source           TEXT NOT NULL DEFAULT 'odds_api',
  PRIMARY KEY (game_id, player_id, market, book, snapshot)
);
CREATE INDEX IF NOT EXISTS prop_lines_player_idx ON prop_lines (player_id, market);

-- When each snapshot was taken for a game (the worker's "done" markers).
ALTER TABLE games ADD COLUMN IF NOT EXISTS props_open_at  TIMESTAMPTZ;
ALTER TABLE games ADD COLUMN IF NOT EXISTS props_close_at TIMESTAMPTZ;
