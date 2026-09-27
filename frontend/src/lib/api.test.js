// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, login, readSession } from './api.js';

// A fake backend with rotating refresh tokens and replay detection, like the real one.
function fakeServer() {
  const state = { access: 'A1', refresh: 'R1', used: new Set(), refreshCalls: 0, revokedAll: false };
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/login') return json(200, { access_token: state.access, refresh_token: state.refresh });
    if (path === '/refresh') {
      state.refreshCalls++;
      if (state.used.has(body.refresh_token)) { state.revokedAll = true; return json(401, { error: 'refresh_token_reused' }); }
      if (body.refresh_token !== state.refresh) return json(401, { error: 'invalid_refresh_token' });
      state.used.add(state.refresh);
      state.refresh = `R${state.refreshCalls + 1}`; state.access = `A${state.refreshCalls + 1}`;
      await new Promise((r) => setTimeout(r, 5));
      return json(200, { access_token: state.access, refresh_token: state.refresh });
    }
    const auth = init.headers.authorization;
    if (auth !== `Bearer ${state.access}`) return json(401, { error: 'access_token_expired' });
    return json(200, { data: path });
  });
  return state;
}

describe('api client token refresh', () => {
  let server;
  beforeEach(async () => { localStorage.clear(); server = fakeServer(); await login('jd', 'pw'); });
  afterEach(() => vi.restoreAllMocks());

  it('refreshes once and retries when the access token expires', async () => {
    server.access = 'A-next';                           // server no longer accepts A1
    const r = await api('/teams');
    expect(r.data).toBe('/teams');
    expect(server.refreshCalls).toBe(1);
    expect(readSession().refresh_token).toBe('R2');
  });

  it('many parallel 401s share ONE refresh (no replay, no sign-out everywhere)', async () => {
    server.access = 'rotated';
    const results = await Promise.all(['/a', '/b', '/c', '/d', '/e'].map((p) => api(p)));
    expect(results.map((r) => r.data)).toEqual(['/a', '/b', '/c', '/d', '/e']);
    expect(server.refreshCalls).toBe(1);
    expect(server.revokedAll).toBe(false);
  });

  it('a revoked session signs out locally', async () => {
    server.refresh = 'someone-else';
    server.access = 'rotated';
    await expect(api('/teams')).rejects.toMatchObject({ status: 401 });
    expect(readSession()).toBeNull();
  });
});
