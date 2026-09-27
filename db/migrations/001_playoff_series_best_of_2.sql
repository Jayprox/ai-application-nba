-- 001: allow best-of-2 series (2019-20 bubble play-in: 8th seed needed 1 win,
-- 9th needed 2). Found while designing the 2003-04+ backfill.
-- The original CHECKs were unnamed, so find them by definition and drop them.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'playoff_series'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ~ 'best_of'
  LOOP
    EXECUTE format('ALTER TABLE playoff_series DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE playoff_series
  ADD CONSTRAINT playoff_series_best_of_check   CHECK (best_of IN (1, 2, 7)),
  ADD CONSTRAINT playoff_series_playin_length   CHECK (round <> 'play_in' OR best_of IN (1, 2)),
  ADD CONSTRAINT playoff_series_playoff_length  CHECK (round = 'play_in' OR best_of = 7);
