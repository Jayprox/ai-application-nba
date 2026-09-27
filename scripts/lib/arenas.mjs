// Arena rows + elevation, shared by the backfill and the schedule loader.
import { geocode } from './sources.mjs';

export const HIGH_ALTITUDE_FT = 4000; // DEN ~5,280 ft, UTA ~4,260 ft (§6.1)
const PROVINCES = /^(ON|BC|QC|AB|MB)$/;
const FOREIGN = /^(MX|FR|UK|GB|DE|JP|CN|AE)$/;

const elevationCache = new Map();
/** Elevation by CITY (arenas get renamed; cities don't move). Reuses stored values first. */
export async function arenaElevation(db, city, state, warn = console.warn) {
  const key = `${city}|${state}`;
  if (elevationCache.has(key)) return elevationCache.get(key);
  const { rows: known } = await db.query(`SELECT elevation_ft FROM arenas WHERE city = $1 AND coalesce(state, '') = $2 AND elevation_ft IS NOT NULL LIMIT 1`, [city, state]);
  let ft = known[0]?.elevation_ft ?? null;
  if (ft == null) {
    const cc = PROVINCES.test(state) ? 'CA' : state.length === 2 && !FOREIGN.test(state) ? 'US' : undefined;
    const res = ((await geocode(city, cc))?.results ?? []).sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    ft = res[0]?.elevation != null ? Math.round(res[0].elevation * 3.28084) : null;
    if (ft == null) warn(`  WARN no elevation for ${city}${state ? ', ' + state : ''} — stored as NULL`);
  }
  elevationCache.set(key, ft);
  return ft;
}

/** Upsert the arena for one NBA.com schedule entry; returns arenas.id or null (tbd/blank). */
export async function upsertArena(db, g, neutral, cache, warn) {
  const name = (g.arenaName ?? '').trim(), city = (g.arenaCity ?? '').trim();
  if (!name || name.toLowerCase() === 'tbd' || !city) return null;
  const key = `${name}|${city}`;
  if (cache.has(key)) return cache.get(key);
  const state = (g.arenaState ?? '').trim();
  const ft = await arenaElevation(db, city.split(',')[0], state, warn);
  const country = PROVINCES.test(state) ? 'Canada'
    : (neutral && !/^[A-Z]{2}$/.test(state)) || FOREIGN.test(state) ? (city.split(',')[1]?.trim() || state || 'International') : 'USA';
  const { rows: [a] } = await db.query(
    `INSERT INTO arenas (name, city, state, country, elevation_ft, is_high_altitude) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name, city) DO UPDATE SET elevation_ft = COALESCE(arenas.elevation_ft, EXCLUDED.elevation_ft),
       is_high_altitude = COALESCE(arenas.elevation_ft, EXCLUDED.elevation_ft, 0) >= ${HIGH_ALTITUDE_FT}
     RETURNING id`, [name, city, state || null, country, ft, (ft ?? 0) >= HIGH_ALTITUDE_FT]);
  cache.set(key, a.id);
  return a.id;
}
