// Question -> plan. The model fills ONE tool call (`plan`); everything it
// returns is validated/normalized here before anything runs. It never sees
// or writes numbers — the API computes them, the summary is a template.
import { MARKETS } from '../query/markets.js';

export const KINDS = ['player_stats', 'team_stats', 'leaders', 'player_rankings', 'team_rankings', 'matchups', 'props', 'standings', 'game', 'unsupported'];
export const LEADER_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'fg3m', 'tov', 'minutes', 'plus_minus'];
const STAT_FOCUS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m', 'minutes', 'plus_minus', 'fg_pct', 'fg3_pct', 'ft_pct', 'ts_pct', 'efg_pct', 'off_rtg', 'def_rtg'];
const TEAM_SORTS = ['net_rtg', 'off_rtg', 'def_rtg', 'pace'];

export const PLAN_TOOL = {
  name: 'plan',
  description: 'The structured NBA stats query that answers the question. Fill only the fields the question needs.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS, description: 'player_stats: a player\'s averages/game log under filters. team_stats: same for a team. leaders: league leaders in a stat. player_rankings: best players by position (composite score). team_rankings: best/worst teams by rating or pace. matchups: which defenses allow the most/fewest to a position. props: a player vs a points/rebounds/etc line (DraftKings or a given number). standings: records / seeds. game: a specific game result (team vs opponent, or on a date). unsupported: anything else (not NBA stats, predictions, betting advice, injuries, news).' },
      player: { type: 'string', description: 'Player name as asked, e.g. "Jokic", "SGA", "LeBron".' },
      team: { type: 'string', description: 'Team as asked, e.g. "Knicks", "BOS", "Golden State".' },
      opponent: { type: 'string', description: 'Opponent team (for game questions).' },
      season: { type: 'string', description: 'Season like 2025-26. Omit for the default (latest season with games).' },
      season_type: { type: 'string', enum: ['regular', 'playoffs', 'play_in', 'all', 'cup'] },
      scope: { type: 'string', enum: ['season', 'last5', 'last10', 'career', 'game_log'] },
      venue: { type: 'string', enum: ['home', 'away'] },
      b2b: { type: 'integer', enum: [1, 2], description: '1 = first night of a back-to-back, 2 = second night.' },
      rest: { type: 'string', enum: ['0', '1', '2', '3+'], description: 'Days of rest.' },
      rest_by: { type: 'string', enum: ['player', 'team'], description: 'Rest counted from the player\'s own games (default) or the team schedule.' },
      national_tv: { type: 'string', enum: ['major', 'nba_tv', 'local'] },
      altitude: { type: 'boolean' },
      stat: { type: 'string', description: `The stat asked about. Leaders: one of ${LEADER_STATS.join(', ')}. Player/team focus: one of ${STAT_FOCUS.join(', ')}. Matchups: one of ${MARKETS.join(', ')}. Team rankings: one of ${TEAM_SORTS.join(', ')}.` },
      market: { type: 'string', enum: MARKETS, description: 'Props: pts, reb, ast, fg3m (threes), pra (pts+reb+ast), pr, pa, ra, stl, blk, stocks (stl+blk), tov.' },
      line: { type: 'number', description: 'Props: the line if the question gives one (e.g. 25.5).' },
      position: { type: 'string', enum: ['G', 'F', 'C'], description: 'Guards / forwards / centers (point guard -> G, power forward -> F).' },
      order: { type: 'string', enum: ['best', 'worst'], description: 'Rankings/matchups: best (default) or worst.' },
      date: { type: 'string', description: 'A specific date, YYYY-MM-DD.' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
      reason: { type: 'string', description: 'unsupported: why, in a few words.' },
    },
    required: ['kind'],
  },
};

