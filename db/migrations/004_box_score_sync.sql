-- 004: ingestion-worker bookkeeping on games (decided 2026-09-27).
-- box_score_synced_at: when the worker last wrote this game's box score.
-- box_score_checks: 1 = loaded at final, 2 = re-checked ~3h later for stat
-- corrections; the worker stops touching the game after that.
ALTER TABLE games
  ADD COLUMN IF NOT EXISTS box_score_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS box_score_checks SMALLINT NOT NULL DEFAULT 0;
