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
const alt = await q(`SELECT a.name, a.city, a.elevation_ft, count(g.id)::int games FROM arenas a LEFT JOIN games g ON g.arena_id = a.id
  WHERE a.is_high_altitude GROUP BY 1, 2, 3 ORDER BY 3 DESC, 4 DESC`);
console.log('  altitude arenas: ' + alt.map((a) => `${a.name} (${a.city}, ${a.elevation_ft} ft, ${a.games} games)`).join(' | '));
const seedRuns = await q(`SELECT id, status, details->>'players_pruned' pruned, details->>'players_updated' updated, finished_at FROM ingestion_runs WHERE job_type = 'seed_reference' ORDER BY id`);
console.log('  seed runs: ' + seedRuns.map((r) => `#${r.id} ${r.status} (updated ${r.updated ?? '-'}, pruned ${r.pruned ?? '-'})`).join(' | '));
const st = await q(`SELECT season, count(*)::int n FROM team_seasons GROUP BY 1 ORDER BY 1`).catch(() => null);
console.log('  official standings (team_seasons): ' + (st === null ? 'table missing — npm run db:migrate' : st.length ? `${st.length} season(s), ${st[0].season} .. ${st.at(-1).season}` : 'none yet — npm run db:standings'));
// Ingestion worker (Highlightly): last run, quota, players waiting for a human.
const [w] = await q(`SELECT count(*)::int runs, max(finished_at) FILTER (WHERE status = 'success') last_ok,
  count(*) FILTER (WHERE status = 'failed' AND started_at > now() - interval '1 day')::int failed_24h,
  (SELECT details->'quota' FROM ingestion_runs WHERE job_type = 'sync_scores_box' AND details ? 'quota' ORDER BY id DESC LIMIT 1) quota
  FROM ingestion_runs WHERE job_type = 'sync_scores_box'`);
const review = await q(`SELECT source, source_id, match_method FROM entity_id_crosswalk WHERE entity_type = 'player' AND match_status = 'manual_review' ORDER BY id`);
const [created] = await q(`SELECT count(*)::int n FROM entity_id_crosswalk x WHERE x.entity_type = 'player' AND x.match_method = 'created_by_worker'
  AND NOT EXISTS (SELECT 1 FROM entity_id_crosswalk y WHERE y.entity_type = 'player' AND y.source = 'nba_stats' AND y.canonical_id = x.canonical_id)`);
console.log(`  worker: ${w.runs ? `${w.runs} runs, last success ${w.last_ok ? new Date(w.last_ok).toISOString() : 'never'}, ${w.failed_24h} failed in 24h` : 'no runs yet'}` +
  (w.quota?.remaining != null ? `, Highlightly quota ${w.quota.remaining}/${w.quota.limit}` : '') +
  ` · ${created.n} worker-created player(s) not on NBA.com yet · ${review.length} held for review`);
for (const r of review.slice(0, 10)) console.log(`    ? ${r.source} player ${r.source_id}: ${r.match_method}`);
// Player props (The Odds API, DraftKings): lines stored, last pull, credits left.
const [pp] = await q(`SELECT (SELECT count(*)::int FROM prop_lines) lines, (SELECT count(DISTINCT game_id)::int FROM prop_lines) games,
  (SELECT max(finished_at) FROM ingestion_runs WHERE job_type = 'sync_props' AND status = 'success') last_ok,
  (SELECT count(*)::int FROM ingestion_runs WHERE job_type = 'sync_props' AND status = 'failed' AND started_at > now() - interval '1 day') failed_24h,
  (SELECT details->'quota'->>'remaining' FROM ingestion_runs WHERE job_type = 'sync_props' AND details ? 'quota' ORDER BY id DESC LIMIT 1) credits`).catch(() => [null]);
console.log('  props: ' + (pp === null ? 'table missing — npm run db:migrate'
  : `${pp.lines} DraftKings lines for ${pp.games} game(s), last pull ${pp.last_ok ? new Date(pp.last_ok).toISOString() : 'never'}, ${pp.failed_24h} failed in 24h` +
    (pp.credits != null ? `, Odds API credits left ${pp.credits}` : '')));
await db.end();
