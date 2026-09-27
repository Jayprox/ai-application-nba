// Historical backfill: every game, team box score, player box score, split
// tag and playoff/play-in series from 2003-04 through 2025-26 (§5, §7.2).
//
//   npm run db:backfill                         # all seasons
//   npm run db:backfill -- --season 2025-26     # one season (repeatable)
//   npm run db:backfill -- --from 2019-20 --to 2021-22
//
// Runs from JD's Mac (NBA.com blocks Railway IPs). One transaction PER
// SEASON: a season either loads completely and passes its checks, or leaves
// nothing behind. Re-runnable: every write is an upsert keyed on NBA.com ids
// via entity_id_crosswalk. Each season is logged to ingestion_runs.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { loadEnv, publicDbUrl } from './lib/env.mjs';
import { rows, nbaStandings, nbaScheduleSeason, nbaGameLog, geocode } from './lib/sources.mjs';
import { seasonTypeFromGameId, isNeutralSite, nationalTvTier, nationalBroadcasterList, cupStage, localGameDate, restTags, buildSeries } from './lib/tagging.mjs';

const FIRST = 2003, LAST = 2025;               // 2003-04 .. 2025-26
const HIGH_ALTITUDE_FT = 4000;
const label = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const log = (...a) => console.log('[backfill]', ...a);

// ---------------------------------------------------------------- args ----
function seasonsFromArgs(argv) {
  const all = []; for (let y = FIRST; y <= LAST; y++) all.push(label(y));
  const picked = []; let from, to;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--season') picked.push(argv[++i]);
    else if (argv[i] === '--from') from = argv[++i];
    else if (argv[i] === '--to') to = argv[++i];
  }
  let out = picked.length ? picked : all.filter((s) => (!from || s >= from) && (!to || s <= to));
  for (const s of out) if (!all.includes(s)) throw new Error(`season ${s} is outside ${label(FIRST)}..${label(LAST)}`);
  return out;
}

// --------------------------------------------------------------- fetch ----
async function fetchSeason(season) {
  const y = Number(season.slice(0, 4));
  const types = ['Regular Season', 'Playoffs', ...(y >= 2019 ? ['PlayIn'] : []), ...(y >= 2023 ? ['IST'] : [])];
  const sched = (await nbaScheduleSeason(season)).leagueSchedule.gameDates.flatMap((d) => d.games);
  const standings = rows(await nbaStandings(season));
  const team = [], player = [];
  for (const t of types) {
    // IST (NBA Cup) logs repeat the group/knockout games that are already in
    // Regular Season; only the 006 final is new.
    const keep = (r) => (t === 'IST' ? String(r.GAME_ID).startsWith('006') : true);
    team.push(...rows(await nbaGameLog(season, t, 'T')).filter(keep));
    player.push(...rows(await nbaGameLog(season, t, 'P')).filter(keep));
  }
  return { sched: new Map(sched.map((g) => [g.gameId, g])), standings, team, player };
}

