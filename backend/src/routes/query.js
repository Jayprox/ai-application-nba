import { Router } from 'express';
import { runQuery, QueryError } from '../query/engine.js';

export function queryRoutes(db, cache, opts) {
  const r = Router();
  r.post('/query', async (req, res, next) => {
    try {
      res.json(await runQuery(db, cache, req.body, opts));
    } catch (e) {
      if (e instanceof QueryError) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
  return r;
}
