// Local dev server: `npm run dev` from backend/. Reads the repo-root .env,
// talks to Railway Postgres through DATABASE_PUBLIC_URL, no Redis needed.
// Production (Railway) uses `npm start` with real env vars instead.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env: use the shell's env */ }

process.env.DATABASE_URL ??= process.env.DATABASE_PUBLIC_URL;
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  console.log('[dev] no JWT_SECRET in .env: using a random one (you sign in again after each restart)');
}

const { createApp } = await import('../src/server.js');
const { createPool } = await import('../src/db.js');
const { createCache } = await import('../src/cache.js');
const port = Number(process.env.PORT ?? 3000);
createApp({ db: createPool(), cache: await createCache() })
  .listen(port, () => console.log(`[dev] backend-api on http://localhost:${port}  (db: ${new URL(process.env.DATABASE_URL).host})`));
