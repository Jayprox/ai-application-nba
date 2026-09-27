// Redis query-result cache (PLATFORM.md §2: caching, never precomputation).
// Optional: with no REDIS_URL, or if Redis is down, every call is a miss and
// the API still answers correctly — just without the fast path.
import { createClient } from 'redis';

export async function createCache(url = process.env.REDIS_URL) {
  if (!url) return nullCache();
  const client = createClient({ url, socket: { reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
  client.on('error', () => {}); // degrade to misses; never crash the API
  try { await client.connect(); } catch { return nullCache(); }
  return {
    async get(key) { try { const v = await client.get(key); return v ? JSON.parse(v) : null; } catch { return null; } },
    async set(key, value, ttlSeconds) { try { await client.set(key, JSON.stringify(value), { EX: ttlSeconds }); } catch { /* ignore */ } },
    async close() { try { await client.quit(); } catch { /* ignore */ } },
  };
}
export function nullCache() {
  return { async get() { return null; }, async set() {}, async close() {} };
}
