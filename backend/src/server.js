// Chalk That NBA backend-api. The only public service: auth + POST /query +
// browse routes, for every client (web, iOS, AI agents).
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';
import { createCache } from './cache.js';
import { authenticate, jwtSecret } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { queryRoutes } from './routes/query.js';
import { browseRoutes } from './routes/browse.js';

export function createApp({ db, cache, corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()), currentSeason = process.env.CURRENT_SEASON ?? '2026-27' }) {
  jwtSecret(); // fail fast at startup if unset
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins, credentials: false })); // allow-list, never '*'
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.use(authRoutes(db));                         // /login /refresh /logout (public)
  app.use(authenticate(db));                       // everything below needs JWT or API key
  app.use(queryRoutes(db, cache, { currentSeason }));
  app.use(browseRoutes(db, { currentSeason }));

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, _req, res, _next) => {             // never leak stack traces
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    console.error('[api] unhandled:', err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool();
  const cache = await createCache();
  const port = Number(process.env.PORT ?? 8080);
  createApp({ db, cache }).listen(port, () => console.log(`[server] chalk-that-nba backend-api listening on :${port}`));
}
