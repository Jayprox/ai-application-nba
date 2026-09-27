// Highlightly -> Postgres. The worker only UPDATES games that the NBA.com
// schedule loader created (db:schedule); it never invents games. It never
// overwrites rows that came from NBA.com (source = 'nba_stats') — the weekly
// reconcile from JD's Mac is the canonical copy.
import { resolvePlayers } from './players.js';
import { restTags } from './rest.js';
import { starterIds, statLine, statusOf, STAT_COLS, teamTotals, totalScore } from './map.js';

const HOUR = 3600e3;

async function teamMap(db) {
  const { rows } = await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type = 'team' AND source = 'highlightly' AND match_status = 'matched'`);
  return new Map(rows.map((r) => [String(r.source_id), Number(r.canonical_id)]));
}

/** Find our game for a Highlightly match: crosswalk first, then teams + tip-off within 8h. */
async function findGame(db, m, home, away) {
  const cols = 'g.id, g.season, g.season_type, g.status, g.home_team_id, g.away_team_id, g.home_score, g.away_score, g.box_score_checks, g.box_score_synced_at';
  const { rows: [x] } = await db.query(
    `SELECT ${cols} FROM entity_id_crosswalk c JOIN games g ON g.id::text = c.canonical_id
      WHERE c.entity_type = 'game' AND c.source = 'highlightly' AND c.source_id = $1`, [String(m.id)]);
  if (x) return { game: x };
  const { rows } = await db.query(
    `SELECT ${cols} FROM games g
      WHERE ((g.home_team_id = $1 AND g.away_team_id = $2) OR (g.home_team_id = $2 AND g.away_team_id = $1))
        AND (g.tipoff_utc BETWEEN $3::timestamptz - interval '8 hours' AND $3::timestamptz + interval '8 hours'
             OR (g.tipoff_utc IS NULL AND g.game_date_local BETWEEN ($3::timestamptz)::date - 1 AND ($3::timestamptz)::date + 1))`,
    [home, away, m.date]);
  if (rows.length !== 1) return { problem: rows.length ? 'several games match' : 'no game in our schedule' };
  await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
                  VALUES ('game', $1, 'highlightly', $2, 'teams+tipoff') ON CONFLICT DO NOTHING`, [rows[0].id, String(m.id)]);
  return { game: rows[0] };
}

/**
 * Scores/status for every NBA match on one America/New_York date, then box
 * scores for games that are final and due (first load, or the 3h re-check).
 */
export async function syncDate(db, hl, etDate, { now = new Date(), log = () => {} } = {}) {
  const report = { date: etDate, matches: 0, updated: 0, boxes: 0, player_rows: 0, created_players: [], held_players: [], unmatched: [] };
  const teams = await teamMap(db);
  for (const m of await hl.matches(etDate)) {
    report.matches++;
    const h = teams.get(String(m.homeTeam?.id)), a = teams.get(String(m.awayTeam?.id));
    if (!h || !a) { report.unmatched.push(`${m.awayTeam?.abbreviation}@${m.homeTeam?.abbreviation} (not an NBA team pair)`); continue; }
    const { game, problem } = await findGame(db, m, h, a);
    if (!game) { report.unmatched.push(`${m.awayTeam.abbreviation}@${m.homeTeam.abbreviation} ${m.date}: ${problem}`); continue; }

    const swapped = game.home_team_id !== h;               // neutral-site listings can flip home/away
    const hs = totalScore(m.state?.score?.[swapped ? 'awayTeam' : 'homeTeam']);
    const as = totalScore(m.state?.score?.[swapped ? 'homeTeam' : 'awayTeam']);
    let status = statusOf(m.state);
    if (game.status === 'final' && status !== 'final') status = 'final';      // never un-finish a game
    if (status === 'final' && (hs === null || as === null)) status = game.status; // no score yet: wait
    if (status !== game.status || hs !== game.home_score || as !== game.away_score) {
      await db.query(`UPDATE games SET status = $2, home_score = coalesce($3, home_score), away_score = coalesce($4, away_score), updated_at = now() WHERE id = $1`,
        [game.id, status, hs, as]);
      report.updated++;
      Object.assign(game, { status, home_score: hs ?? game.home_score, away_score: as ?? game.away_score });
    }
    if (status === 'final' && boxDue(game, now)) {
      const b = await loadBoxScore(db, hl, { game, match: m, teams, log });
      if (b.loaded) { report.boxes++; report.player_rows += b.rows; }
      report.created_players.push(...b.created);
      report.held_players.push(...b.held);
    }
  }
  return report;
}

/** First load when final; one re-check 3h later for stat corrections; then done. */
export const boxDue = (g, now = new Date()) =>
  g.box_score_checks === 0 || (g.box_score_checks === 1 && g.box_score_synced_at && now - new Date(g.box_score_synced_at) >= 3 * HOUR);

