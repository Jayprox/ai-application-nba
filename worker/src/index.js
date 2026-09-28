// Chalk That NBA ingestion worker (Railway service `ingestion-worker`, no
// public domain). Loop: every minute ask the planner what's due, run it, log
// the run to ingestion_runs. Manual one-off: `npm run sync -- --date 2026-04-12`.
// Player props (The Odds API, DraftKings) run in the same loop when
// ODDS_API_KEY is set: opening line the morning of a game, closing line in the
// last 35 minutes before tip (planner.planProps).
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';
import { createHighlightly } from './highlightly.js';
import { plan, planProps } from './planner.js';
import { createOdds } from './odds.js';
import { syncProps } from './props.js';
import { etDate } from './map.js';
import { syncDate } from './sync.js';

const log = (...a) => console.log(new Date().toISOString(), '[worker]', ...a);

/** Run syncDate for each date and record ONE ingestion_runs row. */
export async function runDates(db, hl, dates, { triggeredBy = 'schedule', reason = '' } = {}) {
  const { rows: [run] } = await db.query(
    `INSERT INTO ingestion_runs (job_type, source, triggered_by, details) VALUES ('sync_scores_box', 'highlightly', $1, $2) RETURNING id`,
    [triggeredBy, { dates, reason }]);
  const before = hl.calls.n;
  const reports = [];
  try {
    for (const d of dates) reports.push(await syncDate(db, hl, d, { log }));
    const rows = reports.reduce((s, r) => s + r.updated + r.player_rows, 0);
    const details = { dates, reason, reports, requests: hl.calls.n - before, quota: hl.quota };
    await db.query(`UPDATE ingestion_runs SET status = 'success', finished_at = now(), records_written = $2, details = $3 WHERE id = $1`, [run.id, rows, details]);
    for (const r of reports) {
      log(`${r.date}: ${r.matches} matches, ${r.updated} updated, ${r.boxes} box scores (${r.player_rows} player rows)` +
        (r.created_players.length ? ` · new players: ${r.created_players.join(', ')}` : '') +
        (r.held_players.length ? ` · HELD for review: ${r.held_players.join('; ')}` : '') +
        (r.unmatched.length ? ` · unmatched: ${r.unmatched.join('; ')}` : ''));
    }
    if (hl.quota.remaining !== null) log(`quota: ${hl.quota.remaining} of ${hl.quota.limit} left`);
    return reports;
  } catch (e) {
    await db.query(`UPDATE ingestion_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, String(e.message).slice(0, 2000)]);
    throw e;
  }
}

/** Pull prop snapshots and record ONE ingestion_runs row (source odds_api). */
export async function runProps(db, odds, p, { triggeredBy = 'schedule' } = {}) {
  const { rows: [run] } = await db.query(
    `INSERT INTO ingestion_runs (job_type, source, triggered_by, details) VALUES ('sync_props', 'odds_api', $1, $2) RETURNING id`,
    [triggeredBy, { open: p.open, close: p.close, reason: p.reason }]);
  try {
    const reports = [...await syncProps(db, odds, p.open, 'open'), ...await syncProps(db, odds, p.close, 'close')];
    const lines = reports.reduce((s, r) => s + r.lines, 0);
    await db.query(`UPDATE ingestion_runs SET status = 'success', finished_at = now(), records_written = $2, details = $3 WHERE id = $1`,
      [run.id, lines, { reason: p.reason, reports, quota: odds.quota }]);
    for (const r of reports) {
      log(`props ${r.snapshot} ${r.game}: ${r.problem ?? `${r.lines} lines for ${r.players} players, ${r.credits} credits`}` +
        (r.held.length ? ` · HELD for review: ${r.held.join('; ')}` : ''));
    }
    if (odds.quota.remaining !== null) log(`Odds API credits left: ${odds.quota.remaining}`);
    return reports;
  } catch (e) {
    await db.query(`UPDATE ingestion_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, String(e.message).slice(0, 2000)]);
    throw e;
  }
}

async function gamesAround(db, season, now) {
  const { rows } = await db.query(
    `SELECT id, tipoff_utc, status, season_type, box_score_checks, box_score_synced_at, props_open_at, props_close_at FROM games
      WHERE season = $1 AND (status = 'live' OR tipoff_utc BETWEEN $2::timestamptz - interval '4 days' AND $2::timestamptz + interval '1 day')`,
    [season, now]);
  return rows;
}

export async function loop({ db, hl, odds, season, tickMs = 60e3 }) {
  const state = { lastPollAt: null, lastDailyEt: null, quotaRemaining: null };
  const propState = { openTries: new Map(), quotaRemaining: null };
  let busy = false, stopping = false;
  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const now = new Date();
      const games = await gamesAround(db, season, now);
      const p = plan(now, games, state);
      if (p.dates.length) {
        try {
          await runDates(db, hl, p.dates, { reason: p.reason });
          state.lastPollAt = now.getTime();
          if (p.daily) state.lastDailyEt = etDate(now);
          state.quotaRemaining = hl.quota.remaining;
        } catch (e) { log('scores run failed:', e.message); }   // retried next tick; props still run
      }
      if (odds?.configured) {
        const pp = planProps(now, games, propState);
        if (pp.open.length || pp.close.length) {
          for (const id of pp.open) propState.openTries.set(id, now.getTime());
          try { await runProps(db, odds, pp); } finally { propState.quotaRemaining = odds.quota.remaining; }
        }
      }
    } catch (e) {
      log('run failed:', e.message);       // keep looping; the next tick retries
    } finally { busy = false; }
  };
  const timer = setInterval(tick, tickMs);
  await tick();
  const stop = async (sig) => { stopping = true; clearInterval(timer); log(`${sig}: stopping`); while (busy) await new Promise((r) => setTimeout(r, 200)); await db.end(); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const season = process.env.CURRENT_SEASON ?? '2026-27';
  const odds = createOdds();
  log(`starting — season ${season}, checking every minute for due work · props ${odds.configured ? 'on (DraftKings)' : 'off (ODDS_API_KEY not set)'}`);
  await loop({ db: createPool(), hl: createHighlightly(), odds, season });
}
