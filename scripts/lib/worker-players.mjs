// Players the ingestion worker created from Highlightly (mid-season signings
// NBA.com hadn't listed yet). When NBA.com later lists them, seed/backfill
// must LINK to that player instead of creating a duplicate.
import { matchPlayer, nameKey } from './names.mjs';

/** Worker-created players with no NBA.com id yet: [{id, name, teamId}] */
export async function workerCreatedPlayers(db) {
  const { rows } = await db.query(
    `SELECT p.id, p.full_name AS name, p.current_team_id AS "teamId" FROM players p
      WHERE EXISTS (SELECT 1 FROM entity_id_crosswalk x WHERE x.entity_type = 'player' AND x.source = 'highlightly'
                     AND x.match_method = 'created_by_worker' AND x.canonical_id = p.id::text)
        AND NOT EXISTS (SELECT 1 FROM entity_id_crosswalk x WHERE x.entity_type = 'player' AND x.source = 'nba_stats' AND x.canonical_id = p.id::text)`);
  return rows;
}

/**
 * @param incoming [{nbaId, name, teamId}] NBA.com players we don't know yet
 * @param pool     workerCreatedPlayers()
 * @returns Map nbaId -> canonical player id (only confident matches; each pool player used once)
 */
export function linkToWorkerCreated(incoming, pool) {
  const out = new Map();
  const used = new Set();
  for (const p of incoming) {
    const free = pool.filter((w) => !used.has(w.id));
    let r = matchPlayer(p.name, free.filter((w) => w.teamId === p.teamId).map((w) => ({ id: w.id, name: w.name })));
    if (r.status !== 'matched') {
      const hits = pool.filter((w) => nameKey(w.name) === nameKey(p.name));   // unique in the WHOLE pool
      r = hits.length === 1 && !used.has(hits[0].id) ? { status: 'matched', id: hits[0].id } : r;
    }
    if (r.status === 'matched') { out.set(String(p.nbaId), r.id); used.add(r.id); }
  }
  return out;
}
