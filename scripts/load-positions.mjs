// npm run db:positions
// Listed positions (G / F / C / hybrids) for players who don't have one —
// mostly retired players, whom the seed never sees on a current roster.
// Rankings and matchups group by position, so without this every season
// before ~2020 was mostly "unlisted". One NBA.com request (player index,
// Historical=1). Only fills blanks; the roster listing wins. Safe to re-run
// (weekly.sh does, for newly signed players).
import pg from 'pg';
import { publicDbUrl } from './lib/env.mjs';
import { nbaPlayerIndex, rows, enableBestEffort } from './lib/sources.mjs';
import { SKIPPED, skipMessage, classifyError, weeklyLine } from './lib/nba-best-effort.mjs';
import { positionsFromIndex, positionUpdates } from './lib/positions.mjs';

const log = (...a) => console.log('[positions]', ...a);
// --nba-best-effort (only weekly.mjs passes it): an unreachable NBA.com skips this step with a warning, exit 0.
const BE = process.argv.includes('--nba-best-effort');
if (BE) process.stdout._handle?.setBlocking?.(true);
const beState = BE ? enableBestEffort(process.env) : 'ok';
const { url, host, ssl } = publicDbUrl();
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[positions] cannot reach ${host}: ${e.message}`); process.exit(1); }
log(`connected: ${host}`);
// Who still has no listed position, weighted by what matters: games played since 2003-04.
const unlisted = async () => (await db.query(
  `SELECT count(DISTINCT p.id)::int AS players, count(*)::int AS rows,
          round(100.0 * count(*) / nullif((SELECT count(*) FROM player_game_stats WHERE NOT dnp), 0), 2)::text AS pct
     FROM player_game_stats s JOIN players p ON p.id = s.player_id WHERE NOT s.dnp AND coalesce(p.listed_position, '') = ''`)).rows[0];
const skipExit = async (state, reason) => {
  const left = await unlisted().catch(() => null);
  log(`positions: NBA.com unreachable, skipped${left ? ` (${left.players} players still unlisted)` : ''}${reason ? ` — ${reason}` : ''}`);
  console.log(weeklyLine({ step: 'positions:nba', degraded: true, nba: state, skipped: SKIPPED['positions:nba'], reason: reason ?? skipMessage(state) }));
};
if (BE && beState !== 'ok') { await skipExit(beState); await db.end(); process.exit(0); }
try {
  const idx = positionsFromIndex(rows(await nbaPlayerIndex('2025-26')));
  log(`NBA.com player index: ${idx.size} players with a listed position`);
  const { rows: players } = await db.query(
    `SELECT p.id, x.source_id AS nba_id, p.listed_position FROM players p
       JOIN entity_id_crosswalk x ON x.entity_type = 'player' AND x.source = 'nba_stats' AND x.canonical_id = p.id::text`);
  const updates = positionUpdates(players, idx);
  await db.query('BEGIN');
  for (let i = 0; i < updates.length; i += 1000) {
    const chunk = updates.slice(i, i + 1000);
    await db.query(`UPDATE players p SET listed_position = u.pos, updated_at = now() FROM unnest($1::uuid[], $2::text[]) AS u(id, pos) WHERE p.id = u.id`,
      [chunk.map((u) => u.id), chunk.map((u) => u.pos)]);
  }
  await db.query('COMMIT');
  const left = await unlisted();
  log(`filled ${updates.length} player(s) · still unlisted: ${left.players} player(s), ${left.rows} box-score rows (${left.pct ?? 0}% of all)`);
  if (BE) console.log(weeklyLine({ step: 'positions:nba', nba: 'ok' }));
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  const c = BE ? classifyError(e) : null;
  if (c?.kind === 'warn') { await skipExit(c.nba, c.reason); }
  else {
    console.error('[positions] FAILED:', e.message);
    if (c) console.log(weeklyLine({ step: 'positions:nba', nba: c.nba, reason: c.reason }));
    process.exitCode = 1;
  }
} finally { await db.end(); }
