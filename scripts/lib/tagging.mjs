// Pure tagging rules for the backfill (and later the worker). No I/O —
// everything here is unit-tested in tagging.test.mjs with real NBA.com cases.
// Decisions: architecture.md §6.1 (splits) and §7.2 (backfill).

/** NBA.com game-id prefix -> our season_type; null = not loaded (preseason, All-Star). */
export function seasonTypeFromGameId(gameId) {
  return { '002': 'regular', '004': 'playoffs', '005': 'play_in', '006': 'cup_final' }[String(gameId).slice(0, 3)] ?? null;
}

const US_CA = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ON BC QC AB MB'.split(' '));

/**
 * Neutral site (§6.1, extended 2026-09-26 for pre-2024-25 seasons, when
 * NBA.com didn't flag them): NBA.com's isNeutral, OR outside the US/Canada,
 * OR the 2019-20 Orlando bubble restart (from 2020-07-30), OR Las Vegas (no
 * NBA team — Cup knockout games). Alternate home venues (Clippers-Anaheim,
 * Hornets-OKC 2005-07, Spurs-Austin, Raptors-Tampa 2020-21) stay home games.
 */
export function isNeutralSite(g, season, localDate) {
  if (g.isNeutral) return true;
  const state = (g.arenaState ?? '').trim().toUpperCase();
  const city = (g.arenaCity ?? '').trim();
  if (g.arenaName && g.arenaName.toLowerCase() !== 'tbd' && !US_CA.has(state)) return true;
  if (season === '2019-20' && localDate >= '2020-07-30') return true;
  if (/^las vegas/i.test(city)) return true;
  return false;
}

// National partners across the whole 2003-04+ era (incl. streaming simulcasts).
const MAJOR = new Set(['ABC', 'ESPN', 'ESPN2', 'TNT', 'TBS', 'TRUTV', 'NBC', 'PEACOCK', 'NBCSN', 'AMAZON', 'PRIME VIDEO', 'TELEMUNDO', 'ESPN+', 'DISNEY+', 'MAX', 'DISNEY', 'DISNEY XD']);

/** 'major' | 'nba_tv' | 'local' from the schedule's national TV/OTT broadcasters. */
/**
 * Status the schedule loader may write: only 'scheduled' or 'postponed'.
 * Live/final (and their scores) belong to the ingestion worker and the NBA.com
 * backfill. The schedule has no scores, and games requires a score on a final
 * game (games_check6), so passing NBA.com's "final" through failed the whole
 * weekly run on 2026-10-05, the first week with a finished (preseason) game.
 * Existing live/final rows are never downgraded (the upsert keeps them).
 */
export function scheduleStatus(g) {
  return g?.postponedStatus === 'Y' ? 'postponed' : 'scheduled';
}

export function nationalTvTier(broadcasters) {
  const b = broadcasters ?? {};
  const names = [...(b.nationalBroadcasters ?? []), ...(b.nationalOttBroadcasters ?? [])]
    .filter((x) => !x.broadcasterMedia || x.broadcasterMedia === 'tv' || x.broadcasterMedia === 'ott')
    .flatMap((x) => String(x.broadcasterAbbreviation ?? x.broadcasterDisplay ?? '').split(/[/+,]/))
    .map((t) => t.trim().toUpperCase()).filter(Boolean);
  // "ESPN+" / "Disney+" lose their '+' in the split above — map both spellings.
  if (names.some((n) => MAJOR.has(n) || MAJOR.has(n + '+'))) return 'major';
  if (names.includes('NBA TV')) return 'nba_tv';
  return 'local';
}
export function nationalBroadcasterList(broadcasters) {
  const b = broadcasters ?? {};
  return [...new Set([...(b.nationalBroadcasters ?? []), ...(b.nationalOttBroadcasters ?? [])].map((x) => x.broadcasterAbbreviation).filter(Boolean))];
}

/** NBA Cup stage from schedule labels; the 006 game is always the final. */
export function cupStage(g, gameId) {
  if (String(gameId).startsWith('006')) return 'final';
  const sub = g?.gameSubtype ?? '';
  if (sub === 'in-season') return 'group';
  if (sub === 'in-season-knockout') {
    const label = `${g.gameSubLabel ?? ''} ${g.gameLabel ?? ''}`.toLowerCase();
    if (label.includes('quarter')) return 'quarterfinal';
    if (label.includes('semi')) return 'semifinal';
    if (label.includes('champ') || label.includes('final')) return 'final';
  }
  return null;
}

