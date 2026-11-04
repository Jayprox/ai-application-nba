// Home-team IANA time zone by canonical abbreviation (teams.abbreviation, NBA.com style), so the weekly
// Highlightly pass can keep games.game_date_local right when a tip-off moves (architecture §6.1: the local
// date is the home team's local date of tip-off, never the UTC date). Static on purpose: a relocated team
// needs a one-line change here (test/team-tz.test.js checks all 30 are covered).
// Neutral-site games have no venue zone and never take a Highlightly tip-off change.
export const TEAM_TZ = {
  ATL: 'America/New_York', BOS: 'America/New_York', BKN: 'America/New_York', CHA: 'America/New_York',
  CHI: 'America/Chicago', CLE: 'America/New_York', DAL: 'America/Chicago', DEN: 'America/Denver',
  DET: 'America/New_York', GSW: 'America/Los_Angeles', HOU: 'America/Chicago', IND: 'America/New_York',
  LAC: 'America/Los_Angeles', LAL: 'America/Los_Angeles', MEM: 'America/Chicago', MIA: 'America/New_York',
  MIL: 'America/Chicago', MIN: 'America/Chicago', NOP: 'America/Chicago', NYK: 'America/New_York',
  OKC: 'America/Chicago', ORL: 'America/New_York', PHI: 'America/New_York', PHX: 'America/Phoenix',
  POR: 'America/Los_Angeles', SAC: 'America/Los_Angeles', SAS: 'America/Chicago', TOR: 'America/Toronto',
  UTA: 'America/Denver', WAS: 'America/New_York',
};

/** 'YYYY-MM-DD' of `tipUtc` (Date or ISO string) in the home team's zone; null for an unknown team. */
export function localDate(tipUtc, abbr) {
  const tz = TEAM_TZ[abbr];
  if (!tz) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(tipUtc));
  const v = (t) => parts.find((p) => p.type === t).value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}
