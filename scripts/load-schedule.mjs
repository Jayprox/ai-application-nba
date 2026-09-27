// Load an upcoming season's schedule (default 2026-27): games + per-team
// split tags known in advance (venue incl. neutral sites, rest days,
// back-to-back night, national-TV tier, NBA Cup stage, arena/altitude).
//
//   npm run db:schedule                       # 2026-27
//   npm run db:schedule -- --season 2026-27
//
// Runs from JD's Mac (NBA.com blocks Railway IPs). Safe to re-run any time the
// NBA changes the schedule: one transaction, upserts keyed via the crosswalk,
// and it NEVER overwrites a game's status/score once the ingestion worker has
// marked it live/final. Rest/b2b tags are recomputed on every run, because a
// newly added game (e.g. post-Cup games) changes its neighbours' tags.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { publicDbUrl } from './lib/env.mjs';
import { nbaScheduleSeason } from './lib/sources.mjs';
import { upsertArena } from './lib/arenas.mjs';
import { isNeutralSite, nationalTvTier, nationalBroadcasterList, cupStage, localGameDate, restTags } from './lib/tagging.mjs';

const log = (...a) => console.log('[schedule]', ...a);
const argSeason = process.argv.indexOf('--season');
const season = argSeason > 0 ? process.argv[argSeason + 1] : '2026-27';
if (!/^\d{4}-\d{2}$/.test(season)) { console.error(`bad --season ${season}`); process.exit(1); }

const TYPE = { '001': 'preseason', '002': 'regular', '006': 'cup_final' }; // playoffs/play-in come later in the season
const STATUS = { 1: 'scheduled', 2: 'live', 3: 'final' };

