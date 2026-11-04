// Weekly Highlightly schedule pass (docs/plans/M6-highlightly-weekly.md §4.2).
// UPDATE-ONLY (owner Q1): it never inserts into `games`. For games we already have it refreshes status and
// scores, and (only when NBA.com did not answer this run, Q9) the tip-off time; unmatched matches are
// reported. Fetch first, then ONE short transaction that re-reads each game FOR UPDATE and skips any game
// that changed since the pre-fetch snapshot (the live worker got there first).
import { restTags } from './rest.js';
import { addDays, etDate, statusOf, totalScore } from './map.js';
import { findGame, teamMap } from './sync.js';
import { BudgetStop } from './hl-weekly-client.js';
import { localDate } from './team-tz.js';
import { capList, clean, inTransaction, nearestFirst } from './weekly-util.js';

const MIN = 60e3, HOUR = 3600e3;
const MAX_TIP_SHIFT = 7 * 24 * HOUR;

/** Pure: is this match well-formed enough to use? Returns a reason string or null. */
export function badMatch(m, endYear) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (!Number.isInteger(m.id) || m.id <= 0) return 'bad id';
  if (m.homeTeam?.id === undefined || m.homeTeam?.id === null || m.awayTeam?.id === undefined || m.awayTeam?.id === null) return 'team id missing';
  if (typeof m.date !== 'string' || Number.isNaN(Date.parse(m.date))) return 'bad date';
  if (Number(m.season) !== endYear) return `season ${clean(m.season, 10)}`;
  return null;
}

/** Season label '2026-27' -> end year 2027. */
export const endYearOf = (season) => Number(season.slice(0, 4)) + 1;

/** Rest / back-to-back tags for the given teams, all their games of the season (load-schedule.mjs rule). */
export async function recomputeTeamRest(db, season, teamIds) {
  if (!teamIds.size) return 0;
  const { rows } = await db.query(
    `SELECT id, season_type, game_date_local AS date, home_team_id AS h, away_team_id AS a FROM games
      WHERE season = $1 AND (home_team_id = ANY($2::int[]) OR away_team_id = ANY($2::int[]))`, [season, [...teamIds]]);
  const want = new Map();
  for (const t of teamIds) {
    const mine = rows.filter((g) => g.h === t || g.a === t).map((g) => ({ gameId: g.id, date: g.date, pre: g.season_type === 'preseason' }));
    const pre = mine.filter((g) => g.pre), real = mine.filter((g) => !g.pre);
    const tags = [...restTags(real, pre.map((g) => g.date)), ...restTags(pre)];
    for (const [gid, tag] of tags) want.set(`${gid}|${t}`, tag);
  }
  const { rows: cur } = await db.query(
    `SELECT game_id, team_id, rest_days, b2b_night FROM team_games WHERE team_id = ANY($1::int[]) AND game_id = ANY($2::uuid[])`,
    [[...teamIds], rows.map((g) => g.id)]);
  const U = { g: [], t: [], r: [], b: [] };
  for (const c of cur) {
    const w = want.get(`${c.game_id}|${c.team_id}`);
    if (w && (w.rest_days !== c.rest_days || w.b2b_night !== c.b2b_night)) { U.g.push(c.game_id); U.t.push(c.team_id); U.r.push(w.rest_days); U.b.push(w.b2b_night); }
  }
  if (U.g.length) {
    await db.query(
      `UPDATE team_games tg SET rest_days = u.r, b2b_night = u.b FROM unnest($1::uuid[], $2::int[], $3::smallint[], $4::smallint[]) AS u(g, t, r, b)
        WHERE tg.game_id = u.g AND tg.team_id = u.t`, [U.g, U.t, U.r, U.b]);
  }
  return U.g.length;
}

/**
 * @param opts {season, now, daysBack, daysAhead, tipoffAuthority, dryRun, sweep:{enabled,threshold}, log, hooks:{afterFetch}}
 * @returns report (see `counts`), never the key or a URL
 */
