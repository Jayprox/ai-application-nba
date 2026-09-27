// Player-name normalization + cross-vendor matching.
//
// Why this exists: NBA.com and Highlightly spell the same player differently
// ("Nikola Jokić" vs "Nikola Jokic"), and suffixes are inconsistent even
// within one vendor ("Terrence Shannon Jr" vs "Jaren Jackson Jr."). Chalk
// That NFL once failed to show James Cook because he's "James Cook III".
//
// But a normalized name is NOT an identity: stripping suffixes makes 20 pairs
// of different NBA players (1996-97+) collide — Tim Hardaway / Tim Hardaway
// Jr., Gary Payton / Gary Payton II, two different Mike James. So:
//   * nameKey() only GENERATES candidates;
//   * matchPlayer() decides using team + date context, prefers an exact
//     suffix, and returns manual_review instead of guessing.
// Used by the seed/backfill scripts and (copied, per PLATFORM.md's
// no-shared-code rule) by the ingestion worker and the player search.

const SUFFIX_RE = /\s+(jr|sr|ii|iii|iv|v)\.?$/i;

/** Strip accents: "Jokić" -> "Jokic", "Porziņģis" -> "Porzingis". */
export function stripAccents(s) {
  // Letters that don't decompose into base + accent: Đ is written "Dj" in
  // English (Đurišić -> Djurisic, as Highlightly and NBA.com rosters do).
  const special = { 'Đ': 'Dj', 'đ': 'dj', 'Ł': 'L', 'ł': 'l', 'Ø': 'O', 'ø': 'o', 'ß': 'ss', 'Æ': 'Ae', 'æ': 'ae' };
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ĐđŁłØøßÆæ]/g, (c) => special[c]);
}

/** "Jaren Jackson Jr." -> "jr", "Trey Murphy III" -> "iii", else null. */
export function suffixOf(name) {
  const m = stripAccents(name).trim().match(SUFFIX_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Candidate key: lowercase, no accents, no periods/apostrophes, hyphens ->
 * spaces, suffix removed, whitespace collapsed.
 *   "P.J. Washington" -> "pj washington"
 *   "Karl-Anthony Towns" -> "karl anthony towns"
 *   "James Cook III" -> "james cook"
 */
export function nameKey(name) {
  return stripAccents(name)
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SUFFIX_RE, '')
    .trim();
}

/** Looser key for nicknames (Nic/Nicolas, Herb/Herbert): last name + first initial. */
export function initialKey(name) {
  const parts = nameKey(name).split(' ');
  if (parts.length < 2) return parts[0] ?? '';
  return parts[0][0] + ' ' + parts.slice(1).join(' ');
}

/** Search matching for the UI: every query word must prefix-match a word of the key. */
export function matchesSearch(name, query) {
  const words = nameKey(name).split(' ');
  const q = nameKey(query).split(' ').filter(Boolean);
  return q.length > 0 && q.every((t) => words.some((w) => w.startsWith(t)));
}

/**
 * Decide which canonical player a vendor name refers to.
 * @param {string} vendorName   e.g. Highlightly's "Nikola Jokic"
 * @param {Array<{id:string, name:string}>} pool  canonical players who were on
 *        THAT team around THAT game date (caller builds this from game logs /
 *        rosters) — the team+date context is what makes matching safe.
 * @returns {{status:'matched'|'manual_review', id?:string, method:string, candidates?:string[]}}
 */
export function matchPlayer(vendorName, pool) {
  const key = nameKey(vendorName);
  const sfx = suffixOf(vendorName);

  let hits = pool.filter((p) => nameKey(p.name) === key);
  if (hits.length > 1) {
    const sameSuffix = hits.filter((p) => suffixOf(p.name) === sfx);
    if (sameSuffix.length === 1) return { status: 'matched', id: sameSuffix[0].id, method: 'name+suffix+team+date' };
    return { status: 'manual_review', method: 'ambiguous_name', candidates: hits.map((p) => p.name) };
  }
  if (hits.length === 1) return { status: 'matched', id: hits[0].id, method: 'name+team+date' };

  hits = pool.filter((p) => initialKey(p.name) === initialKey(vendorName));
  if (hits.length === 1) return { status: 'matched', id: hits[0].id, method: 'initial+last+team+date' };
  if (hits.length > 1) return { status: 'manual_review', method: 'ambiguous_initial', candidates: hits.map((p) => p.name) };

  return { status: 'manual_review', method: 'no_candidate' };
}