// ------------------------------------------------------------- helpers ----
async function upsertChunks(db, sqlFn, cols, size = 4000) {
  const n = cols[0].length; let written = 0;
  for (let i = 0; i < n; i += size) {
    const r = await db.query(sqlFn(), cols.map((c) => c.slice(i, i + size)));
    written += r.rowCount;
  }
  return written;
}
const STAT_COLS = ['pts', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf', 'plus_minus'];
const statOf = (r, c) => (r[c.toUpperCase()] ?? null);

const elevationCache = new Map();
async function arenaElevation(db, city, state) {
  const key = `${city}|${state}`;
  if (elevationCache.has(key)) return elevationCache.get(key);
  // Reuse any arena already stored for this city (arenas get renamed; the city doesn't move).
  const { rows: known } = await db.query('SELECT elevation_ft FROM arenas WHERE city = $1 AND coalesce(state, \'\') = $2 AND elevation_ft IS NOT NULL LIMIT 1', [city, state]);
  let ft = known[0]?.elevation_ft ?? null;
  if (ft == null) {
    const cc = /^(ON|BC|QC|AB|MB)$/.test(state) ? 'CA' : state.length === 2 && !/^(MX|FR|UK|GB|DE|JP|CN)$/.test(state) ? 'US' : undefined;
    const res = ((await geocode(city, cc))?.results ?? []).sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    ft = res[0]?.elevation != null ? Math.round(res[0].elevation * 3.28084) : null;
    if (ft == null) log(`  WARN no elevation for ${city}${state ? ', ' + state : ''} — stored as NULL`);
  }
  elevationCache.set(key, ft);
  return ft;
}

// ---------------------------------------------------------- one season ----
async function loadSeason(db, season, maps, data) {
  const { sched, standings, team, player } = data;
  const counts = { games: 0, team_rows: 0, player_rows: 0, players_created: 0, series: 0, arenas: 0 };
  const teamId = (nba) => { const t = maps.team.get(String(nba)); if (!t) throw new Error(`unknown NBA.com team id ${nba}`); return t; };

  // ---- games (existence = present in the team logs; the schedule only adds metadata)
  const games = new Map();
  for (const r of team) {
    const id = String(r.GAME_ID);
    const type = seasonTypeFromGameId(id);
    if (!type) continue;
    const g = games.get(id) ?? { id, type, sides: [] };
    g.sides.push(r);
    games.set(id, g);
  }
  // A played game has exactly one winner. NBA.com's logs keep games that were
  // scheduled but never played (e.g. BOS-IND 2013-04-16, cancelled after the
  // Boston Marathon bombing: WL null for both, 0 points) — skip and report them.
  const notPlayed = [];
  for (const [id, g] of games) {
    const wins = g.sides.filter((s) => s.WL === 'W').length;
    if (wins === 0) { notPlayed.push(`${String(g.sides[0].GAME_DATE).slice(0, 10)} ${g.sides.map((s) => s.TEAM_ABBREVIATION).join('-')}`); games.delete(id); }
    else if (wins !== 1) throw new Error(`game ${id}: ${wins} winners`);
  }
  for (const g of games.values()) {
    if (g.sides.length !== 2) throw new Error(`game ${g.id}: expected 2 team rows, got ${g.sides.length}`);
    const home = g.sides.find((s) => String(s.MATCHUP).includes('vs.')) ?? g.sides[0];
    const away = g.sides.find((s) => s !== home);
    const s = sched.get(g.id) ?? {};
    g.home = home; g.away = away; g.sched = s;
    g.date = localGameDate(s, String(home.GAME_DATE).slice(0, 10));
    g.neutral = isNeutralSite(s, season, g.date);
  }

  // ---- arenas
  const arenaIds = new Map();
  for (const g of games.values()) {
    const name = (g.sched.arenaName ?? '').trim(), city = (g.sched.arenaCity ?? '').trim();
    if (!name || name.toLowerCase() === 'tbd' || !city) continue;
    const key = `${name}|${city}`;
    if (arenaIds.has(key)) { g.arenaId = arenaIds.get(key); continue; }
    const state = (g.sched.arenaState ?? '').trim();
    const ft = await arenaElevation(db, city.split(',')[0], state);
    const country = /^(ON|BC|QC|AB|MB)$/.test(state) ? 'Canada' : g.neutral && !/^[A-Z]{2}$/.test(state) || /^(MX|FR|UK|GB|DE|JP|CN)$/.test(state) ? (city.split(',')[1]?.trim() || state || 'International') : 'USA';
    const { rows: [a] } = await db.query(
      `INSERT INTO arenas (name, city, state, country, elevation_ft, is_high_altitude) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name, city) DO UPDATE SET elevation_ft = COALESCE(arenas.elevation_ft, EXCLUDED.elevation_ft),
         is_high_altitude = COALESCE(arenas.elevation_ft, EXCLUDED.elevation_ft, 0) >= ${HIGH_ALTITUDE_FT}
       RETURNING id`, [name, city, state || null, country, ft, (ft ?? 0) >= HIGH_ALTITUDE_FT]);
    arenaIds.set(key, a.id); g.arenaId = a.id; counts.arenas++;
  }

  // ---- playoff / play-in series
  const stand = standings.map((s) => ({ teamNbaId: String(s.TeamID), conference: s.Conference, rank: Number(s.PlayoffRank), wins: Number(s.WINS) }));
  const seriesRows = team.filter((r) => /^00[45]/.test(String(r.GAME_ID))).map((r) => ({ gameId: String(r.GAME_ID), teamNbaId: String(r.TEAM_ID), won: r.WL === 'W' }));
  const seriesByGame = new Map();
  for (const s of buildSeries(season, seriesRows, stand)) {
    const { rows: [row] } = await db.query(
      `INSERT INTO playoff_series (season, round, conference, bracket_slot, best_of, higher_seed, lower_seed, higher_seed_team_id, lower_seed_team_id, winner_team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (season, bracket_slot) DO UPDATE SET round = EXCLUDED.round, conference = EXCLUDED.conference, best_of = EXCLUDED.best_of,
         higher_seed = EXCLUDED.higher_seed, lower_seed = EXCLUDED.lower_seed, higher_seed_team_id = EXCLUDED.higher_seed_team_id,
         lower_seed_team_id = EXCLUDED.lower_seed_team_id, winner_team_id = EXCLUDED.winner_team_id
       RETURNING id`,
      [season, s.round, s.conference, s.bracket_slot, s.best_of, s.higher_seed, s.lower_seed, teamId(s.higherNbaId), teamId(s.lowerNbaId), s.winnerNbaId ? teamId(s.winnerNbaId) : null]);
    for (const gid of s.gameIds) seriesByGame.set(gid, row.id);
    if (!s.winnerNbaId) throw new Error(`series ${s.bracket_slot} has no winner`);
    counts.series++;
  }

  // ---- game ids (crosswalk)
  const { rows: known } = await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type = 'game' AND source = 'nba_stats' AND source_id = ANY($1::text[])`, [[...games.keys()]]);
  const gameUuid = new Map(known.map((k) => [k.source_id, k.canonical_id]));
  const newGames = [];
  for (const id of games.keys()) if (!gameUuid.has(id)) { const u = randomUUID(); gameUuid.set(id, u); newGames.push([u, id]); }

  // ---- games upsert
  const G = { id: [], type: [], cup: [], series: [], sgn: [], date: [], tip: [], home: [], away: [], arena: [], neutral: [], tier: [], nets: [], hs: [], as: [] };
  for (const g of games.values()) {
    const s = g.sched;
    G.id.push(gameUuid.get(g.id)); G.type.push(g.type); G.cup.push(cupStage(s, g.id));
    G.series.push(seriesByGame.get(g.id) ?? null); G.sgn.push(/^00[45]/.test(g.id) ? Number(g.id[9]) : null);
    G.date.push(g.date); G.tip.push(s.gameDateTimeUTC && !s.gameDateTimeUTC.startsWith('0001') ? s.gameDateTimeUTC : null);
    G.home.push(teamId(g.home.TEAM_ID)); G.away.push(teamId(g.away.TEAM_ID)); G.arena.push(g.arenaId ?? null);
    G.neutral.push(g.neutral); G.tier.push(nationalTvTier(s.broadcasters)); G.nets.push(JSON.stringify(nationalBroadcasterList(s.broadcasters)));
    G.hs.push(g.home.PTS); G.as.push(g.away.PTS);
  }
  counts.games = await upsertChunks(db, () =>
    `INSERT INTO games (id, season, season_type, cup_stage, playoff_series_id, series_game_number, game_date_local, tipoff_utc,
       home_team_id, away_team_id, arena_id, is_neutral_site, national_tv_tier, national_broadcasters, status, home_score, away_score, updated_at)
     SELECT id, '${season}', type, cup, series, sgn, d, tip, home, away, arena, neutral, tier,
            ARRAY(SELECT jsonb_array_elements_text(nets::jsonb)), 'final', hs, aws, now()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::smallint[], $6::date[], $7::timestamptz[], $8::int[], $9::int[], $10::int[], $11::bool[], $12::text[], $13::text[], $14::smallint[], $15::smallint[])
         AS t(id, type, cup, series, sgn, d, tip, home, away, arena, neutral, tier, nets, hs, aws)
     ON CONFLICT (id) DO UPDATE SET season_type = EXCLUDED.season_type, cup_stage = EXCLUDED.cup_stage, playoff_series_id = EXCLUDED.playoff_series_id,
       series_game_number = EXCLUDED.series_game_number, game_date_local = EXCLUDED.game_date_local, tipoff_utc = EXCLUDED.tipoff_utc,
       home_team_id = EXCLUDED.home_team_id, away_team_id = EXCLUDED.away_team_id, arena_id = EXCLUDED.arena_id,
       is_neutral_site = EXCLUDED.is_neutral_site, national_tv_tier = EXCLUDED.national_tv_tier, national_broadcasters = EXCLUDED.national_broadcasters,
       status = 'final', home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score, updated_at = now()`,
    [G.id, G.type, G.cup, G.series, G.sgn, G.date, G.tip, G.home, G.away, G.arena, G.neutral, G.tier, G.nets, G.hs, G.as]);
  if (newGames.length) await upsertChunks(db, () =>
    `INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
     SELECT 'game', c, 'nba_stats', s, 'exact_id' FROM unnest($1::text[], $2::text[]) AS t(c, s) ON CONFLICT DO NOTHING`,
    [newGames.map((x) => x[0]), newGames.map((x) => x[1])]);

  // ---- team_games (split tags live here)
  const byTeam = new Map();
  for (const g of games.values()) for (const side of [g.home, g.away]) {
    const k = String(side.TEAM_ID);
    (byTeam.get(k) ?? byTeam.set(k, []).get(k)).push({ gameId: g.id, date: g.date });
  }
  const rest = new Map();
  for (const [t, list] of byTeam) for (const [gid, tag] of restTags(list)) rest.set(`${t}|${gid}`, tag);
  const TG = { game: [], team: [], opp: [], venue: [], rest: [], b2b: [], won: [], min: [], ...Object.fromEntries(STAT_COLS.map((c) => [c, []])) };
  for (const g of games.values()) for (const [side, other, isHome] of [[g.home, g.away, true], [g.away, g.home, false]]) {
    const tag = rest.get(`${side.TEAM_ID}|${g.id}`);
    TG.game.push(gameUuid.get(g.id)); TG.team.push(teamId(side.TEAM_ID)); TG.opp.push(teamId(other.TEAM_ID));
    TG.venue.push(g.neutral ? 'neutral' : isHome ? 'home' : 'away'); TG.rest.push(tag.rest_days); TG.b2b.push(tag.b2b_night);
    TG.won.push(side.WL === 'W'); TG.min.push(side.MIN);
    for (const c of STAT_COLS) TG[c].push(statOf(side, c));
  }
  const statList = STAT_COLS.join(', ');
  counts.team_rows = await upsertChunks(db, () =>
    `INSERT INTO team_games (game_id, team_id, opponent_team_id, venue_split, rest_days, b2b_night, won, minutes, ${statList})
     SELECT * FROM unnest($1::uuid[], $2::int[], $3::int[], $4::text[], $5::smallint[], $6::smallint[], $7::bool[], $8::smallint[],
       ${STAT_COLS.map((_, i) => `$${i + 9}::smallint[]`).join(', ')})
     ON CONFLICT (game_id, team_id) DO UPDATE SET opponent_team_id = EXCLUDED.opponent_team_id, venue_split = EXCLUDED.venue_split,
       rest_days = EXCLUDED.rest_days, b2b_night = EXCLUDED.b2b_night, won = EXCLUDED.won, minutes = EXCLUDED.minutes,
       ${STAT_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [TG.game, TG.team, TG.opp, TG.venue, TG.rest, TG.b2b, TG.won, TG.min, ...STAT_COLS.map((c) => TG[c])]);

  // ---- players seen in logs but not seeded (shouldn't happen often)
  const missing = new Map();
  for (const r of player) if (!maps.player.has(String(r.PLAYER_ID))) missing.set(String(r.PLAYER_ID), r.PLAYER_NAME);
  if (missing.size) {
    const ids = [], names = [], src = [];
    for (const [nba, name] of missing) { const u = randomUUID(); ids.push(u); names.push(name); src.push(nba); maps.player.set(nba, u); }
    await db.query(`INSERT INTO players (id, full_name, is_active) SELECT id, n, false FROM unnest($1::uuid[], $2::text[]) AS t(id, n)`, [ids, names]);
    await db.query(`INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
      SELECT 'player', c, 'nba_stats', s, 'exact_id (created by backfill)' FROM unnest($1::text[], $2::text[]) AS t(c, s)`, [ids, src]);
    counts.players_created = missing.size;
  }

  // ---- player_game_stats
  const P = { game: [], player: [], team: [], min: [], ...Object.fromEntries(STAT_COLS.map((c) => [c, []])) };
  for (const r of player) {
    const gid = String(r.GAME_ID);
    if (!games.has(gid)) continue;
    P.game.push(gameUuid.get(gid)); P.player.push(maps.player.get(String(r.PLAYER_ID))); P.team.push(teamId(r.TEAM_ID)); P.min.push(r.MIN);
    for (const c of STAT_COLS) P[c].push(statOf(r, c));
  }
  counts.player_rows = await upsertChunks(db, () =>
    `INSERT INTO player_game_stats (game_id, player_id, team_id, minutes, ${statList}, source, updated_at)
     SELECT *, 'nba_stats', now() FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::numeric[], ${STAT_COLS.map((_, i) => `$${i + 5}::smallint[]`).join(', ')})
     ON CONFLICT (game_id, player_id) DO UPDATE SET team_id = EXCLUDED.team_id, minutes = EXCLUDED.minutes,
       ${STAT_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, source = 'nba_stats', updated_at = now()`,
    [P.game, P.player, P.team, P.min, ...STAT_COLS.map((c) => P[c])]);

  // ---- checks (independent of how we loaded it)
  const problems = [];
  const { rows: wl } = await db.query(
    `SELECT x.source_id nba, count(*) FILTER (WHERE tg.won)::int w, count(*) FILTER (WHERE NOT tg.won)::int l
       FROM team_games tg JOIN games g ON g.id = tg.game_id
       JOIN entity_id_crosswalk x ON x.entity_type = 'team' AND x.source = 'nba_stats' AND x.canonical_id = tg.team_id::text
      WHERE g.season = $1 AND g.season_type = 'regular' GROUP BY 1`, [season]);
  const wlMap = new Map(wl.map((r) => [r.nba, r]));
  for (const s of standings) {
    const got = wlMap.get(String(s.TeamID));
    if (!got || got.w !== Number(s.WINS) || got.l !== Number(s.LOSSES)) problems.push(`${s.TeamCity} ${s.TeamName}: standings ${s.WINS}-${s.LOSSES}, loaded ${got ? `${got.w}-${got.l}` : 'nothing'}`);
  }
  const { rows: [pc] } = await db.query(`SELECT count(*)::int n FROM player_game_stats p JOIN games g ON g.id = p.game_id WHERE g.season = $1`, [season]);
  if (pc.n !== P.game.length) problems.push(`player rows: loaded ${pc.n}, logs had ${P.game.length}`);
  if (problems.length) throw new Error('checks failed:\n    - ' + problems.slice(0, 10).join('\n    - '));

  const neutral = [...games.values()].filter((g) => g.neutral).map((g) => `${g.date} ${g.away.TEAM_ABBREVIATION}@${g.home.TEAM_ABBREVIATION} ${g.sched.arenaCity ?? '?'}`);
  const byType = {}; for (const g of games.values()) byType[g.type] = (byType[g.type] ?? 0) + 1;
  const tiers = {}; for (const t of G.tier) tiers[t] = (tiers[t] ?? 0) + 1;
  return { counts, byType, tiers, neutral, notPlayed };
}

