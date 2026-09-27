import { Router } from 'express';
import { login, refresh, logout } from '../auth.js';

export function authRoutes(db) {
  const r = Router();
  r.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
        return res.status(400).json({ error: 'username and password are required' });
      const t = await login(db, username, password);
      if (!t) return res.status(401).json({ error: 'invalid_credentials' });
      const { refresh_id, ...tokens } = t;
      res.json(tokens);
    } catch (e) { next(e); }
  });
  r.post('/refresh', async (req, res, next) => {
    try {
      const token = req.body?.refresh_token;
      if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'refresh_token is required' });
      const t = await refresh(db, token);
      if (t.error) return res.status(401).json({ error: t.error });
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
