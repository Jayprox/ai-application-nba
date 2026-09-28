// POST /ask — natural-language search (architecture.md §7.8).
//   {q: "Jokic on the second night of back-to-backs"}  -> Claude (Haiku) maps it to a plan
//   {plan: {...}}                                       -> re-run an edited plan (no model call)
// The model only chooses WHICH query to run; the numbers come from the same
// API as every screen, and the sentence is a template over those numbers.
import { Router } from 'express';
import { createLlm } from '../ask/llm.js';
import { normalizePlan, PLAN_TOOL, systemPrompt } from '../ask/planner.js';
import { playerPool, resolvePlayer, resolveTeam } from '../ask/resolve.js';
import { appLink, chips, firstRequest, seasonFor, summarize } from '../ask/answer.js';

const PER_MINUTE = 20, PER_DAY = 300;

export function askRoutes(db, cache, { currentSeason = '2026-27', llm = createLlm(), now = () => new Date() } = {}) {
  const r = Router();
  const usage = new Map();   // principal -> [timestamps] (in memory, like the login limiter)

  function limited(who) {
    const t = Date.now();
    const list = (usage.get(who) ?? []).filter((x) => t - x < 86400e3);
    usage.set(who, list);
    if (list.length >= PER_DAY) return 'daily';
    if (list.filter((x) => t - x < 60e3).length >= PER_MINUTE) return 'minute';
    list.push(t);
    return null;
  }

  r.post('/ask', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const q = typeof body.q === 'string' ? body.q.trim() : '';
      if (!body.plan && (q.length < 2 || q.length > 300)) return res.status(400).json({ error: 'q must be 2-300 characters' });
      const who = `${req.principal?.kind}:${req.principal?.id}`;

      const { rows: [s] } = await db.query(`SELECT max(season) AS latest, bool_or(season = $1) AS current FROM games WHERE status = 'final' AND season_type = 'regular'`, [currentSeason]);
      const ctx = { today: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now()), currentSeason, latestSeason: s.latest, seasonInProgress: Boolean(s.current) };

      let plan, cached = false;
      if (body.plan) plan = normalizePlan(body.plan);
      else {
        const key = `ask:v1:${ctx.latestSeason}:${q.toLowerCase().replace(/\s+/g, ' ')}`;
        const hit = await cache.get(key);
        if (hit) { plan = hit; cached = true; } else {
          if (!llm.configured) return res.status(503).json({ error: 'Search is not set up yet (ANTHROPIC_API_KEY missing on the server).' });
          const why = limited(who);
          if (why) return res.status(429).json({ error: why === 'daily' ? `Daily search limit reached (${PER_DAY}).` : 'Too many searches — wait a minute.' });
          const out = await llm.plan({ system: systemPrompt(ctx), tool: PLAN_TOOL, question: q });
          plan = normalizePlan(out.input);
          await cache.set(key, plan, 86400);
        }
      }
      const base = { question: q || null, plan, cached, model: llm.model };

      // Names -> ids (ask when ambiguous, never guess).
      const ids = {};
      if (plan.player) {
        const p = resolvePlayer(plan.player, await playerPool(db));
        if (p.ambiguous || p.none) return res.json({ ...base, sentence: p.none ? `I couldn't find a player called "${plan.player}".` : `Which ${plan.player}?`, clarify: p.ambiguous ? { field: 'player', options: p.ambiguous } : null, view: { type: 'clarify' }, chips: [] });
        ids.player = p;
      }
      const { rows: teams } = plan.team || plan.opponent ? await db.query('SELECT id, abbreviation, city, name, full_name FROM teams') : { rows: [] };
      for (const f of ['team', 'opponent']) {
        if (!plan[f]) continue;
        const t = resolveTeam(plan[f], teams);
        if (t.ambiguous || t.none) return res.json({ ...base, sentence: t.none ? `I couldn't find a team called "${plan[f]}".` : `Which team — ${t.ambiguous.map((x) => x.name).join(' or ')}?`, clarify: t.ambiguous ? { field: f, options: t.ambiguous } : null, view: { type: 'clarify' }, chips: [] });
        ids[f] = t;
      }

      // Run it through the same API as the screens (same auth, validation, cache).
      const port = req.socket.localPort;
      const api = async ({ method, path, body: b }) => {
        const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
          method, body: b ? JSON.stringify(b) : undefined,
          headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(req.headers['x-api-key'] ? { 'x-api-key': req.headers['x-api-key'] } : {}) },
        });
        const j = await resp.json();
        if (!resp.ok) throw Object.assign(new Error(j.error ?? `HTTP ${resp.status}`), { status: resp.status, api: true });
        return j;
      };
      const reqs = firstRequest(plan, ids, ctx);
      const results = {};
      if (reqs) {
        results.main = await api(reqs);
        if (plan.kind === 'props') {
          const dk = results.main.data.upcoming?.lines.find((l) => l.market === plan.market);
          const line = plan.line ?? dk?.line;
          if (line != null) {
            const scope = ['season', 'last5', 'last10', 'career'].includes(plan.scope) ? plan.scope : 'last10';
            const q2 = { entity: 'player', id: ids.player.id, scope, season_type: plan.season_type ?? 'regular', lines: { [plan.market]: line } };
            if (scope !== 'career') q2.season = seasonFor(plan, ctx);
            const splits = firstRequest({ ...plan, kind: 'player_stats' }, ids, ctx).body.splits;
            if (Object.keys(splits).length) q2.splits = splits;
            results.hits = await api({ method: 'POST', path: '/query', body: q2 });
          }
        }
        if (plan.kind === 'game' && !plan.season && !plan.date) {
          const has = (x) => x.data.some((g) => !ids.opponent || g.opponent === ids.opponent.abbr);
          if (!has(results.main)) {   // e.g. before opening night: look at last season
            const prev = `${Number(ctx.latestSeason.slice(0, 4)) - 1}-${ctx.latestSeason.slice(2, 4)}`;
            plan = { ...plan, season: prev };
            results.main = await api(firstRequest(plan, ids, ctx));
          }
        }
      }
      const out = summarize(plan, ids, results, ctx);
      res.json({
        ...base, plan,
        subject: { player: ids.player ?? null, team: ids.team ?? null, opponent: ids.opponent ?? null },
        sentence: out.sentence, view: out.view, chips: chips(plan, ctx), link: out.link ?? appLink(plan, ids, ctx),
        season: seasonFor(plan, ctx),
      });
    } catch (e) {
      if (e.api) return res.status(e.status >= 500 ? 502 : 422).json({ error: `That query didn't work: ${e.message}` });
      if (e.status === 502 || e.status === 503) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
  return r;
}