// ---------------------------------------------------------------- main ----
const env = loadEnv();
const seasons = seasonsFromArgs(process.argv.slice(2));
const { url, host, ssl } = publicDbUrl(env);
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[backfill] cannot reach the database at ${host}: ${e.message}`); process.exit(1); }
log(`connected: ${host} — ${seasons.length} season(s): ${seasons[0]} .. ${seasons.at(-1)}`);

const maps = {
  team: new Map((await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type='team' AND source='nba_stats'`)).rows.map((r) => [r.source_id, Number(r.canonical_id)])),
  player: new Map((await db.query(`SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type='player' AND source='nba_stats'`)).rows.map((r) => [r.source_id, r.canonical_id])),
};
if (maps.team.size !== 30) { console.error(`[backfill] expected 30 seeded teams, found ${maps.team.size} — run npm run db:seed first`); process.exit(1); }

const failed = [];
for (const season of seasons) {
  const t0 = Date.now();
  const { rows: [run] } = await db.query(`INSERT INTO ingestion_runs (job_type, source, triggered_by, details) VALUES ('backfill_season', 'nba_stats', 'backfill', $1) RETURNING id`, [{ season }]);
  try {
    const data = await fetchSeason(season);
    await db.query('BEGIN');
    const r = await loadSeason(db, season, maps, data);
    await db.query('COMMIT');
    const c = r.counts;
    await db.query(`UPDATE ingestion_runs SET status='success', finished_at=now(), records_written=$2, details=$3 WHERE id=$1`,
      [run.id, c.games + c.team_rows + c.player_rows + c.series, { season, ...c, byType: r.byType, tiers: r.tiers, neutral: r.neutral, notPlayed: r.notPlayed }]);
    log(`${season} ✓ ${c.games} games ${JSON.stringify(r.byType)} · ${c.player_rows} player rows · ${c.series} series · TV ${JSON.stringify(r.tiers)} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (c.players_created) log(`  ${c.players_created} player(s) not in the seed were created from game logs`);
    if (r.notPlayed.length) log(`  not played (skipped): ${r.notPlayed.join(' | ')}`);
    if (r.neutral.length) log(`  neutral (${r.neutral.length}): ${r.neutral.length > 6 ? r.neutral.slice(0, 3).join(' | ') + ` | … +${r.neutral.length - 3} more` : r.neutral.join(' | ')}`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    await db.query(`UPDATE ingestion_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [run.id, e.message]).catch(() => {});
    log(`${season} ✗ FAILED — nothing written for this season.\n  ${e.message}`);
    failed.push(season);
  }
}

// Spot checks against well-known published numbers.
const spot = async (name, season) => (await db.query(
  `SELECT count(*)::int gp, round(avg(s.pts), 1)::text ppg FROM player_game_stats s JOIN players p ON p.id = s.player_id
     JOIN games g ON g.id = s.game_id WHERE p.full_name = $1 AND g.season = $2 AND g.season_type = 'regular'`, [name, season])).rows[0];
for (const [name, season] of [['LeBron James', '2003-04'], ['Nikola Jokić', '2025-26']]) {
  if (!seasons.includes(season)) continue;
  const r = await spot(name, season);
  log(`spot check: ${name} ${season} regular season — ${r.gp} games, ${r.ppg} PPG`);
}
await db.end();
if (failed.length) { log(`done with FAILURES: ${failed.join(', ')} (re-run with --season to retry just those)`); process.exitCode = 1; }
else log('done — all seasons loaded and checked.');