export async function runSchedulePass(db, hl, opts) {
  const { season, now = new Date(), daysBack = 7, daysAhead = 60, tipoffAuthority = false, dryRun = false, sweep = { enabled: false, threshold: 3000 }, log = () => {}, hooks = {} } = opts;
  const endYear = endYearOf(season);
  const today = etDate(now);
  const rep = {
    counts: { dates_planned: 0, dates_done: 0, matches: 0, updated: 0, tip_changes: 0, rest_rows: 0, skipped_exhibition: 0, skipped_worker: 0, skipped_changed: 0, skipped_final: 0, needs_nba: 0, needs_review: 0, bad_matches: 0, unmatched: 0, sweep_dates: 0 },
    lists: { unmatched: [], tip_changes: [], needs_nba: [], needs_review: [], bad_matches: [], skipped_changed: [] },
    stop: null, sweep: null,
  };
  const c = rep.counts;

  // 1. pre-fetch snapshot of every game this season (the optimistic-check baseline)
  const { rows: snapRows } = await db.query(`SELECT id, status, tipoff_utc, updated_at FROM games WHERE season = $1`, [season]);
  const snap = new Map(snapRows.map((g) => [g.id, { status: g.status, tip: g.tipoff_utc ? new Date(g.tipoff_utc).getTime() : null, upd: new Date(g.updated_at).getTime() }]));

  // 2. fetch (no database writes, no transaction open)
  const dates = nearestFirst(today, daysBack, daysAhead);
  c.dates_planned = dates.length;
  const fetched = [];
  const fetchDates = async (list) => {
    for (const d of list) {
      try { fetched.push({ date: d, matches: await hl.matches(d) }); c.dates_done++; }
      catch (e) { if (e instanceof BudgetStop) { rep.stop = e.stop; return false; } throw e; }
    }
    return true;
  };
  let complete = await fetchDates(dates);

  // Q11 sweep: opt-in, and only when the LIVE header says more than the threshold remains.
  if (complete && sweep.enabled) {
    const rem = hl.stats.remaining;
    if (rem === null || rem <= sweep.threshold) {
      rep.sweep = `refused (remaining ${rem === null ? 'unknown' : rem} <= ${sweep.threshold})`;
      log(`full-season sweep refused (remaining ${rem === null ? 'unknown' : `${rem} <= ${sweep.threshold}`})`);
    } else {
      const { rows: [r] } = await db.query(`SELECT min(game_date_local)::text lo, max(game_date_local)::text hi FROM games WHERE season = $1`, [season]);
      const have = new Set(dates);
      const extra = [];
      if (r?.lo) for (let d = r.lo; d <= r.hi; d = addDays(d, 1)) if (!have.has(d)) extra.push(d);
      extra.sort((x, y) => ((x < today) !== (y < today) ? (x < today ? -1 : 1) : x < today ? (x < y ? 1 : -1) : (x < y ? -1 : 1)));  // past dates first, nearest first
      c.dates_planned += extra.length; c.sweep_dates = extra.length;
      rep.sweep = `running (${extra.length} extra dates)`;
      complete = await fetchDates(extra);
    }
  }
  if (hooks.afterFetch) await hooks.afterFetch();

  // 3. write: one short transaction
  const teams = await teamMap(db);
  const { rows: abbr } = await db.query('SELECT id, abbreviation FROM teams');
  const abbrOf = new Map(abbr.map((t) => [t.id, t.abbreviation]));
  const seen = new Set();

  await inTransaction(db, async () => {
    const rest = new Set();
    for (const { matches } of fetched) {
      for (const m of matches) {
        if (seen.has(m?.id)) continue;
        seen.add(m?.id);
        c.matches++;
        const bad = badMatch(m, endYear);
        if (bad) { c.bad_matches++; rep.lists.bad_matches.push(`${clean(m?.id, 12)}: ${bad}`); continue; }
        const label = `${clean(m.awayTeam.abbreviation, 6)}@${clean(m.homeTeam.abbreviation, 6)} ${m.date.slice(0, 10)}`;
        const h = teams.get(String(m.homeTeam.id)), a = teams.get(String(m.awayTeam.id));
        if (!h || !a) { c.skipped_exhibition++; continue; }
        const { game: found, problem } = await findGame(db, m, h, a);
        if (!found) { c.unmatched++; rep.lists.unmatched.push(`${label}: ${problem}`); continue; }
        if (!((found.home_team_id === h && found.away_team_id === a) || (found.home_team_id === a && found.away_team_id === h))) {
          c.unmatched++; rep.lists.unmatched.push(`${label}: crosswalk team mismatch`); continue;
        }
        const { rows: [g] } = await db.query(
          `SELECT id, status, tipoff_utc, game_date_local::text AS local_date, home_team_id, away_team_id, home_score, away_score, is_neutral_site, updated_at
             FROM games WHERE id = $1 FOR UPDATE`, [found.id]);
        const base = snap.get(g.id);
        if (base && (base.status !== g.status || base.upd !== new Date(g.updated_at).getTime() || base.tip !== (g.tipoff_utc ? new Date(g.tipoff_utc).getTime() : null))) {
          c.skipped_changed++; rep.lists.skipped_changed.push(label); continue;
        }
        const tipMs = g.tipoff_utc ? new Date(g.tipoff_utc).getTime() : null;
        if (g.status === 'final') { c.skipped_final++; continue; }
        const nowMs = now.getTime();
        if (g.status === 'live' || (tipMs !== null && tipMs >= nowMs - 8 * HOUR && tipMs <= nowMs + 10 * MIN)) { c.skipped_worker++; continue; }

        const swapped = g.home_team_id !== h;
        const hs = totalScore(m.state?.score?.[swapped ? 'awayTeam' : 'homeTeam']);
        const as = totalScore(m.state?.score?.[swapped ? 'homeTeam' : 'awayTeam']);
        let status = statusOf(m.state);
        if (status === 'final' && (hs === null || as === null)) status = g.status;       // no score yet: wait
        const set = { status, home_score: hs ?? g.home_score, away_score: as ?? g.away_score, tipoff_utc: g.tipoff_utc, game_date_local: g.local_date };

        const hlTip = Date.parse(m.date);
        if (tipoffAuthority && (tipMs === null || hlTip !== tipMs)) {
          if (g.is_neutral_site) { c.needs_nba++; rep.lists.needs_nba.push(`${label}: neutral-site tip-off change`); }
          else if (tipMs !== null && Math.abs(hlTip - tipMs) > MAX_TIP_SHIFT) { c.needs_review++; rep.lists.needs_review.push(`${label}: tip-off moves over 7 days`); }
          else {
            set.tipoff_utc = new Date(hlTip).toISOString();
            const ld = localDate(hlTip, abbrOf.get(g.home_team_id));
            if (ld && ld !== g.local_date) { set.game_date_local = ld; rest.add(g.home_team_id); rest.add(g.away_team_id); }
            c.tip_changes++;
            rep.lists.tip_changes.push(`${label} ${tipMs === null ? 'none' : new Date(tipMs).toISOString()} -> ${new Date(hlTip).toISOString()}`);
          }
        }
        const changed = set.status !== g.status || set.home_score !== g.home_score || set.away_score !== g.away_score
          || set.tipoff_utc !== g.tipoff_utc || set.game_date_local !== g.local_date;
        if (changed) {
          await db.query(`UPDATE games SET status = $2, home_score = $3, away_score = $4, tipoff_utc = $5, game_date_local = $6, updated_at = now() WHERE id = $1`,
            [g.id, set.status, set.home_score, set.away_score, set.tipoff_utc, set.game_date_local]);
          c.updated++;
        }
      }
    }
    c.rest_rows = await recomputeTeamRest(db, season, rest);
  }, { dryRun });

  for (const k of Object.keys(rep.lists)) rep.lists[k] = capList(rep.lists[k]);
  return rep;
}