/** Local calendar date: home team's local tip time when present, else NBA.com's game date. */
export function localGameDate(g, fallbackDate) {
  const t = g?.homeTeamTime;
  if (t && !t.startsWith('0001')) return t.slice(0, 10);
  if (g?.gameDateEst) return g.gameDateEst.slice(0, 10);
  return fallbackDate;
}

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Rest / back-to-back tags for one team's (or one player's) games in one
 * season, chronological. rest_days = days off since the previous game (null
 * when there is none); b2b_night 2 = played yesterday, 1 = plays tomorrow.
 *
 * `anchors` are dates of games that count as "played" for rest but get no
 * tags themselves: preseason games and the 2020 bubble scrimmages. This is
 * how NBA.com counts it: an opener's rest runs from the last preseason game
 * (Morant 2019-10-23 = 4 days after 10-18), and Memphis' first bubble game
 * (2020-07-31) has 2 days of rest after the 07-28 scrimmage.
 * @param {Array<{gameId:string,date:string}>} games
 * @param {string[]} [anchors]
 * @returns {Map<string,{rest_days:number|null,b2b_night:1|2|null}>}
 */
export function restTags(games, anchors = []) {
  const all = [...games, ...anchors.map((date) => ({ gameId: null, date }))];
  const g = all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId === null ? -1 : 1));
  const out = new Map();
  g.forEach((x, i) => {
    if (x.gameId === null) return;
    // Two games on one date has no meaningful rest -> null. Known case:
    // Shawn Marion 2007-12-19 (PHX @ DAL, plus the MIA @ ATL game that was
    // replayed from the 3rd quarter on 2008-03-08 but is dated 12-19).
    const gap = (a, b) => { const d = dayDiff(a.date, b.date) - 1; return d < 0 ? null : d; };
    const rest = i > 0 ? gap(g[i - 1], x) : null;
    const nextRest = i < g.length - 1 ? gap(x, g[i + 1]) : null;
    out.set(x.gameId, { rest_days: rest, b2b_night: rest === 0 ? 2 : nextRest === 0 ? 1 : null });
  });
  return out;
}

/**
 * Build playoff + play-in series from game ids and team-game results.
 * Game ids: 004YY00RSG (round R, series S, game G); play-in 005YY00RSG.
 * @param season '2019-20'
 * @param teamRows [{gameId, teamNbaId, won}] for 004/005 games
 * @param standings [{teamNbaId, conference, rank, wins}]
 * @returns [{key, season, round, conference, bracket_slot, best_of, higher_seed, lower_seed, higherNbaId, lowerNbaId, winnerNbaId, gameIds}]
 */
export function buildSeries(season, teamRows, standings) {
  const st = new Map(standings.map((s) => [s.teamNbaId, s]));
  const byKey = new Map();
  for (const r of teamRows) {
    const id = String(r.gameId);
    const kind = id.slice(0, 3);
    if (kind !== '004' && kind !== '005') continue;
    const key = id.slice(0, 9);
    const s = byKey.get(key) ?? { key, kind, R: Number(id[7]), teams: new Map(), gameIds: new Set() };
    s.gameIds.add(id);
    s.teams.set(r.teamNbaId, (s.teams.get(r.teamNbaId) ?? 0) + (r.won ? 1 : 0));
    byKey.set(key, s);
  }
  const ROUND = { 1: 'first_round', 2: 'conf_semis', 3: 'conf_finals', 4: 'finals' };
  const out = [];
  for (const s of byKey.values()) {
    const [a, b] = [...s.teams.keys()];
    if (b === undefined) throw new Error(`series ${s.key}: only one team found`);
    const sa = st.get(a), sb = st.get(b);
    if (!sa || !sb) throw new Error(`series ${s.key}: missing standings for a team`);
    // Higher seed = better conference rank; Finals (cross-conference) = better record.
    const aHigher = s.kind === '004' && s.R === 4 ? sa.wins >= sb.wins : sa.rank <= sb.rank;
    const [hi, lo] = aHigher ? [a, b] : [b, a];
    const hs = st.get(hi).rank, ls = st.get(lo).rank;
    const conf = st.get(hi).conference;
    const wHi = s.teams.get(hi), wLo = s.teams.get(lo);
    const winner = wHi === wLo ? null : wHi > wLo ? hi : lo;
    let round, slot, bestOf;
    if (s.kind === '005') {
      round = 'play_in';
      bestOf = season === '2019-20' ? 2 : 1;
      slot = s.R === 2 ? `${conf[0]}-8seed` : `${conf[0]}-${hs}v${ls}`;
    } else {
      round = ROUND[s.R];
      bestOf = 7;
      slot = s.R === 4 ? 'FINALS' : `${conf[0]}-R${s.R}-${hs}v${ls}`;
    }
    out.push({ key: s.key, season, round, conference: round === 'finals' ? null : conf, bracket_slot: slot, best_of: bestOf,
      higher_seed: hs, lower_seed: ls, higherNbaId: hi, lowerNbaId: lo, winnerNbaId: winner, gameIds: [...s.gameIds].sort() });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}
