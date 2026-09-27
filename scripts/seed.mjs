// Seed reference data: arenas (with elevation), 30 teams, and every NBA
// player since 2003-04, plus their vendor-id crosswalk rows.
//
//   npm run db:seed           (from JD's Mac — NBA.com blocks Railway IPs)
//
// Safe to re-run: everything is an upsert keyed on stable ids (crosswalk
// source ids, team abbreviation, arena name+city). All writes happen in ONE
// transaction — a failure leaves the database exactly as it was — and every
// run is logged to ingestion_runs (success or failure).
//
// Sources (architecture.md §3.2):
//   teams/conf/div   NBA.com leaguestandingsv3
//   tricode + arena  NBA.com schedule JSON (home team's most common arena)
//   elevation        Open-Meteo geocoding (city elevation)
//   players          NBA.com commonallplayers (TO_YEAR >= 2003) + commonteamroster
//   Highlightly ids  Highlightly /matches for a date every team played
// Highlightly PLAYER ids are NOT seeded — matched lazily at ingestion (§3.3).
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { loadEnv, publicDbUrl } from './lib/env.mjs';
import { rows, nbaStandings, nbaAllPlayers, nbaRoster, nbaSchedule, highlightlyMatches, geocode } from './lib/sources.mjs';

const STANDINGS_SEASON = '2025-26';          // conferences/divisions
const ROSTER_SEASONS = ['2026-27', '2025-26']; // first one with data wins
const PLAYER_LIST_SEASON = '2026-27';          // its ROSTERSTATUS matches current rosters (610 vs 531 for 2025-26)
const FIRST_SEASON_START = 2003;               // 2003-04 (decided 2026-09-26; §5)
const HIGH_ALTITUDE_FT = 4000;                 // DEN ~5,280 ft, UTA ~4,200 ft (§6.1)
const HIGHLIGHTLY_DATES = ['2026-04-12', '2026-04-10', '2026-04-08', '2026-04-05'];

