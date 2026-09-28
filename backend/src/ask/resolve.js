// Names in a plan -> our ids. Accent/suffix tolerant (names.js), plus the
// nicknames people actually type. Ambiguous = ask, never guess.
import { matchesSearch, nameKey } from '../lib/names.js';

const PLAYER_NICK = {
  sga: 'Shai Gilgeous-Alexander', shai: 'Shai Gilgeous-Alexander', kd: 'Kevin Durant', lebron: 'LeBron James', bron: 'LeBron James',
  'king james': 'LeBron James', giannis: 'Giannis Antetokounmpo', 'greek freak': 'Giannis Antetokounmpo', wemby: 'Victor Wembanyama',
  ad: 'Anthony Davis', 'the brow': 'Anthony Davis', cp3: 'Chris Paul', steph: 'Stephen Curry', 'chef curry': 'Stephen Curry', luka: 'Luka Dončić',
  jokic: 'Nikola Jokić', joker: 'Nikola Jokić', ant: 'Anthony Edwards', 'ant man': 'Anthony Edwards', dame: 'Damian Lillard', kat: 'Karl-Anthony Towns',
  jjj: 'Jaren Jackson Jr.', 'pg13': 'Paul George', pg: 'Paul George', melo: 'Carmelo Anthony', kobe: 'Kobe Bryant', shaq: "Shaquille O'Neal",
  'the beard': 'James Harden', harden: 'James Harden', embiid: 'Joel Embiid', ja: 'Ja Morant', zion: 'Zion Williamson', trae: 'Trae Young',
  cade: 'Cade Cunningham', chet: 'Chet Holmgren', bam: 'Bam Adebayo', tatum: 'Jayson Tatum', brunson: 'Jalen Brunson', maxey: 'Tyrese Maxey',
};
const TEAM_NICK = {
  sixers: '76ers', cavs: 'Cavaliers', mavs: 'Mavericks', wolves: 'Timberwolves', twolves: 'Timberwolves', blazers: 'Trail Blazers',
  dubs: 'Warriors', 'golden state': 'Warriors', gs: 'Warriors', nola: 'Pelicans', pels: 'Pelicans', okc: 'Thunder', 'new york': 'Knicks',
  'san antonio': 'Spurs', 'new orleans': 'Pelicans', 'oklahoma city': 'Thunder', 'los angeles lakers': 'Lakers', 'los angeles clippers': 'Clippers',
  'la lakers': 'Lakers', 'la clippers': 'Clippers', clips: 'Clippers', 'c\'s': 'Celtics', celts: 'Celtics', knickerbockers: 'Knicks', nuggs: 'Nuggets',
  grizz: 'Grizzlies', 'brooklyn': 'Nets', 'philly': '76ers', 'philadelphia': '76ers', raps: 'Raptors', 'the heat': 'Heat',
};

/**
 * @param players [{id, full_name, is_active, games}]  (games = box-score rows, for tie-breaking)
 * @returns {id, name} | {ambiguous: [{id, name}]} | {none: true}   Pure; tested.
 */
export function resolvePlayer(query, players) {
  const q = String(query ?? '').trim();
  if (!q) return { none: true };
  const nick = PLAYER_NICK[q.toLowerCase().replace(/[.']/g, '')];
  const key = nameKey(nick ?? q);
  let hits = players.filter((p) => nameKey(p.full_name) === key);
  if (!hits.length) {
    const last = (n) => nameKey(n).split(' ').filter(Boolean).at(-1);
    hits = key.includes(' ') ? players.filter((p) => matchesSearch(p.full_name, q)) : players.filter((p) => last(p.full_name) === key || nameKey(p.full_name).split(' ')[0] === key);
    if (!hits.length) hits = players.filter((p) => matchesSearch(p.full_name, q));
  }
  if (!hits.length) return { none: true };
  if (hits.length === 1) return { id: hits[0].id, name: hits[0].full_name };
  // Several: an active player with far more games wins ("Curry" -> Stephen, not Seth; "Harden"); otherwise ask.
  const sorted = [...hits].sort((a, b) => Number(b.is_active) - Number(a.is_active) || b.games - a.games);
  const [a, b] = sorted;
  if (a.is_active && (!b.is_active || a.games >= 3 * b.games)) return { id: a.id, name: a.full_name };
  return { ambiguous: sorted.slice(0, 5).map((p) => ({ id: p.id, name: p.full_name })) };
}

/** @param teams [{id, abbreviation, city, name, full_name}]  Pure; tested. */
export function resolveTeam(query, teams) {
  const raw = String(query ?? '').trim().toLowerCase().replace(/^the\s+/, '');
  if (!raw) return { none: true };
  const q = (TEAM_NICK[raw] ?? raw).toLowerCase();
  const eq = (s) => String(s).toLowerCase() === q;
  let hits = teams.filter((t) => eq(t.abbreviation) || eq(t.name) || eq(t.full_name));
  if (!hits.length) hits = teams.filter((t) => eq(t.city) || (q === 'la' && /^(los angeles|la)$/i.test(t.city)) || (q.length >= 4 && t.full_name.toLowerCase().includes(q)));
  if (hits.length === 1) return { id: hits[0].id, name: hits[0].full_name, abbr: hits[0].abbreviation };
  if (hits.length > 1) return { ambiguous: hits.map((t) => ({ id: t.id, name: t.full_name })) };
  return { none: true };
}

let cache = null;
/** Players with game counts, cached for an hour (2.5k rows). */
export async function playerPool(db) {
  if (cache && Date.now() - cache.at < 3600e3) return cache.rows;
  const { rows } = await db.query(
    `SELECT p.id, p.full_name, p.is_active, coalesce(c.n, 0)::int AS games FROM players p
       LEFT JOIN (SELECT player_id, count(*) n FROM player_game_stats WHERE NOT dnp GROUP BY 1) c ON c.player_id = p.id`);
  cache = { at: Date.now(), rows };
  return rows;
}
