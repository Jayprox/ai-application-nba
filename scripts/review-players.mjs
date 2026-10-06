// Players the ingestion worker HELD for review (a Highlightly name that looks
// like someone already in the database, e.g. an inactive player re-signing).
// The worker never guesses; a person links the row once and every later game
// for that player loads normally.
//
//   npm run db:review                              # list held players + candidates
//   npm run db:review -- --link <source_id> <player_id>
//
// --link marks the crosswalk row matched (method 'manual') and the player
// active (he just played). His held box-score lines come back with the next
// NBA.com reconcile (npm run db:weekly) or the worker's next game.
import pg from 'pg';
import { publicDbUrl } from './lib/env.mjs';
import { nameKey, initialKey } from './lib/names.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { url, host, ssl } = publicDbUrl();
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[review] cannot reach ${host}: ${e.message}`); process.exit(1); }
const q = async (sql, p) => (await db.query(sql, p)).rows;
const args = process.argv.slice(2);

try {
  if (args[0] === '--link') {
    const [sourceId, playerId] = args.slice(1);
    if (!sourceId || !UUID.test(playerId ?? '')) throw new Error('usage: npm run db:review -- --link <source_id> <player_id>');
    const [p] = await q('SELECT id, full_name FROM players WHERE id = $1', [playerId]);
    if (!p) throw new Error(`no player ${playerId}`);
    await db.query('BEGIN');
    const r = await db.query(
      `UPDATE entity_id_crosswalk SET canonical_id = $2, match_status = 'matched', match_method = 'manual', updated_at = now()
        WHERE entity_type = 'player' AND source = 'highlightly' AND source_id = $1 AND match_status = 'manual_review'`, [sourceId, playerId]);
    if (r.rowCount !== 1) throw new Error(`no held row for highlightly id ${sourceId} (already linked?)`);
    await db.query('UPDATE players SET is_active = true, updated_at = now() WHERE id = $1', [playerId]);
    await db.query('COMMIT');
    console.log(`[review] linked highlightly ${sourceId} -> ${p.full_name} (${p.id}); marked active`);
  } else {
    const held = await q(`SELECT source_id, match_method AS note, created_at FROM entity_id_crosswalk
                           WHERE entity_type = 'player' AND source = 'highlightly' AND match_status = 'manual_review' ORDER BY id`);
    if (!held.length) console.log('[review] nobody held for review');
    const everyone = held.length ? await q(
      `SELECT p.id, p.full_name, p.is_active, t.abbreviation AS team, p.first_season_start,
              (SELECT max(g.game_date_local)::text FROM player_game_stats s JOIN games g ON g.id = s.game_id WHERE s.player_id = p.id) AS last_game
         FROM players p LEFT JOIN teams t ON t.id = p.current_team_id`) : [];
    for (const h of held) {
      const name = String(h.note ?? '').replace(/^[^:]*:\s*/, '').split(' ~ ')[0];
      const near = everyone.filter((p) => nameKey(p.full_name) === nameKey(name) || initialKey(p.full_name) === initialKey(name));
      console.log(`\n${name}  (highlightly id ${h.source_id}, held since ${h.created_at.toISOString().slice(0, 10)})`);
      for (const p of near) console.log(`  ${p.id}  ${p.full_name} · ${p.is_active ? 'active' : 'inactive'} · ${p.team ?? 'no team'} · since ${p.first_season_start ?? '?'} · last game ${p.last_game ?? 'none'}`);
      if (!near.length) console.log('  (no similar player in the database)');
      console.log(`  link with: npm run db:review -- --link ${h.source_id} <player_id>`);
    }
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(`[review] ${e.message}`);
  process.exitCode = 1;
} finally { await db.end(); }
