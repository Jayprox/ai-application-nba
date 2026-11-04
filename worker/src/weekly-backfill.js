// Weekly Highlightly box-score catch-up (docs/plans/M6-highlightly-weekly.md §4.3).
// Final games from the last N days that have no box score yet (box_score_checks < 2, no NBA.com rows).
// Fetch first (matches per date, then box score + lineups per game), then ONE short transaction that
// re-reads each game FOR UPDATE, compares it with the pre-fetch snapshot, resolves players and runs the
// SAME SQL as the live worker (sync.js writeSides). A cap / reserve stop writes only complete games.
import { etDate } from './map.js';
import { BudgetStop, HighlightlyAuthError } from './hl-weekly-client.js';
import { boxReady, recomputePlayerRest, resolveSides, teamMap, writeSides } from './sync.js';
import { starterIds } from './map.js';
import { capList, clean, inTransaction } from './weekly-util.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const COLS = `g.id, g.season, g.status, g.home_team_id, g.away_team_id, g.home_score, g.away_score, g.box_score_checks, g.box_score_synced_at, g.tipoff_utc`;

async function candidates(db, season, lo, hi) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM games g
      WHERE g.season = $1 AND g.status = 'final' AND g.box_score_checks < 2 AND g.tipoff_utc IS NOT NULL
        AND g.tipoff_utc <= $3::timestamptz AND ($2::timestamptz IS NULL OR g.tipoff_utc >= $2::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM player_game_stats s WHERE s.game_id = g.id AND s.source = 'nba_stats')
      ORDER BY g.tipoff_utc`, [season, lo, hi]);
  return rows;
}

/**
 * @param opts {season, now, daysBack, dryRun, sweep:{enabled,threshold}, log, hooks:{afterFetch}}
 */
export async function runBackfillPass(db, hl, opts) {
  const { season, now = new Date(), daysBack = 7, dryRun = false, sweep = { enabled: false, threshold: 3000 }, log = () => {}, hooks = {} } = opts;
  const rep = {
    counts: { candidates: 0, games_loaded: 0, rows: 0, not_ready: 0, no_match: 0, skipped_changed: 0, skipped_nba: 0, errored: 0, created: 0, autolinked: 0, held: 0 },
    lists: { held: [], created: [], autolinked: [], no_match: [], errored: [] },
    stop: null, sweep: null, warnings: [],
  };
  const c = rep.counts;
  const hi = new Date(now.getTime() - 8 * HOUR).toISOString();
  const lo = new Date(now.getTime() - daysBack * DAY).toISOString();

  const teams = await teamMap(db);
  const toHl = new Map([...teams].map(([hlId, id]) => [id, hlId]));
  const ready = [];       // fetched, complete: { game, snapshot, match, box, starters, periods }

  async function fetchGames(games) {
    const { rows: xw } = await db.query(
      `SELECT canonical_id, source_id FROM entity_id_crosswalk WHERE entity_type = 'game' AND source = 'highlightly' AND canonical_id = ANY($1::text[])`, [games.map((g) => g.id)]);
    const known = new Map(xw.map((x) => [x.canonical_id, x.source_id]));
    const byDate = new Map();
    for (const g of games) { const d = etDate(new Date(g.tipoff_utc)); (byDate.get(d) ?? byDate.set(d, []).get(d)).push(g); }
    for (const date of [...byDate.keys()].sort()) {
      let list;
      try { list = await hl.matches(date); } catch (e) { if (e instanceof BudgetStop) { rep.stop = e.stop; return false; } throw e; }
      for (const g of byDate.get(date)) {
        const label = `${date} ${g.id.slice(0, 8)}`;
        const tip = new Date(g.tipoff_utc).getTime();
        const m = list.find((x) => String(x?.id) === known.get(g.id))
          ?? list.find((x) => teams.get(String(x?.homeTeam?.id)) !== undefined && Number.isInteger(x?.id) && x.id > 0
            && new Set([teams.get(String(x.homeTeam.id)), teams.get(String(x.awayTeam?.id))]).size === 2
            && [teams.get(String(x.homeTeam.id)), teams.get(String(x.awayTeam?.id))].every((t) => t === g.home_team_id || t === g.away_team_id)
            && Math.abs(Date.parse(x.date) - tip) <= 8 * HOUR);
        if (!m || !Number.isInteger(m.id) || m.id <= 0) { c.no_match++; rep.lists.no_match.push(label); continue; }
        try {
          const box = await hl.boxScore(m.id);
          if (!boxReady(box)) { c.not_ready++; continue; }
          let lineups = null;
          try { lineups = await hl.lineups(m.id); } catch (e) { if (e instanceof BudgetStop || e instanceof HighlightlyAuthError) throw e; }
          ready.push({ game: g, snapshot: { checks: g.box_score_checks, synced: g.box_score_synced_at ? new Date(g.box_score_synced_at).getTime() : null },
            match: m, box, starters: starterIds(lineups), periods: Math.max(m.state?.score?.homeTeam?.length ?? 4, 4) });
        } catch (e) { if (e instanceof BudgetStop) { rep.stop = e.stop; return false; } throw e; }
      }
    }
    return true;
  }

  // 1-2. candidates + fetch (no transaction open)
  const windowGames = await candidates(db, season, lo, hi);
  c.candidates = windowGames.length;
  let complete = await fetchGames(windowGames);

  if (complete && sweep.enabled) {
    const rem = hl.stats.remaining;
    if (rem === null || rem <= sweep.threshold) {
      rep.sweep = `refused (remaining ${rem === null ? 'unknown' : rem} <= ${sweep.threshold})`;
      log(`full-season sweep refused (remaining ${rem === null ? 'unknown' : `${rem} <= ${sweep.threshold}`})`);
    } else {
      const older = await candidates(db, season, null, lo);
      c.candidates += older.length;
      rep.sweep = `running (${older.length} older games)`;
      complete = await fetchGames(older);
    }
  }
  if (hooks.afterFetch) await hooks.afterFetch();

  // 3. write: one short transaction, one savepoint per game
  let touched = [];
  await inTransaction(db, async () => {
    touched = [];
    Object.assign(c, { games_loaded: 0, rows: 0, skipped_changed: 0, skipped_nba: 0, errored: 0, created: 0, autolinked: 0, held: 0 });
    for (const k of ['held', 'created', 'autolinked', 'errored']) rep.lists[k] = [];
    for (const r of ready) {
      const { rows: [g] } = await db.query(
        `SELECT id, season, status, home_team_id, away_team_id, home_score, away_score, box_score_checks, box_score_synced_at FROM games WHERE id = $1 FOR UPDATE`, [r.game.id]);
      if (g.status !== 'final' || g.box_score_checks !== r.snapshot.checks || (g.box_score_synced_at ? new Date(g.box_score_synced_at).getTime() : null) !== r.snapshot.synced) { c.skipped_changed++; continue; }
      const { rows: [nba] } = await db.query(`SELECT count(*)::int n FROM player_game_stats WHERE game_id = $1 AND source = 'nba_stats'`, [g.id]);
      if (nba.n > 0) { c.skipped_nba++; continue; }
      await db.query('SAVEPOINT g');
      try {
        const resolved = await resolveSides(db, { box: r.box, game: g, teams });
        if (resolved.problem) { await db.query('ROLLBACK TO SAVEPOINT g'); c.errored++; rep.lists.errored.push(`${g.id.slice(0, 8)}: ${clean(resolved.problem)}`); continue; }
        const out = { rows: 0, created: [], autolinked: [], held: [] };
        touched.push(...await writeSides(db, { game: g, sides: resolved.sides, starters: r.starters, periods: r.periods, out }));
        await db.query('RELEASE SAVEPOINT g');
        c.games_loaded++; c.rows += out.rows;
        c.created += out.created.length; c.autolinked += out.autolinked.length; c.held += out.held.length;
        rep.lists.created.push(...out.created.map((n) => clean(n))); rep.lists.autolinked.push(...out.autolinked.map((n) => clean(n)));
        rep.lists.held.push(...out.held.map((n) => clean(n, 120)));
      } catch (e) {
        if (e?.code === '55P03') throw e;
        await db.query('ROLLBACK TO SAVEPOINT g');
        c.errored++; rep.lists.errored.push(`${g.id.slice(0, 8)}: database error (${/^[0-9A-Z]{5}$/.test(e?.code ?? '') ? e.code : 'unknown'})`);
      }
    }
  }, { dryRun });
  // The player's own rest, after COMMIT, in its own statement (same order as the live worker).
  if (!dryRun && touched.length) await recomputePlayerRest(db, season, touched);
  if (c.errored) rep.warnings.push(`${c.errored} game(s) could not be written`);
  for (const k of Object.keys(rep.lists)) rep.lists[k] = capList(rep.lists[k]);
  return rep;
}