const { url, host, ssl } = publicDbUrl();
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[schedule] cannot reach the database at ${host}: ${e.message}`); process.exit(1); }
log(`connected: ${host} — season ${season}`);
const { rows: [run] } = await db.query(`INSERT INTO ingestion_runs (job_type, source, triggered_by, details) VALUES ('load_schedule', 'nba_stats', 'manual', $1) RETURNING id`, [{ season }]);

try {
  const all = (await nbaScheduleSeason(season)).leagueSchedule.gameDates.flatMap((d) => d.games);
  const team = new Map((await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type='team' AND source='nba_stats'`)).rows.map((r) => [r.source_id, Number(r.canonical_id)]));
  if (team.size !== 30) throw new Error(`expected 30 seeded teams, found ${team.size} — run npm run db:seed first`);

  const placeholders = [], skipped = [], exhibitions = [];
  const games = [];
  for (const g of all) {
    const type = TYPE[g.gameId.slice(0, 3)];
    if (!type) { skipped.push(g.gameId); continue; } // All-Star etc.
    if (!g.homeTeam?.teamId || !g.awayTeam?.teamId) { placeholders.push(`${g.gameDateEst.slice(0, 10)} ${g.gameSubLabel || g.gameLabel || g.gameId}`); continue; }
    const home = team.get(String(g.homeTeam.teamId)), away = team.get(String(g.awayTeam.teamId));
    if (!home || !away) {
      // Preseason exhibitions vs. non-NBA clubs (e.g. 2026-10-12 London @ POR) aren't
      // NBA games we model; anywhere else an unknown team is a real problem.
      if (type === 'preseason') { exhibitions.push(`${g.gameDateEst.slice(0, 10)} ${g.awayTeam.teamTricode}@${g.homeTeam.teamTricode}`); continue; }
      throw new Error(`game ${g.gameId}: unknown team id ${!home ? g.homeTeam.teamId : g.awayTeam.teamId}`);
    }
    const date = localGameDate(g, g.gameDateEst.slice(0, 10));
    games.push({ g, type, home, away, date, neutral: isNeutralSite(g, season, date) });
  }

  await db.query('BEGIN');
  const arenaCache = new Map();
  for (const x of games) x.arenaId = await upsertArena(db, x.g, x.neutral, arenaCache, log);

  const { rows: known } = await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type='game' AND source='nba_stats' AND source_id = ANY($1::text[])`, [games.map((x) => x.g.gameId)]);
  const uuid = new Map(known.map((k) => [k.source_id, k.canonical_id]));
  const fresh = [];
  for (const x of games) { if (!uuid.has(x.g.gameId)) { const u = randomUUID(); uuid.set(x.g.gameId, u); fresh.push([u, x.g.gameId]); } x.id = uuid.get(x.g.gameId); }

  const tbd = (g) => /tbd/i.test(g.gameStatusText ?? '') || !g.gameDateTimeUTC || g.gameDateTimeUTC.startsWith('0001');
  const col = (f) => games.map(f);
  const r = await db.query(
    `INSERT INTO games (id, season, season_type, cup_stage, game_date_local, tipoff_utc, home_team_id, away_team_id, arena_id,
       is_neutral_site, national_tv_tier, national_broadcasters, status, updated_at)
     SELECT id, $13, type, cup, d, tip, home, away, arena, neutral, tier, ARRAY(SELECT jsonb_array_elements_text(nets::jsonb)), st, now()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::date[], $5::timestamptz[], $6::int[], $7::int[], $8::int[], $9::bool[], $10::text[], $11::text[], $12::text[])
         AS t(id, type, cup, d, tip, home, away, arena, neutral, tier, nets, st)
     ON CONFLICT (id) DO UPDATE SET season_type = EXCLUDED.season_type, cup_stage = EXCLUDED.cup_stage,
       game_date_local = EXCLUDED.game_date_local, tipoff_utc = EXCLUDED.tipoff_utc, home_team_id = EXCLUDED.home_team_id,
       away_team_id = EXCLUDED.away_team_id, arena_id = EXCLUDED.arena_id, is_neutral_site = EXCLUDED.is_neutral_site,
       national_tv_tier = EXCLUDED.national_tv_tier, national_broadcasters = EXCLUDED.national_broadcasters,
       status = CASE WHEN games.status IN ('live', 'final') THEN games.status ELSE EXCLUDED.status END, updated_at = now()`,
    [col((x) => x.id), col((x) => x.type), col((x) => cupStage(x.g, x.g.gameId)), col((x) => x.date), col((x) => (tbd(x.g) ? null : x.g.gameDateTimeUTC)),
     col((x) => x.home), col((x) => x.away), col((x) => x.arenaId), col((x) => x.neutral), col((x) => nationalTvTier(x.g.broadcasters)),
     col((x) => JSON.stringify(nationalBroadcasterList(x.g.broadcasters))), col((x) => (x.g.postponedStatus === 'Y' ? 'postponed' : STATUS[x.g.gameStatus] ?? 'scheduled')), season]);
  if (fresh.length) await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
    SELECT 'game', c, 'nba_stats', s, 'exact_id' FROM unnest($1::text[], $2::text[]) AS t(c, s) ON CONFLICT DO NOTHING`, [fresh.map((f) => f[0]), fresh.map((f) => f[1])]);

  // Rest/b2b per team. Real games count preseason games as "played" (the
  // opener's rest runs from the last preseason game, as on NBA.com and in the
  // backfill); preseason games are tagged among themselves only.
  const tags = new Map();
  const preDates = new Map();
  for (const x of games.filter((y) => y.type === 'preseason'))
    for (const t of [x.home, x.away]) (preDates.get(t) ?? preDates.set(t, []).get(t)).push(x.date);
  for (const phase of ['preseason', 'real']) {
    const byTeam = new Map();
    for (const x of games.filter((y) => (y.type === 'preseason') === (phase === 'preseason')))
      for (const t of [x.home, x.away]) (byTeam.get(t) ?? byTeam.set(t, []).get(t)).push({ gameId: x.id, date: x.date });
    for (const [t, list] of byTeam) for (const [gid, tag] of restTags(list, phase === 'real' ? preDates.get(t) : [])) tags.set(`${t}|${gid}`, tag);
  }
  const TG = { g: [], t: [], o: [], v: [], r: [], b: [] };
  for (const x of games) for (const [t, o, home] of [[x.home, x.away, true], [x.away, x.home, false]]) {
    const tag = tags.get(`${t}|${x.id}`);
    TG.g.push(x.id); TG.t.push(t); TG.o.push(o); TG.v.push(x.neutral ? 'neutral' : home ? 'home' : 'away'); TG.r.push(tag.rest_days); TG.b.push(tag.b2b_night);
  }
  await db.query(
    `INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split, rest_days, b2b_night)
     SELECT * FROM unnest($1::uuid[], $2::int[], $3::int[], $4::text[], $5::smallint[], $6::smallint[])
     ON CONFLICT (game_id, team_id) DO UPDATE SET opponent_team_id = EXCLUDED.opponent_team_id, venue_split = EXCLUDED.venue_split,
       rest_days = EXCLUDED.rest_days, b2b_night = EXCLUDED.b2b_night`,
    [TG.g, TG.t, TG.o, TG.v, TG.r, TG.b]);

  // Checks: every team has the same number of known regular-season games.
  const { rows: per } = await db.query(
    `SELECT t.abbreviation, count(*)::int n FROM team_games tg JOIN games g ON g.id = tg.game_id JOIN teams t ON t.id = tg.team_id
      WHERE g.season = $1 AND g.season_type = 'regular' GROUP BY 1 ORDER BY 2, 1`, [season]);
  const counts = [...new Set(per.map((p) => p.n))];
  if (per.length !== 30) throw new Error(`only ${per.length} teams have regular-season games`);
  if (counts.length > 1) log(`WARN uneven regular-season counts: ${per.filter((p) => p.n !== per.at(-1).n).map((p) => `${p.abbreviation} ${p.n}`).join(', ')} (vs ${per.at(-1).n}) — normal only while the NBA is adding post-Cup games`);
  await db.query('COMMIT');

  const byType = {}; for (const x of games) byType[x.type] = (byType[x.type] ?? 0) + 1;
  const tiers = {}; for (const x of games.filter((y) => y.type !== 'preseason')) { const t = nationalTvTier(x.g.broadcasters); tiers[t] = (tiers[t] ?? 0) + 1; }
  const neutral = games.filter((x) => x.neutral).map((x) => `${x.date} ${x.g.awayTeam.teamTricode}@${x.g.homeTeam.teamTricode} ${x.g.arenaCity}`);
  const b2b = TG.b.filter((b) => b === 2).length;
  await db.query(`UPDATE ingestion_runs SET status='success', finished_at=now(), records_written=$2, details=$3 WHERE id=$1`,
    [run.id, games.length + TG.g.length, { season, byType, tiers, placeholders, exhibitions, neutral, newGames: fresh.length, b2bSecondNights: b2b }]);
  log(`✓ ${games.length} games ${JSON.stringify(byType)} · ${fresh.length} new · regular-season TV ${JSON.stringify(tiers)}`);
  log(`  every team: ${counts.join('/')} known regular-season games · ${b2b} second-night-of-back-to-back team-games`);
  if (exhibitions.length) log(`  skipped ${exhibitions.length} preseason exhibition(s) vs non-NBA clubs: ${exhibitions.join(' | ')}`);
  if (placeholders.length) log(`  skipped ${placeholders.length} placeholder(s) with no teams yet: ${placeholders.join(' | ')}`);
  log(`  neutral (${neutral.length}): ${neutral.join(' | ')}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  await db.query(`UPDATE ingestion_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [run.id, e.message]).catch(() => {});
  console.error('[schedule] FAILED — nothing was written.\n' + e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
