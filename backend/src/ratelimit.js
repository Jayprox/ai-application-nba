// Brute-force guard for /login and /refresh (Phase 6). In memory: fine for a
// single backend-api replica; limits reset on redeploy. Counts FAILURES only,
// so normal users never notice it.
//   - per IP + username: 10 failed logins / 15 min  (password guessing on one account)
//   - per IP:            30 failures / 15 min       (spraying many accounts)
export function createLimiter({ windowMs = 15 * 60e3, perKey = 10, perIp = 30, now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> [timestamps]
  const recent = (k) => {
    const t = now();
    const list = (hits.get(k) ?? []).filter((x) => t - x < windowMs);
    if (list.length) hits.set(k, list); else hits.delete(k);
    return list;
  };
  return {
    /** Seconds until allowed again, or 0 when the request may proceed. */
    blockedFor(ip, user = '') {
      const a = recent(`ip:${ip}`), b = recent(`u:${ip}:${user}`);
      const over = (list, max) => (list.length >= max ? Math.ceil((list[0] + windowMs - now()) / 1000) : 0);
      return Math.max(over(a, perIp), over(b, perKey));
    },
    fail(ip, user = '') {
      for (const k of [`ip:${ip}`, `u:${ip}:${user}`]) hits.set(k, [...recent(k), now()]);
      if (hits.size > 5000) for (const k of [...hits.keys()]) recent(k);   // bound memory under a spray
    },
    sweep() { for (const k of [...hits.keys()]) recent(k); },
    succeed(ip, user = '') { hits.delete(`u:${ip}:${user}`); },
    size: () => hits.size,
  };
}