export async function loadBoxScore(db, hl, { game, match, teams, log = () => {} }) {
  const out = { loaded: false, rows: 0, created: [], held: [] };
  const box = await hl.boxScore(match.id);
  if (!Array.isArray(box) || box.length < 2 || !box.every((t) => t.boxScores?.length)) { log(`box score not ready for match ${match.id}`); return out; }
  const lineups = await hl.lineups(match.id).catch(() => null);
  const starters = starterIds(lineups);
  const periods = Math.max(match.state?.score?.homeTeam?.length ?? 4, 4);

  // Reconciled from NBA.com already? Then leave this game alone.
  const { rows: [nba] } = await db.query(`SELECT count(*)::int n FROM player_game_stats WHERE game_id = $1 AND source = 'nba_stats'`, [game.id]);
  if (nba.n > 0) {
    await db.query('UPDATE games SET box_score_checks = 2, box_score_synced_at = now() WHERE id = $1', [game.id]);
    return out;
  }

  const sides = [];
  for (const t of box) {
    const teamId = teams.get(String(t.team.id));
    if (teamId !== game.home_team_id && teamId !== game.away_team_id) { log(`box team ${t.team.name} isn't in game ${game.id}`); return out; }
    const entries = t.boxScores.map((b) => ({ hlId: String(b.player.id), name: b.player.name, line: statLine(b) }));
    const who = await resolvePlayers(db, { teamId, season: game.season, entries });
    sides.push({ teamId, entries, who });
  }

  await db.query('BEGIN');
  try {
    const touched = [];
    for (const { teamId, entries, who } of sides) {
      for (const e of entries) {
        const r = who.get(e.hlId);
        if (r.status !== 'matched') { out.held.push(`${e.name} (${r.reason})`); continue; }
        if (r.created) out.created.push(e.name);
        const s = e.line.stats;
        await db.query(
          `INSERT INTO player_game_stats (game_id, player_id, team_id, started, dnp, ${STAT_COLS.join(', ')}, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, ${STAT_COLS.map((_, i) => `$${i + 6}`).join(', ')}, 'highlightly', now())
           ON CONFLICT (game_id, player_id) DO UPDATE SET team_id = EXCLUDED.team_id, started = EXCLUDED.started, dnp = EXCLUDED.dnp,
             ${STAT_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()
           WHERE player_game_stats.source = 'highlightly'`,
          [game.id, r.playerId, teamId, starters.size ? starters.has(e.hlId) : null, e.line.dnp, ...STAT_COLS.map((c) => s[c])]);
        out.rows++;
        if (!e.line.dnp) touched.push(r.playerId);
      }
      const tot = teamTotals(entries.map((e) => e.line), periods);
      const mine = teamId === game.home_team_id ? game.home_score : game.away_score;
      const theirs = teamId === game.home_team_id ? game.away_score : game.home_score;
      const cols = Object.keys(tot).filter((c) => c !== 'pts');
      await db.query(
        `UPDATE team_games SET won = $3, pts = $4, plus_minus = $5, ${cols.map((c, i) => `${c} = $${i + 6}`).join(', ')}
          WHERE game_id = $1 AND team_id = $2`,
        [game.id, teamId, mine > theirs, mine, mine - theirs, ...cols.map((c) => tot[c])]);
    }
    await db.query('UPDATE games SET box_score_synced_at = now(), box_score_checks = least(box_score_checks + 1, 2) WHERE id = $1', [game.id]);
    await db.query('COMMIT');
    out.loaded = true;
    await recomputePlayerRest(db, game.season, touched);
  } catch (e) {
    await db.query('ROLLBACK');
    throw new Error(`box score for match ${match.id} (game ${game.id}): ${e.message}`);
  }
  return out;
}

/**
 * The player's OWN rest (NBA.com's definition, architecture §6.1): from the
 * games he played this season; his preseason games count as played but get
 * their own tags. Recomputed for the whole season because a new game also
 * changes the previous game's "night 1 of a back-to-back".
 */
export async function recomputePlayerRest(db, season, playerIds) {
  if (!playerIds.length) return 0;
  const { rows } = await db.query(
    `SELECT s.player_id, s.game_id, g.game_date_local AS date, g.season_type = 'preseason' AS pre
       FROM player_game_stats s JOIN games g ON g.id = s.game_id
      WHERE g.season = $1 AND s.player_id = ANY($2::uuid[]) AND NOT s.dnp`, [season, [...new Set(playerIds)]]);
  const by = new Map();
  for (const r of rows) (by.get(r.player_id) ?? by.set(r.player_id, []).get(r.player_id)).push(r);
  const U = { p: [], g: [], r: [], b: [] };
  for (const [pid, list] of by) {
    const real = list.filter((x) => !x.pre).map((x) => ({ gameId: x.game_id, date: x.date }));
    const pre = list.filter((x) => x.pre).map((x) => ({ gameId: x.game_id, date: x.date }));
    for (const [gid, t] of [...restTags(real, pre.map((x) => x.date)), ...restTags(pre)]) {
      U.p.push(pid); U.g.push(gid); U.r.push(t.rest_days); U.b.push(t.b2b_night);
    }
  }
  const r = await db.query(
    `UPDATE player_game_stats s SET player_rest_days = u.r, player_b2b_night = u.b
       FROM unnest($1::uuid[], $2::uuid[], $3::smallint[], $4::smallint[]) AS u(p, g, r, b)
      WHERE s.player_id = u.p AND s.game_id = u.g`, [U.p, U.g, U.r, U.b]);
  return r.rowCount;
}
