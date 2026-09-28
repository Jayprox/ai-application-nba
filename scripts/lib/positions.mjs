// NBA.com player index -> listed positions (pure; tested in positions.test.mjs).
const VALID = /^(G|F|C)(-(G|F|C))?$/;

/** index rows -> Map(nbaPersonId -> 'G' | 'F-C' | ...); blanks and odd values dropped. */
export function positionsFromIndex(indexRows) {
  const out = new Map();
  for (const r of indexRows) {
    const pos = String(r.POSITION ?? '').trim().toUpperCase();
    if (VALID.test(pos)) out.set(String(r.PERSON_ID), pos);
  }
  return out;
}

/**
 * What to write: only players with NO listed position get one (the roster
 * listing the seed wrote for current players wins).
 * @param players [{id, nba_id, listed_position}]
 * @returns [{id, pos}]
 */
export function positionUpdates(players, byNbaId) {
  return players.filter((p) => !p.listed_position && byNbaId.has(String(p.nba_id))).map((p) => ({ id: p.id, pos: byNbaId.get(String(p.nba_id)) }));
}
