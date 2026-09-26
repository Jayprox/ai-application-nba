// Dry-run: Highlightly NBA API against real data before trusting it.
// Run from the repo root:  node scripts/dryrun-highlightly.mjs
// Reads HIGHLIGHTLY_API_KEY from .env (never printed). ~8 requests total.
// Raw responses are saved to scripts/.dryrun-output/ (gitignored) for review.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
);
const KEY = env.HIGHLIGHTLY_API_KEY;
if (!KEY) { console.error('HIGHLIGHTLY_API_KEY missing from .env'); process.exit(1); }

// RapidAPI keys (50 chars, contain "msh") must go through RapidAPI's host;
// keys issued by Highlightly directly (UUID) go to nba.highlightly.net.
const VIA_RAPIDAPI = KEY.includes('msh');
const BASE = VIA_RAPIDAPI ? 'https://nba-ncaab-api.p.rapidapi.com' : 'https://nba.highlightly.net';
const HEADERS = VIA_RAPIDAPI
  ? { 'x-rapidapi-key': KEY, 'x-rapidapi-host': 'nba-ncaab-api.p.rapidapi.com' }
  : { 'x-rapidapi-key': KEY };
console.log(`Using ${VIA_RAPIDAPI ? 'RapidAPI' : 'Highlightly direct'} (${BASE})`);
const OUT = new URL('./.dryrun-output/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o) : typeof o);
async function get(label, path) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    writeFileSync(new URL(`${label}.json`, OUT), json ? JSON.stringify(json, null, 2) : text);
    writeFileSync(new URL(`${label}.headers.json`, OUT), JSON.stringify({ status: r.status, headers: Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|quota|limit/i.test(k))) }, null, 2));
    const data = json?.data ?? json;
    const first = Array.isArray(data) ? data[0] : data;
    console.log(`\n[${label}] GET ${path}`);
    console.log(`  status=${r.status} ms=${Date.now() - t0} quota=${r.headers.get('x-ratelimit-requests-remaining')}/${r.headers.get('x-ratelimit-requests-limit')} (all ratelimit headers: ${JSON.stringify([...r.headers].filter(([k]) => k.includes('ratelimit')))})`);
    console.log(`  top-level: ${JSON.stringify(keysOf(json))}  count: ${Array.isArray(data) ? data.length : '-'}`);
    console.log(`  first record keys: ${JSON.stringify(keysOf(first))}`);
    if (!r.ok) console.log(`  body: ${text.slice(0, 300)}`);
    return json;
  } catch (e) {
    console.log(`\n[${label}] GET ${path}\n  ERROR after ${Date.now() - t0}ms: ${e}`);
    return null;
  }
}
const list = (j) => (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []);

// 1. A real completed game day (last day of the 2025-26 regular season)
const day = await get('01-matches-2026-04-12', '/matches?league=NBA&date=2026-04-12&timezone=America/New_York');
const matchId = list(day)[0]?.id;
// 2. Match detail — does it really carry injuries?
if (matchId) await get('02-match-detail', `/matches/${matchId}`);
// 3. Box score — per-player stat fields
if (matchId) await get('03-box-score', `/box-score/${matchId}`);
// 4. Player search + season stats
const pl = await get('04-players-search', '/players?name=Jokic&limit=5');
const pid = list(pl)[0]?.id;
if (pid) await get('05-player-statistics', `/players/${pid}/statistics`);
// 5. Standings
await get('06-standings', '/standings?leagueName=NBA&year=2025');
// 6. Upcoming preseason day — is 2026-27 loaded yet?
await get('07-matches-2026-10-06', '/matches?league=NBA&date=2026-10-06&timezone=America/New_York');

// 7. Injuries check: detail + lineups for the next upcoming game (docs say injuries live on match detail)
const upcomingId = list(await get('08-matches-2026-10-21', '/matches?league=NBA&date=2026-10-21&timezone=America/New_York'))[0]?.id;
if (upcomingId) await get('09-upcoming-match-detail', `/matches/${upcomingId}`);
if (matchId) await get('10-lineups-finished', `/lineups/${matchId}`);

console.log(`\nDone. Raw JSON saved under scripts/.dryrun-output/`);
