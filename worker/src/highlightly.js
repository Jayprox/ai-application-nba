// Highlightly NBA API client (direct key -> nba.highlightly.net; a RapidAPI
// key needs RapidAPI's host — architecture.md §3.1). Reports quota from the
// x-ratelimit headers so the worker can slow down before running out.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function createHighlightly({ key = process.env.HIGHLIGHTLY_API_KEY, fixtures = process.env.HIGHLIGHTLY_FIXTURES, timeoutMs = 20000 } = {}) {
  const quota = { limit: null, remaining: null, at: null };
  const calls = { n: 0 };

  async function get(pathAndQuery, fixtureName) {
    calls.n++;
    if (fixtures) {
      try { return JSON.parse(readFileSync(path.join(fixtures, `${fixtureName}.json`), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
    if (!key) throw new Error('HIGHLIGHTLY_API_KEY is not set');
    const direct = !key.includes('msh');
    const base = direct ? 'https://nba.highlightly.net' : 'https://nba-ncaab-api.p.rapidapi.com';
    const headers = direct ? { 'x-rapidapi-key': key } : { 'x-rapidapi-key': key, 'x-rapidapi-host': 'nba-ncaab-api.p.rapidapi.com' };
    const res = await fetch(base + pathAndQuery, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const lim = res.headers.get('x-ratelimit-requests-limit'), rem = res.headers.get('x-ratelimit-requests-remaining');
    if (rem !== null) Object.assign(quota, { limit: Number(lim), remaining: Number(rem), at: new Date().toISOString() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Highlightly ${res.status} on ${pathAndQuery}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  return {
    quota,
    calls,
    /** All NBA matches on an America/New_York date (handles pagination). */
    async matches(etDate) {
      const out = [];
      for (let offset = 0; ; offset += 100) {
        const j = await get(`/matches?league=NBA&date=${etDate}&timezone=America/New_York&limit=100&offset=${offset}`, `matches_${etDate}`);
        const page = j?.data ?? [];
        out.push(...page);
        if (fixtures || page.length < 100 || out.length >= (j?.pagination?.totalCount ?? 0)) break;
      }
      return out;
    },
    boxScore: (matchId) => get(`/box-score/${matchId}`, `box-score_${matchId}`),
    lineups: (matchId) => get(`/lineups/${matchId}`, `lineups_${matchId}`),
  };
}
