// fetch() stand-in for tests and drills (HIGHLIGHTLY_FIXTURES=<dir>). Never touches the network.
// Request path -> file in `dir`:
//   /matches?date=D&offset=0    -> matches_D.json        (offset N>0 -> matches_D@N.json)
//   /box-score/ID               -> box-score_ID.json
//   /lineups/ID                 -> lineups_ID.json
// A missing file answers 404. Optional sidecar <name>.meta.json: { status, headers, retryAfter, rawBody, delayMs }
// for synthetic error cases. Optional <dir>/_quota.json { limit, remaining }: every call decrements
// `remaining` (in memory) and answers with the x-ratelimit headers, like the real API.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function fixtureName(pathAndQuery) {
  const u = new URL(pathAndQuery, 'http://fixture.invalid');
  let m;
  if (u.pathname === '/matches') {
    const date = u.searchParams.get('date') ?? '';
    const off = Number(u.searchParams.get('offset') ?? 0);
    return off > 0 ? `matches_${date}@${off}` : `matches_${date}`;
  }
  if ((m = /^\/box-score\/(\d+)$/.exec(u.pathname))) return `box-score_${m[1]}`;
  if ((m = /^\/lineups\/(\d+)$/.exec(u.pathname))) return `lineups_${m[1]}`;
  return null;
}

export function fixtureFetch(dir) {
  const quota = existsSync(path.join(dir, '_quota.json')) ? readJson(path.join(dir, '_quota.json')) : null;
  return async function fetchFixture(url) {
    const pq = String(url).replace(/^https?:\/\/[^/]+/, '');
    const name = fixtureName(pq);
    const headers = {};
    if (quota) {
      quota.remaining -= 1;
      headers['x-ratelimit-requests-limit'] = String(quota.limit);
      headers['x-ratelimit-requests-remaining'] = String(quota.remaining);
    }
    const metaPath = name && path.join(dir, `${name}.meta.json`);
    const meta = metaPath && existsSync(metaPath) ? readJson(metaPath) : null;
    if (meta?.delayMs) await new Promise((r) => setTimeout(r, meta.delayMs));
    if (meta?.headers) Object.assign(headers, meta.headers);
    if (meta?.retryAfter !== undefined) headers['retry-after'] = String(meta.retryAfter);
    let status = 200, body;
    if (meta?.status) status = meta.status;
    if (meta && 'rawBody' in meta) body = String(meta.rawBody);
    else if (name && existsSync(path.join(dir, `${name}.json`))) body = readFileSync(path.join(dir, `${name}.json`), 'utf8');
    else if (!meta?.status) { status = 404; body = '{}'; }
    else body = '{}';
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
      text: async () => body,
    };
  };
}
