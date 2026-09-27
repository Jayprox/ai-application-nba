import { Router } from 'express';
import { login, refresh, logout } from '../auth.js';
import { createLimiter } from '../ratelimit.js';

export function authRoutes(db, { limiter = createLimiter() } = {}) {
  const r = Router();
  const tooMany = (res, secs) => res.status(429).set('retry-after', String(secs)).json({ error: 'too_many_attempts', retry_after_seconds: secs });
  r.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
        return res.status(400).json({ error: 'username and password are required' });
      if (username.length > 100 || password.length > 200) return res.status(400).json({ error: 'username or password too long' });
      const wait = limiter.blockedFor(req.ip, username.toLowerCase());
      if (wait) return tooMany(res, wait);
      const t = await login(db, username, password);
      if (!t) { limiter.fail(req.ip, username.toLowerCase()); return res.status(401).json({ error: 'invalid_credentials' }); }
      limiter.succeed(req.ip, username.toLowerCase());
      const { refresh_id, ...tokens } = t;
      res.json(tokens);
    } catch (e) { next(e); }
  });
  r.post('/refresh', async (req, res, next) => {
    try {
      const token = req.body?.refresh_token;
      if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'refresh_token is required' });
      const wait = limiter.blockedFor(req.ip, '#refresh');
      if (wait) return tooMany(res, wait);
      const t = await refresh(db, token);
      if (t.error) { limiter.fail(req.ip, '#refresh'); return res.status(401).json({ error: t.error }); }
      const { refresh_id, ...tokens } = t;
      res.json(tokens);
    } catch (e) { next(e); }
  });
  r.post('/logout', async (req, res, next) => {
    try {
      if (typeof req.body?.refresh_token === 'string') await logout(db, req.body.refresh_token);
      res.status(204).end();
    } catch (e) { next(e); }
  });
  return r;
}