export function systemPrompt({ today, currentSeason, latestSeason }) {
  return `You turn questions about NBA stats into ONE call of the \`plan\` tool for the Chalk That NBA app. You never answer with numbers yourself.

Today is ${today}. The current season label is ${currentSeason}; the latest season with games played is ${latestSeason}. Stats go back to 2003-04.
- "this season" = ${latestSeason} unless ${currentSeason} has games; "last season" = the season before that. Omit season for the default.
- Seasons are written like 2025-26. "2024 playoffs" = 2023-24.

Splits (player/team stats): venue home/away; b2b 1 or 2 ("second night of a back-to-back" = b2b 2, "back-to-backs" alone = b2b 2); rest 0/1/2/3+ days ("on no rest" = 0); national_tv major (ESPN/ABC/TNT/NBC/Prime) / nba_tv / local; altitude true (Denver, Utah, Mexico City).
Scope: season (default), last5, last10 ("last 10 games", "lately", "recently" = last10), career, game_log ("game by game", "each game").
season_type: regular (default), playoffs, play_in, all, cup (NBA Cup / in-season tournament).

Kinds:
- player_stats: "how is Brunson doing on the road", "Jokic triple doubles"? (use player_stats with stat), "LeBron career playoffs".
- team_stats: "Celtics on the second night of back-to-backs", "Knicks at home this season".
- leaders: "who leads the league in steals", "top 10 scorers 2015-16" (stat + limit).
- player_rankings: "best centers", "top 5 guards last 10 games" (position; order worst for "worst").
- team_rankings: "best defense", "fastest pace", "worst offense" (stat = def_rtg / pace / off_rtg / net_rtg, order).
- matchups: "which teams give up the most points to centers", "how do the Lakers defend guards" (position, stat market, order, optional team). "worst defense vs X" = order worst (allows the most).
- props: "how often has Tatum gone over 26.5 points in his last 10", "Brunson points line tonight" (player, market, optional line, scope default last10).
- standings: "Knicks record", "who is first in the West", "standings 2019-20".
- game: "who won Celtics Heat", "Lakers score last night" (team, optional opponent, optional date).
- unsupported: predictions ("who will win"), betting advice ("should I bet"), injuries, trades, news, other sports, non-NBA. Set reason.

Examples:
"Jokic on the second night of back to backs this season" -> {kind:"player_stats", player:"Jokic", b2b:2}
"SGA last 10 games" -> {kind:"player_stats", player:"SGA", scope:"last10"}
"Warriors at altitude" -> {kind:"team_stats", team:"Warriors", altitude:true}
"most threes per game 2015-16" -> {kind:"leaders", stat:"fg3m", season:"2015-16"}
"worst defenses against point guards" -> {kind:"matchups", position:"G", stat:"pts", order:"worst"}
"has Edwards cleared 27.5 points lately" -> {kind:"props", player:"Edwards", market:"pts", line:27.5, scope:"last10"}
"Celtics vs Knicks last game" -> {kind:"game", team:"Celtics", opponent:"Knicks"}`;
}

const pick = (v, list) => (list.includes(v) ? v : undefined);
const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 60) : undefined);

/** Model output -> a plan we trust (unknown values dropped, never guessed). Pure; tested. */
export function normalizePlan(raw = {}) {
  const kind = pick(raw.kind, KINDS) ?? 'unsupported';
  const p = { kind };
  for (const k of ['player', 'team', 'opponent', 'reason']) if (clean(raw[k])) p[k] = clean(raw[k]);
  if (/^\d{4}-\d{2}$/.test(raw.season ?? '')) p.season = raw.season;
  else if (/^\d{4}$/.test(String(raw.season ?? ''))) { const y = Number(raw.season); p.season = `${y - 1}-${String(y % 100).padStart(2, '0')}`; }
  const set = (k, v) => { if (v !== undefined) p[k] = v; };
  set('season_type', pick(raw.season_type, ['regular', 'playoffs', 'play_in', 'all', 'cup']));
  set('scope', pick(raw.scope, ['season', 'last5', 'last10', 'career', 'game_log']));
  set('venue', pick(raw.venue, ['home', 'away']));
  set('b2b', pick(Number(raw.b2b), [1, 2]));
  set('rest', pick(String(raw.rest ?? ''), ['0', '1', '2', '3+']));
  set('rest_by', pick(raw.rest_by, ['player', 'team']));
  set('national_tv', pick(raw.national_tv, ['major', 'nba_tv', 'local']));
  if (typeof raw.altitude === 'boolean') p.altitude = raw.altitude;
  set('position', pick(String(raw.position ?? '').toUpperCase(), ['G', 'F', 'C']));
  set('order', pick(raw.order, ['best', 'worst']));
  set('market', pick(raw.market, MARKETS));
  if (typeof raw.line === 'number' && raw.line >= 0 && raw.line < 200) p.line = Math.round(raw.line * 2) / 2;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.date ?? '')) p.date = raw.date;
  if (Number.isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= 25) p.limit = raw.limit;
  const statList = { leaders: LEADER_STATS, team_rankings: TEAM_SORTS, matchups: MARKETS }[kind] ?? STAT_FOCUS;
  set('stat', pick(raw.stat, statList));
  // Kind-level requirements: a plan that can't run becomes a clear "what's missing".
  if (['player_stats', 'props'].includes(kind) && !p.player) return { kind: 'unsupported', reason: 'which player?' };
  if (['team_stats', 'game'].includes(kind) && !p.team) return { kind: 'unsupported', reason: 'which team?' };
  if (kind === 'props' && !p.market) p.market = p.stat && MARKETS.includes(p.stat) ? p.stat : 'pts';
  if (kind === 'leaders' && !p.stat) p.stat = 'pts';
  if (kind === 'matchups' && !p.stat) p.stat = 'pts';
  if (kind === 'matchups' && !p.position) p.position = 'G';
  if (kind === 'player_rankings' && !p.position) p.position = 'G';
  if (kind === 'team_rankings' && !p.stat) p.stat = 'net_rtg';
  if (kind === 'props' && !p.scope) p.scope = 'last10';
  return p;
}
