// Guarded Highlightly client for the weekly job (docs/plans/M6-highlightly-weekly.md §4.1).
// Every request goes through one place that enforces: the per-run cap, the quota reserve (read from the
// x-ratelimit headers on EVERY response), 4 req/s pacing, and the 429 / 401 / 403 / 5xx rules.
// Errors and logs carry the endpoint kind, status and a fixed reason only: never the key, request
// headers, a URL with a query, or a response body.
import { hostFor } from './highlightly.js';
import { fixtureFetch } from './hl-fixture-fetch.js';

export const MAX_BODY = 5 * 1024 * 1024;
export const MAX_PAGES = 10;
const MAX_WAIT_ONE = 30000, MAX_WAIT_TOTAL = 60000;

export class BudgetStop extends Error {
  constructor(stop) { super(`highlightly stopped (${stop})`); this.name = 'BudgetStop'; this.stop = stop; this.reason = this.message; }
}
export class HighlightlyAuthError extends Error {
  constructor(status) { super(`highlightly auth rejected (${status})`); this.name = 'HighlightlyAuthError'; this.reason = this.message; }
}
export class HighlightlyUnavailable extends Error {
  constructor(kind) { super(`highlightly unreachable (${kind})`); this.name = 'HighlightlyUnavailable'; this.reason = this.message; }
}
export class HighlightlyMalformed extends Error {
  constructor(what) { super(`highlightly response malformed (${what})`); this.name = 'HighlightlyMalformed'; this.reason = this.message; }
}

const quotaInt = (v) => (v !== null && v !== undefined && /^\d{1,7}$/.test(String(v).trim()) ? Number(String(v).trim()) : null);
const endpointOf = (pq) => (pq.startsWith('/matches') ? 'matches' : pq.startsWith('/box-score') ? 'box-score' : pq.startsWith('/lineups') ? 'lineups' : 'other');

/** Retry-After as milliseconds: seconds or an HTTP date. Unknown/garbage -> null. */
export function retryAfterMs(v, nowMs) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/^\d{1,6}$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

