// Vendor fetchers for scripts run from JD's Mac (NBA.com blocks Railway IPs).
// Set SEED_FIXTURES=<dir> to read <name>.json from disk instead of the
// network — used to test the scripts against captured real responses.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = process.env.SEED_FIXTURES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(name) {
  if (!FIXTURES) return undefined; // live mode: callers fall through to the network
  const p = join(FIXTURES, `${name}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function getJson(url, headers, { retries = 3, timeoutMs = 30000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt >= retries) throw new Error(`${url.split('?')[0]} failed after ${attempt} attempts: ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
}

// ---- NBA.com ---------------------------------------------------------------
// stats.nba.com hangs on requests that don't look like a browser.
const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
};
let lastNbaCall = 0;
async function nbaStats(endpoint, params) {
  const wait = 700 - (Date.now() - lastNbaCall); // be polite: ~1.4 req/s max
  if (wait > 0) await sleep(wait);
  lastNbaCall = Date.now();
  const qs = new URLSearchParams(params).toString();
  return getJson(`https://stats.nba.com/stats/${endpoint}?${qs}`, NBA_HEADERS);
}

/** resultSet -> array of plain objects keyed by header. */
export function rows(json, setName) {
  const set = setName ? json.resultSets.find((s) => s.name === setName) : json.resultSets[0];
  return set.rowSet.map((r) => Object.fromEntries(set.headers.map((h, i) => [h, r[i]])));
}

export async function nbaStandings(season) {
  return fixture(`standings_${season}`) ?? nbaStats('leaguestandingsv3', { LeagueID: '00', Season: season, SeasonType: 'Regular Season' });
}
export async function nbaAllPlayers(season) {
  return fixture(`allplayers_${season}`) ?? nbaStats('commonallplayers', { IsOnlyCurrentSeason: '0', LeagueID: '00', Season: season });
}
/** Every player ever (Historical=1) with NBA.com's listed POSITION — retired players included. */
export async function nbaPlayerIndex(season) {
  return fixture(`playerindex_${season}`) ?? nbaStats('playerindex', { College: '', Country: '', DraftPick: '', DraftRound: '', DraftYear: '', Height: '',
    Historical: '1', LeagueID: '00', Season: season, SeasonType: 'Regular Season', TeamID: '0', Weight: '' });
}
/** Returns undefined in fixture mode when that team's roster wasn't captured. */
export async function nbaRoster(teamId, season) {
  if (FIXTURES) return fixture(`roster_${teamId}_${season}`);
  return nbaStats('commonteamroster', { LeagueID: '00', Season: season, TeamID: String(teamId) });
}
export async function nbaSchedule() {
  if (FIXTURES) return fixture('schedule');
  return getJson('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', NBA_HEADERS);
}

/** Full season schedule incl. arena, tip times, playoff/Cup labels, national TV (1996-97+). */
export async function nbaScheduleSeason(season) {
  if (FIXTURES) return fixture(`schedule_${season}`);
  return nbaStats('scheduleleaguev2', { LeagueID: '00', Season: season });
}
/** Every team- or player-game row for one season type ('Regular Season' | 'Playoffs' | 'PlayIn' | 'IST'). */
export async function nbaGameLog(season, seasonType, playerOrTeam) {
  const name = `gamelog_${season}_${seasonType.replace(/\W+/g, '')}_${playerOrTeam}`;
  if (FIXTURES) return fixture(name) ?? { resultSets: [{ name: 'LeagueGameLog', headers: [], rowSet: [] }] };
  return nbaStats('leaguegamelog', { Counter: '0', Direction: 'ASC', LeagueID: '00', PlayerOrTeam: playerOrTeam, Season: season, SeasonType: seasonType, Sorter: 'DATE' });
}

// ---- Highlightly -----------------------------------------------------------
export async function highlightlyMatches(date, key) {
  if (FIXTURES) return fixture(`highlightly_matches_${date}`) ?? { data: [] };
  const direct = !key.includes('msh');
  const base = direct ? 'https://nba.highlightly.net' : 'https://nba-ncaab-api.p.rapidapi.com';
  const headers = direct ? { 'x-rapidapi-key': key } : { 'x-rapidapi-key': key, 'x-rapidapi-host': 'nba-ncaab-api.p.rapidapi.com' };
  return getJson(`${base}/matches?league=NBA&date=${date}&timezone=America/New_York`, headers);
}

// ---- Open-Meteo geocoding (city elevation, free, no key) --------------------
export async function geocode(city, countryCode) {
  const name = `${city}_${countryCode ?? 'ANY'}`.replace(/\W+/g, '_');
  if (FIXTURES) return fixture(`geocode_${name}`);
  const qs = new URLSearchParams({ name: city, count: '10', language: 'en', format: 'json', ...(countryCode ? { countryCode } : {}) });
  return getJson(`https://geocoding-api.open-meteo.com/v1/search?${qs}`, {});
}
