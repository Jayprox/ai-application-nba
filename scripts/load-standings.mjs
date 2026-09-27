// npm run db:standings [-- --season 2025-26]
// NBA.com's official standings (rank incl. tiebreakers) for every loaded
// season into team_seasons. One request per season, ~30 s for all of them.
// db:backfill also writes these; run this after migration 005, or weekly.
import pg from 'pg';
import { publicDbUrl } from './lib/env.mjs';
import { nbaStandings, rows } from './lib/sources.mjs';
import { writeStandings } from './lib/standings.mjs';

const log = (...a) => console.log('[standings]', ...a);
const args = process.argv.slice(2);
const picked = args.flatMap((a, i) => (a === '--season' ? [args[i + 1]] : []));
const { url, host, ssl } = publicDbUrl();
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[standings] cannot reach ${host}: ${e.message}`); process.exit(1); }
const teamByNba = new Map((await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type='team' AND source='nba_stats'`)).rows
  .map((r) => [r.source_id, Number(r.canonical_id)]));
const seasons = picked.length ? picked
  : (await db.query(`SELECT DISTINCT season FROM games WHERE status = 'final' AND season_type = 'regular' ORDER BY 1`)).rows.map((r) => r.season);
log(`connected: ${host} — ${seasons.length} season(s)`);
let failed = 0;
for (const season of seasons) {
  try {
    const st = rows(await nbaStandings(season));
    const n = await writeStandings(db, season, st, teamByNba);
    const top = st.filter((s) => Number(s.PlayoffRank) === 1).map((s) => `${s.Conference}: ${s.TeamName} ${s.WINS}-${s.LOSSES}`).join(' · ');
    log(`${season} ✓ ${n} teams · 1st seeds ${top}`);
  } catch (e) { failed++; log(`${season} ✗ ${e.message}`); }
}
await db.end();
if (failed) { log(`done with ${failed} failure(s) — re-run with --season`); process.exitCode = 1; } else log('done.');
