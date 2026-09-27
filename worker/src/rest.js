// Copy of scripts/lib/tagging.mjs restTags (PLATFORM.md: services don't share code).
// Keep in sync; scripts/lib/tagging.test.mjs has the cases.

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
