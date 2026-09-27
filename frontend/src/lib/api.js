// The only way the web app talks to backend-api.
//
// Tokens: both live in localStorage so every tab sees the same pair. That
// matters because refresh tokens ROTATE and a replayed one revokes every
// session (PLATFORM.md §2). If two tabs (or two requests in one tab) each
// refreshed with the same token, the second would be a replay and sign the
// user out everywhere. So refreshing is:
//   - single-flight inside a tab (one shared promise), and
//   - serialized across tabs with a Web Lock; inside the lock we re-read
//     storage, and if another tab already refreshed we just use its tokens.

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const KEY = 'ctnba.session';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code ?? `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

// ---- session storage (never throws: private mode / blocked storage) -------
export function readSession() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; }
}
function writeSession(s) {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(s));
}
const listeners = new Set();
/** Called with the new session (or null) whenever it changes, in this tab or another. */
export function onSessionChange(fn) {
  listeners.add(fn);
  const onStorage = (e) => { if (e.key === KEY) fn(readSession()); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage); };
}

export function usernameOf(session) {
  try { return JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).name ?? null; }
  catch { return null; }
}

// ---- raw HTTP ---------------------------------------------------------------
async function send(path, { method = 'GET', body, token, signal } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    signal,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, json?.error, json?.error);
  return json;
}

// ---- auth -------------------------------------------------------------------
export async function login(username, password) {
  const t = await send('/login', { method: 'POST', body: { username, password } });
  writeSession({ access_token: t.access_token, refresh_token: t.refresh_token });
  return readSession();
}

export async function logout() {
  const s = readSession();
  writeSession(null);
  if (s?.refresh_token) await send('/logout', { method: 'POST', body: { refresh_token: s.refresh_token } }).catch(() => {});
}

let inFlight = null;
/** Get a fresh access token. `failedToken` = the access token the server just rejected. */
function refreshSession(failedToken) {
  inFlight ??= withLock(async () => {
    const s = readSession();
    if (!s?.refresh_token) throw new ApiError(401, 'signed_out');
    if (s.access_token !== failedToken) return s;          // another tab already refreshed
    try {
      const t = await send('/refresh', { method: 'POST', body: { refresh_token: s.refresh_token } });
      const next = { access_token: t.access_token, refresh_token: t.refresh_token };
      writeSession(next);
      return next;
    } catch (e) {
      if (e.status === 401 || e.status === 400) writeSession(null);  // expired/revoked: sign out everywhere
      throw e;
    }
  }).finally(() => { inFlight = null; });
  return inFlight;
}

function withLock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request('ctnba-refresh', fn);
  return fn();
}

/** Authenticated request. Refreshes once on an expired/invalid access token. */
export async function api(path, { method, body, signal } = {}) {
  const s = readSession();
  if (!s) throw new ApiError(401, 'signed_out');
  try {
    return await send(path, { method, body, signal, token: s.access_token });
  } catch (e) {
    if (e.status !== 401 || signal?.aborted) throw e;
    const fresh = await refreshSession(s.access_token);
    return send(path, { method, body, signal, token: fresh.access_token });
  }
}
