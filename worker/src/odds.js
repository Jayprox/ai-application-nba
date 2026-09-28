// The Odds API client (player props; architecture.md §7.6). DraftKings only.
// GET /events is free; GET /events/{id}/odds costs 10 credits per market
// returned (12 markets -> up to 120 per call). Quota comes back in the
// x-requests-* headers so the planner can stop before running out.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ODDS_MARKETS } from './odds-map.js';

const HOST = 'https://api.the-odds-api.com/v4/sports';

export function createOdds({ key = process.env.ODDS_API_KEY, fixtures = process.env.ODDS_FIXTURES, book = 'draftkings', sport = 'basketball_nba', timeoutMs = 20000 } = {}) {
  const quota = { remaining: null, used: null, last: null, at: null };
  const calls = { n: 0 };

  async function get(pathAndQuery, fixtureName) {
    calls.n++;
    if (fixtures) {
      try { return JSON.parse(readFileSync(path.join(fixtures, `${fixtureName}.json`), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
    if (!key) throw new Error('ODDS_API_KEY is not set');
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const res = await fetch(`${HOST}/${sport}${pathAndQuery}${sep}apiKey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const rem = res.headers.get('x-requests-remaining');
    if (rem !== null) {
      Object.assign(quota, { remaining: Number(rem), used: Number(res.headers.get('x-requests-used')),
        last: Number(res.headers.get('x-requests-last')), at: new Date().toISOString() });
    }
    if (res.status === 404) return null;
    // Never echo the URL: it carries the key.
    if (!res.ok) throw new Error(`The Odds API ${res.status} on ${pathAndQuery.split('?')[0]}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  return {
    quota,
    calls,
    configured: Boolean(key || fixtures),
    book,
    /** NBA events commencing in [from, to] (free). */
    events: (from, to) => get(`/events?dateFormat=iso&commenceTimeFrom=${iso(from)}&commenceTimeTo=${iso(to)}`, 'events'),
    /** DraftKings player props for one event. */
    eventOdds: (eventId) => get(`/events/${eventId}/odds?bookmakers=${book}&markets=${Object.keys(ODDS_MARKETS).join(',')}&oddsFormat=american&dateFormat=iso`,
      `event-odds_${eventId}`),
  };
}

// The Odds API wants 2026-10-21T23:00:00Z (no milliseconds).
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
