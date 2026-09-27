// Highlightly player -> canonical player, per JD's rule (2026-09-27):
//   known id (crosswalk)            -> use it
//   name matches on THAT team       -> match (names.js: suffix-aware, never guesses)
//   unique name among active players (trades) -> match
//   any near-match / ambiguity      -> manual_review, stats held back
//   nobody remotely similar         -> clearly new: create him ("created_by_worker")
import { initialKey, matchPlayer, nameKey, suffixOf } from './names.js';

const XW = `INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_status, match_method)
            VALUES ('player', $1, 'highlightly', $2, $3, $4) ON CONFLICT (entity_type, source, source_id) DO NOTHING`;

/**
 * @param entries [{hlId, name}] for ONE team in ONE game
 * @returns Map hlId -> {status:'matched', playerId, method, created?} | {status:'held', reason}
 */
export async function resolvePlayers(db, { teamId, season, entries }) {
  const out = new Map();
  const ids = entries.map((e) => String(e.hlId));
  const { rows: known } = await db.query(
    `SELECT source_id, canonical_id, match_status FROM entity_id_crosswalk WHERE entity_type = 'player' AND source = 'highlightly' AND source_id = ANY($1::text[])`, [ids]);
  const byId = new Map(known.map((k) => [k.source_id, k]));
  const todo = [];
  for (const e of entries) {
    const k = byId.get(String(e.hlId));
    if (k?.match_status === 'matched') out.set(String(e.hlId), { status: 'matched', playerId: k.canonical_id, method: 'crosswalk' });
    else if (k) out.set(String(e.hlId), { status: 'held', reason: `crosswalk ${k.match_status}` });
    else todo.push(e);
  }
  if (!todo.length) return out;

  // Pool 1: the team's players around now (this or last season, or on its roster).
  const prev = `${Number(season.slice(0, 4)) - 1}-${season.slice(2, 4)}`;
  const { rows: team } = await db.query(
    `SELECT DISTINCT p.id, p.full_name AS name FROM players p
      WHERE p.current_team_id = $1
         OR p.id IN (SELECT s.player_id FROM player_game_stats s JOIN games g ON g.id = s.game_id
                      WHERE s.team_id = $1 AND g.season IN ($2, $3))`, [teamId, season, prev]);
  const { rows: everyone } = await db.query('SELECT id, full_name AS name, is_active FROM players');

  for (const e of todo) {
    const hlId = String(e.hlId);
    let r = matchPlayer(e.name, team);
    if (r.status === 'matched') {
      await db.query(XW, [r.id, hlId, 'matched', r.method]);
      out.set(hlId, { status: 'matched', playerId: r.id, method: r.method });
      continue;
    }
    if (r.method === 'no_candidate') {
      // Traded / newly signed from elsewhere in the league: unique exact name among ACTIVE players.
      const key = nameKey(e.name);
      let hits = everyone.filter((p) => p.is_active && nameKey(p.name) === key);
      if (hits.length > 1) hits = hits.filter((p) => suffixOf(p.name) === suffixOf(e.name));
      if (hits.length === 1) {
        await db.query(XW, [hits[0].id, hlId, 'matched', 'name+active_league']);
        await db.query('UPDATE players SET current_team_id = $2, updated_at = now() WHERE id = $1', [hits[0].id, teamId]);
        out.set(hlId, { status: 'matched', playerId: hits[0].id, method: 'name+active_league' });
        continue;
      }
      // Anyone at all who looks similar (retired namesake, initial+last) -> a human decides.
      // "Similar" = same normalized name, or same last name with one first name a
      // prefix of the other (Nic / Nicolas Claxton). Not every J. Smith in history.
      const first = (n) => nameKey(n).split(' ')[0] ?? '';
      const near = everyone.filter((p) => nameKey(p.name) === key
        || (initialKey(p.name) === initialKey(e.name) && (first(p.name).startsWith(first(e.name)) || first(e.name).startsWith(first(p.name)))));
      if (near.length === 0) {
        const parts = e.name.trim().split(/\s+/);
        const { rows: [p] } = await db.query(
          `INSERT INTO players (full_name, first_name, last_name, current_team_id, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [e.name.trim(), parts[0], parts.slice(1).join(' ') || null, teamId]);
        await db.query(XW, [p.id, hlId, 'matched', 'created_by_worker']);
        everyone.push({ id: p.id, name: e.name, is_active: true });
        out.set(hlId, { status: 'matched', playerId: p.id, method: 'created_by_worker', created: true });
        continue;
      }
      r = { status: 'manual_review', method: 'near_match', candidates: near.map((p) => p.name) };
    }
    // canonical_id is NOT NULL; 'unresolved' until someone picks the right player.
    await db.query(XW, ['unresolved', hlId, 'manual_review', `${r.method}: ${e.name} ~ ${(r.candidates ?? []).slice(0, 5).join(' | ')}`]);
    out.set(hlId, { status: 'held', reason: `${r.method} (${(r.candidates ?? []).join(', ')})` });
  }
  return out;
}