const STATES = { AZ: 'Arizona', CA: 'California', CO: 'Colorado', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', IL: 'Illinois', IN: 'Indiana', LA: 'Louisiana', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', NC: 'North Carolina', NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', WA: 'Washington', WI: 'Wisconsin', ON: 'Ontario' };

const log = (...a) => console.log('[seed]', ...a);
const env = loadEnv();

// ---------------------------------------------------------------- fetch ----
async function fetchAll() {
  log('fetching NBA.com standings, schedule, all players …');
  const standings = rows(await nbaStandings(STANDINGS_SEASON));
  if (standings.length !== 30) throw new Error(`expected 30 teams in standings, got ${standings.length}`);
  const schedule = await nbaSchedule();
  const allPlayers = rows(await nbaAllPlayers(PLAYER_LIST_SEASON));

  // tricode + home arena per NBA.com team id, from non-neutral regular-season home games
  const games = schedule.leagueSchedule.gameDates.flatMap((d) => d.games);
  const teamInfo = {};
  for (const g of games) {
    if (!g.gameId.startsWith('002') || g.isNeutral || !g.homeTeam?.teamTricode) continue; // skip TBD placeholders
    const t = (teamInfo[g.homeTeam.teamId] ??= { tricode: g.homeTeam.teamTricode, arenas: {} });
    const key = `${g.arenaName}|${g.arenaCity}|${g.arenaState ?? ''}`;
    t.arenas[key] = (t.arenas[key] ?? 0) + 1;
  }

  const teams = standings.map((s) => {
    const info = teamInfo[s.TeamID];
    if (!info) throw new Error(`no home games found in schedule for ${s.TeamCity} ${s.TeamName}`);
    const [name, city, state] = Object.entries(info.arenas).sort((a, b) => b[1] - a[1])[0][0].split('|');
    return {
      nbaId: s.TeamID, abbreviation: info.tricode, city: s.TeamCity, name: s.TeamName,
      fullName: `${s.TeamCity} ${s.TeamName}`, conference: s.Conference, division: s.Division,
      arena: { name, city, state: state || null, country: state === 'ON' ? 'Canada' : 'USA' },
    };
  });

  log('looking up arena elevations (Open-Meteo) …');
  for (const t of teams) t.arena.elevationFt = await elevationFor(t.arena);

  log('fetching Highlightly team ids …');
  const hl = await highlightlyTeams(teams);

  log('fetching 30 team rosters (position/height/weight/birth date) …');
  const rosterByPlayer = {};
  let rosterSeason = null;
  for (const season of ROSTER_SEASONS) {
    let got = 0;
    for (const t of teams) {
      const r = await nbaRoster(t.nbaId, season);
      if (!r) continue;
      for (const p of rows(r, 'CommonTeamRoster')) { rosterByPlayer[p.PLAYER_ID] = p; got++; }
    }
    if (got > 0) { rosterSeason = season; break; }
  }
  log(`rosters: ${Object.keys(rosterByPlayer).length} players (season ${rosterSeason ?? 'none'})`);

  // A just-drafted or just-signed player can be on a roster before he shows up
  // in commonallplayers — add him from the roster row rather than drop him.
  const listed = new Set(allPlayers.map((p) => p.PERSON_ID));
  let rosterOnly = 0;
  for (const r of Object.values(rosterByPlayer)) {
    if (listed.has(r.PLAYER_ID)) continue;
    const parts = String(r.PLAYER).split(' ');
    allPlayers.push({ PERSON_ID: r.PLAYER_ID, DISPLAY_FIRST_LAST: r.PLAYER,
      DISPLAY_LAST_COMMA_FIRST: `${parts.slice(1).join(' ')}, ${parts[0]}`,
      ROSTERSTATUS: 1, FROM_YEAR: '2026', TO_YEAR: '2026', TEAM_ID: r.TeamID });
    rosterOnly++;
  }
  if (rosterOnly) log(`${rosterOnly} rostered player(s) not yet in NBA.com's all-players list — added from rosters`);

  const players = allPlayers
    .filter((p) => Number(p.TO_YEAR) >= FIRST_SEASON_START)
    .map((p) => {
      const [last, first] = String(p.DISPLAY_LAST_COMMA_FIRST).split(', ');
      const r = rosterByPlayer[p.PERSON_ID];
      return {
        nbaId: p.PERSON_ID, fullName: p.DISPLAY_FIRST_LAST, first: first ?? null, last: last ?? null,
        active: p.ROSTERSTATUS === 1, nbaTeamId: p.ROSTERSTATUS === 1 && p.TEAM_ID ? p.TEAM_ID : null,
        firstSeason: Number(p.FROM_YEAR) || null,
        position: r?.POSITION || null, heightIn: inches(r?.HEIGHT), weightLb: r?.WEIGHT ? Number(r.WEIGHT) : null,
        birthDate: r?.BIRTH_DATE ? isoDate(r.BIRTH_DATE) : null,
      };
    });
  return { teams, hl, players, rosterSeason };
}

async function elevationFor(arena) {
  const cc = arena.country === 'Canada' ? 'CA' : 'US';
  const res = (await geocode(arena.city, cc))?.results ?? [];
  const wantState = STATES[arena.state];
  const hits = res.filter((r) => !wantState || r.admin1 === wantState).sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  if (!hits.length || hits[0].elevation == null) {
    console.warn(`[seed] WARN no elevation for ${arena.city}, ${arena.state} — stored as NULL`);
    return null;
  }
  return Math.round(hits[0].elevation * 3.28084);
}

async function highlightlyTeams(teams) {
  const byNick = Object.fromEntries(teams.map((t) => [t.name.toLowerCase(), t]));
  const found = {};
  const key = env.HIGHLIGHTLY_API_KEY ?? '';
  if (!key && !process.env.SEED_FIXTURES) { console.warn('[seed] WARN HIGHLIGHTLY_API_KEY missing — skipping Highlightly team ids'); return found; }
  for (const date of HIGHLIGHTLY_DATES) {
    const j = await highlightlyMatches(date, key);
    for (const m of j.data ?? []) {
      for (const side of [m.homeTeam, m.awayTeam]) {
        const t = byNick[String(side.name).toLowerCase()];
        if (!t) throw new Error(`Highlightly team "${side.displayName}" (${side.abbreviation}) matches no NBA.com team`);
        found[t.abbreviation] = { id: String(side.id), abbreviation: side.abbreviation };
      }
    }
    if (Object.keys(found).length === 30) break;
  }
  return found;
}

const inches = (h) => { const m = /^(\d+)-(\d+)$/.exec(h ?? ''); return m ? Number(m[1]) * 12 + Number(m[2]) : null; };
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const isoDate = (s) => { const m = /^([A-Z]{3}) (\d{1,2}), (\d{4})$/.exec(s); return m ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null; };

// ---------------------------------------------------------------- write ----
async function write(db, { teams, hl, players }) {
  const counts = { arenas: 0, teams: 0, team_crosswalk: 0, players_new: 0, players_updated: 0, player_crosswalk_new: 0 };

  const teamIdByAbbr = {};
  for (const t of teams) {
    const a = t.arena;
    const { rows: [arena] } = await db.query(
      `INSERT INTO arenas (name, city, state, country, elevation_ft, is_high_altitude)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name, city) DO UPDATE SET state = EXCLUDED.state, country = EXCLUDED.country,
         elevation_ft = EXCLUDED.elevation_ft, is_high_altitude = EXCLUDED.is_high_altitude
       RETURNING id`,
      [a.name, a.city, a.state, a.country, a.elevationFt, (a.elevationFt ?? 0) >= HIGH_ALTITUDE_FT]);
    counts.arenas++;
    const { rows: [team] } = await db.query(
      `INSERT INTO teams (abbreviation, city, name, full_name, conference, division, home_arena_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (abbreviation) DO UPDATE SET city = EXCLUDED.city, name = EXCLUDED.name,
         full_name = EXCLUDED.full_name, conference = EXCLUDED.conference, division = EXCLUDED.division,
         home_arena_id = EXCLUDED.home_arena_id
       RETURNING id`,
      [t.abbreviation, t.city, t.name, t.fullName, t.conference, t.division, arena.id]);
    teamIdByAbbr[t.abbreviation] = team.id;
    counts.teams++;
    const xw = [['nba_stats', String(t.nbaId), 'exact_id']];
    if (hl[t.abbreviation]) xw.push(['highlightly', hl[t.abbreviation].id, `nickname (${hl[t.abbreviation].abbreviation})`]);
    for (const [source, sourceId, method] of xw) {
      await db.query(
        `INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
         VALUES ('team', $1, $2, $3, $4)
         ON CONFLICT (entity_type, source, source_id) DO UPDATE
           SET canonical_id = EXCLUDED.canonical_id, match_method = EXCLUDED.match_method, updated_at = now()`,
        [String(team.id), source, sourceId, method]);
      counts.team_crosswalk++;
    }
  }
  const teamIdByNba = Object.fromEntries(teams.map((t) => [t.nbaId, teamIdByAbbr[t.abbreviation]]));

  // Players: existing crosswalk rows decide update vs insert, then bulk writes via unnest.
  const { rows: existing } = await db.query(
    `SELECT source_id, canonical_id FROM entity_id_crosswalk WHERE entity_type = 'player' AND source = 'nba_stats'`);
  const known = new Map(existing.map((r) => [r.source_id, r.canonical_id]));
  const cols = { id: [], full: [], first: [], last: [], bd: [], pos: [], ht: [], wt: [], team: [], active: [], fs: [] };
  const newXw = { canon: [], src: [] };
  for (const p of players) {
    let id = known.get(String(p.nbaId));
    if (id) counts.players_updated++;
    else { id = randomUUID(); newXw.canon.push(id); newXw.src.push(String(p.nbaId)); counts.players_new++; }
    cols.id.push(id); cols.full.push(p.fullName); cols.first.push(p.first); cols.last.push(p.last);
    cols.bd.push(p.birthDate); cols.pos.push(p.position); cols.ht.push(p.heightIn); cols.wt.push(p.weightLb);
    cols.team.push(p.nbaTeamId ? teamIdByNba[p.nbaTeamId] ?? null : null); cols.active.push(p.active); cols.fs.push(p.firstSeason);
  }
  await db.query(
    `INSERT INTO players (id, full_name, first_name, last_name, birth_date, listed_position, height_in, weight_lb, current_team_id, is_active, first_season_start, updated_at)
     SELECT *, now() FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::date[], $6::text[], $7::smallint[], $8::smallint[], $9::int[], $10::bool[], $11::smallint[])
     ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       birth_date = COALESCE(EXCLUDED.birth_date, players.birth_date),
       listed_position = COALESCE(EXCLUDED.listed_position, players.listed_position),
       height_in = COALESCE(EXCLUDED.height_in, players.height_in),
       weight_lb = COALESCE(EXCLUDED.weight_lb, players.weight_lb),
       current_team_id = EXCLUDED.current_team_id, is_active = EXCLUDED.is_active,
       first_season_start = COALESCE(EXCLUDED.first_season_start, players.first_season_start), updated_at = now()`,
    [cols.id, cols.full, cols.first, cols.last, cols.bd, cols.pos, cols.ht, cols.wt, cols.team, cols.active, cols.fs]);
  if (newXw.canon.length) {
    const r = await db.query(
      `INSERT INTO entity_id_crosswalk (entity_type, canonical_id, source, source_id, match_method)
       SELECT 'player', c, 'nba_stats', s, 'exact_id' FROM unnest($1::text[], $2::text[]) AS t(c, s)`,
      [newXw.canon, newXw.src]);
    counts.player_crosswalk_new = r.rowCount;
  }

  // Prune players no longer in scope (e.g. careers that ended before 2003-04,
  // seeded when the backfill started at 1996-97) — only if they have no stats
  // or injury rows. Guarded so a bad/partial fetch can never wipe the table.
  const keep = players.map((p) => String(p.nbaId));
  const minKeep = Number(process.env.SEED_MIN_PLAYERS ?? 2000); // fixtures lower this
  if (keep.length < minKeep) throw new Error(`refusing to prune: only ${keep.length} players fetched (expected ~2,500)`);
  const { rows: gone } = await db.query(
    `DELETE FROM entity_id_crosswalk x
      WHERE x.entity_type = 'player' AND x.source = 'nba_stats' AND NOT (x.source_id = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM player_game_stats s WHERE s.player_id::text = x.canonical_id)
        AND NOT EXISTS (SELECT 1 FROM injury_reports i WHERE i.player_id::text = x.canonical_id)
      RETURNING x.canonical_id`, [keep]);
  if (gone.length) {
    const ids = gone.map((g) => g.canonical_id);
    await db.query(`DELETE FROM entity_id_crosswalk WHERE entity_type = 'player' AND canonical_id = ANY($1::text[])`, [ids]);
    await db.query(`DELETE FROM players WHERE id::text = ANY($1::text[])`, [ids]);
  }
  counts.players_pruned = gone.length;
  return counts;
}

// ------------------------------------------------------------ checks -------
async function verify(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  const problems = [];
  const [c] = await q(`SELECT (SELECT count(*) FROM teams)::int teams,
    (SELECT count(*) FROM players)::int players, (SELECT count(*) FROM players WHERE is_active)::int active,
    (SELECT count(*) FROM entity_id_crosswalk WHERE entity_type='team' AND source='highlightly')::int hl_teams`);
  if (c.teams !== 30) problems.push(`expected 30 teams, have ${c.teams}`);
  if (c.hl_teams !== 30) problems.push(`expected 30 Highlightly team ids, have ${c.hl_teams}`);
  const alt = (await q(`SELECT t.abbreviation FROM teams t JOIN arenas a ON a.id = t.home_arena_id WHERE a.is_high_altitude ORDER BY 1`)).map((r) => r.abbreviation).join(',');
  if (alt !== 'DEN,UTA') problems.push(`high-altitude arenas are [${alt}], expected [DEN,UTA] (§6.1)`);
  const [orph] = await q(`SELECT count(*)::int n FROM players p WHERE NOT EXISTS
    (SELECT 1 FROM entity_id_crosswalk x WHERE x.entity_type='player' AND x.source='nba_stats' AND x.canonical_id = p.id::text)`);
  if (orph.n) problems.push(`${orph.n} players have no NBA.com crosswalk row`);
  const spot = await q(`SELECT p.full_name, t.abbreviation, p.listed_position FROM players p LEFT JOIN teams t ON t.id = p.current_team_id
    WHERE p.full_name IN ('Nikola Jokić','Jaren Jackson Jr.','Terrence Shannon Jr','LeBron James') ORDER BY 1`);
  return { counts: c, alt, spot, problems };
}

// -------------------------------------------------------------- main -------
const { url, host, ssl } = publicDbUrl(env);
const db = new pg.Client({ connectionString: url, ssl });
try {
  await db.connect();
} catch (e) {
  console.error(`[seed] cannot reach the database at ${host}: ${e.message}`);
  process.exit(1);
}
log(`connected: ${host}`);
const { rows: [run] } = await db.query(
  `INSERT INTO ingestion_runs (job_type, source, triggered_by) VALUES ('seed_reference', 'nba_stats', 'backfill') RETURNING id`);
try {
  const data = await fetchAll();
  await db.query('BEGIN');
  const counts = await write(db, data);
  const check = await verify(db);
  if (check.problems.length) throw new Error('verification failed:\n  - ' + check.problems.join('\n  - '));
  await db.query('COMMIT');
  const written = counts.arenas + counts.teams + counts.team_crosswalk + counts.players_new + counts.players_updated + counts.player_crosswalk_new + counts.players_pruned;
  await db.query(`UPDATE ingestion_runs SET status='success', finished_at=now(), records_written=$2, details=$3 WHERE id=$1`,
    [run.id, written, { ...counts, roster_season: data.rosterSeason }]);
  log('done', counts);
  log(`verified: ${check.counts.teams} teams, ${check.counts.players} players (${check.counts.active} active), altitude arenas ${check.alt}`);
  for (const s of check.spot) log(`  spot check: ${s.full_name} -> ${s.abbreviation ?? '(no team)'} ${s.listed_position ?? ''}`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  await db.query(`UPDATE ingestion_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [run.id, e.message]).catch(() => {});
  console.error('[seed] FAILED — nothing was written.\n' + e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
