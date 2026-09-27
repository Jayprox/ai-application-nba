// Read-only summary of what's in the database: row counts, per-season
// backfill status, and the latest seed/backfill runs.   npm run db:status
import pg from 'pg';
import { publicDbUrl } from './lib/env.mjs';

const { url, host, ssl } = publicDbUrl();
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[status] cannot reach ${host}: ${e.message}`); process.exit(1); }
const q = async (sql, p) => (await db.query(sql, p)).rows;
const [c] = await q(`SELECT (SELECT count(*) FROM teams)::int teams, (SELECT count(*) FROM arenas)::int arenas,
  (SELECT count(*) FROM players)::int players, (SELECT count(*) FROM players WHERE is_active)::int active,
  (SELECT count(*) FROM games)::int games, (SELECT count(*) FROM player_game_stats)::int player_rows,
  (SELECT count(*) FROM playoff_series)::int series, (SELECT string_agg(id, ', ' ORDER BY id) FROM schema_migrations) migrations`);
console.log(`[status] ${host}\n  ${JSON.stringify(c)}`);
const seasons = await q(`SELECT season, count(*)::int games, count(*) FILTER (WHERE season_type = 'regular')::int regular,
  count(*) FILTER (WHERE is_neutral_site)::int neutral FROM games GROUP BY 1 ORDER BY 1`);
console.log('  seasons loaded: ' + (seasons.map((s) => `${s.season}(${s.games})`).join(' ') || 'none'));
const runs = await q(`SELECT DISTINCT ON (job_type, details->>'season') job_type, details->>'season' season, status, finished_at,
  details->>'players_pruned' pruned, left(error, 120) error FROM ingestion_runs ORDER BY job_type, details->>'season', id DESC`);
const bad = runs.filter((r) => r.status !== 'success');
console.log(`  latest runs: ${runs.length} (${bad.length} not successful)`);
for (const r of bad) console.log(`    ✗ ${r.job_type} ${r.season ?? ''} ${r.status}: ${r.error ?? ''}`);
const seedRuns = await q(`SELECT id, status, details->>'players_pruned' pruned, details->>'players_updated' updated, finished_at FROM ingestion_runs WHERE job_type = 'seed_reference' ORDER BY id`);
console.log('  seed runs: ' + seedRuns.map((r) => `#${r.id} ${r.status} (updated ${r.updated ?? '-'}, pruned ${r.pruned ?? '-'})`).join(' | '));
await db.end();