export function createWeeklyHighlightly({
  key, fetchImpl, fixtures = process.env.HIGHLIGHTLY_FIXTURES, budget = 600, reserve = 1000, rps = 4, lastRemaining = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), log = () => {}, timeoutMs = 20000, backoffMs = [1000, 3000], maxBody = MAX_BODY,
} = {}) {
  const stats = { total: 0, byEndpoint: { matches: 0, 'box-score': 0, lineups: 0, other: 0 }, limit: null, remaining: quotaInt(lastRemaining), stop: null };
  let doFetch = fetchImpl;
  if (!doFetch && fixtures) doFetch = fixtureFetch(fixtures);          // fixture mode never uses globalThis.fetch
  let auth = null;
  if (!doFetch) {
    if (!key) throw new Error('HIGHLIGHTLY_API_KEY is not set');
    auth = hostFor(key);
    doFetch = (url, init) => globalThis.fetch(url, init);
  }
  const base = auth?.base ?? 'https://fixture.invalid';
  let lastAt = null, quotaWarned = false, waitedTotal = 0;

  const stopWith = (stop) => { stats.stop ??= stop; return new BudgetStop(stats.stop); };

  async function beforeRequest() {
    if (stats.stop) throw new BudgetStop(stats.stop);
    if (stats.total >= budget) throw stopWith('cap');
    if (stats.remaining !== null && stats.remaining - 1 < reserve) throw stopWith('reserve');
    if (lastAt !== null) { const wait = Math.ceil(1000 / rps) - (now() - lastAt); if (wait > 0) await sleep(wait); }
    lastAt = now();
  }

  function afterResponse(res, ep) {
    stats.total++; stats.byEndpoint[ep]++;
    const lim = quotaInt(res.headers?.get?.('x-ratelimit-requests-limit'));
    const rem = quotaInt(res.headers?.get?.('x-ratelimit-requests-remaining'));
    if (rem === null) { if (!quotaWarned) { quotaWarned = true; log('highlightly quota unknown (no usable rate-limit header)'); } }
    else { stats.remaining = rem; if (lim !== null) stats.limit = lim; }
  }

  // Reads the body with a hard size limit WHILE streaming (a response that never ends is cut at maxBody).
  async function readBody(res) {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const t = await res.text();
      if (t.length > maxBody) throw new HighlightlyMalformed('body too large');
      return t;
    }
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBody) { reader.cancel().catch(() => {}); throw new HighlightlyMalformed('body too large'); }
      parts.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  }

  // One attempt. The timeout covers the headers AND the body. Returns { res, text } (text only for 2xx).
  async function attempt(pq, ep) {
    let timer, counted = false;
    const ac = new AbortController();
    try {
      const init = { headers: auth?.headers ?? {}, signal: ac.signal };
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error('timeout'), { kind: 'timeout' })); }, timeoutMs); });
      const work = (async () => {
        const res = await doFetch(base + pq, init);
        afterResponse(res, ep); counted = true;
        const text = res.status >= 200 && res.status < 300 ? await readBody(res) : null;
        return { res, text };
      })();
      work.catch(() => {});
      return await Promise.race([work, timeout]);
    } catch (e) {
      if (e instanceof HighlightlyMalformed) throw e;
      if (!counted) { stats.total++; stats.byEndpoint[ep]++; }                  // a failed attempt was still sent
      throw Object.assign(new Error('fail'), { kind: e?.kind === 'timeout' ? 'timeout' : 'network' });
    } finally { clearTimeout(timer); }
  }

  /** @returns parsed JSON or null (404). */
  async function get(pq) {
    const ep = endpointOf(pq);
    let retries5xx = 0, retries429 = 0;
    for (;;) {
      await beforeRequest();
      let r;
      try { r = await attempt(pq, ep); } catch (e) {
        if (e instanceof HighlightlyMalformed) throw e;
        if (retries5xx < backoffMs.length) { await sleep(backoffMs[retries5xx++]); continue; }
        throw new HighlightlyUnavailable(e.kind);
      }
      const { res } = r;
      const st = res.status;
      if (st === 429) {
        if (retries429 >= 3) { stats.stop = 'rate_limited'; throw new BudgetStop('rate_limited'); }
        retries429++;
        const ra = retryAfterMs(res.headers?.get?.('retry-after'), now());
        const wait = Math.min(ra ?? 1000 * retries429, MAX_WAIT_ONE);
        waitedTotal += wait;
        if (waitedTotal > MAX_WAIT_TOTAL) { stats.stop = 'rate_limited'; throw new BudgetStop('rate_limited'); }
        log(`highlightly 429 on ${ep}, waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (st === 401 || st === 403) throw new HighlightlyAuthError(st);
      if (st === 404) return null;
      if (st >= 500) {
        if (retries5xx < backoffMs.length) { await sleep(backoffMs[retries5xx++]); continue; }
        throw new HighlightlyUnavailable(`HTTP ${st}`);
      }
      if (st < 200 || st >= 300) throw new HighlightlyMalformed(`HTTP ${st}`);
      const { text } = r;
      try { return JSON.parse(text); } catch { throw new HighlightlyMalformed('not JSON'); }
    }
  }

  const matchId = (id) => { if (!Number.isInteger(id) || id <= 0) throw new Error('bad match id'); return id; };

  return {
    stats,
    /** All NBA matches on an America/New_York date; a date counts only if every page arrived. */
    async matches(etDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(etDate)) throw new Error('bad date');
      const out = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * 100;
        const j = await get(`/matches?league=NBA&date=${etDate}&timezone=America/New_York&limit=100&offset=${offset}`);
        if (j === null) break;
        if (!j || !Array.isArray(j.data)) throw new HighlightlyMalformed('matches has no data array');
        out.push(...j.data);
        const total = Number.isInteger(j.pagination?.totalCount) ? j.pagination.totalCount : 0;
        if (j.data.length < 100 || out.length >= total) break;
      }
      return out;
    },
    boxScore: (id) => get(`/box-score/${matchId(id)}`),
    lineups: (id) => get(`/lineups/${matchId(id)}`),
  };
}
