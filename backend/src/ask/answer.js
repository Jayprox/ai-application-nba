// Plan (+ resolved ids) -> API requests -> one plain sentence, filter chips
// and a link to the full view. Every number in the sentence comes from the
// API response; nothing is written by the model. Pure except `run`.
import { MARKET_LABEL } from '../query/markets.js';

const STAT_LABEL = { pts: 'points', reb: 'rebounds', ast: 'assists', stl: 'steals', blk: 'blocks', tov: 'turnovers', fg3m: '3-pointers',
  minutes: 'minutes', plus_minus: 'plus-minus', fg_pct: 'FG%', fg3_pct: '3P%', ft_pct: 'FT%', ts_pct: 'true shooting %', efg_pct: 'effective FG%',
  off_rtg: 'offensive rating', def_rtg: 'defensive rating', net_rtg: 'net rating', pace: 'pace', usg_pct: 'usage rate' };
const POS = { G: 'guards', F: 'forwards', C: 'centers' };
const TYPE = { regular: 'regular season', playoffs: 'playoffs', play_in: 'play-in', all: 'all games', cup: 'NBA Cup' };
const PCT = new Set(['fg_pct', 'fg3_pct', 'ft_pct', 'ts_pct', 'efg_pct']);
const usg = (v) => `${(v * 100).toFixed(1)}%`;   // usage reads as a share of plays: 28.3%
const fmt = (k, v) => (v == null ? '—' : k === 'usg_pct' ? usg(v) : PCT.has(k) ? (v >= 1 ? '1.000' : `.${String(Math.round(v * 1000)).padStart(3, '0')}`) : Number(v).toFixed(1));
const num = (v) => (v == null ? '—' : Number(v).toFixed(1));   // per-game values: always one decimal (2.0, not 2)
const ord = (n) => { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`; };
const signed = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`);
const rankTypes = (t) => (['regular', 'playoffs', 'all'].includes(t) ? t : 'regular');

/** Default season when the plan doesn't name one; for a dated game, the season of that date. */
export function seasonFor(plan, ctx) {
  if (plan.season) return plan.season;
  if (plan.date) { const y = Number(plan.date.slice(0, 4)), m = Number(plan.date.slice(5, 7)); const s = m >= 8 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; }
  return ctx.latestSeason;
}

function splitsFor(plan, entity) {
  const byPlayer = entity === 'player' && plan.rest_by !== 'team';
  const s = {};
  if (plan.venue) s.venue = plan.venue;
  if (plan.b2b) s[byPlayer ? 'player_b2b' : 'b2b'] = plan.b2b;
  if (plan.rest) s[byPlayer ? 'player_rest' : 'rest'] = plan.rest === '3+' ? '3+' : Number(plan.rest);
  if (plan.national_tv) s.national_tv = plan.national_tv;
  if (plan.altitude !== undefined) s.altitude = plan.altitude;
  return s;
}

/** The first API request for a plan. Pure; tested. */
export function firstRequest(plan, ids, ctx) {
  const season = seasonFor(plan, ctx);
  const type = plan.season_type ?? 'regular';
  switch (plan.kind) {
    case 'player_stats': case 'team_stats': {
      const entity = plan.kind === 'player_stats' ? 'player' : 'team';
      const scope = plan.scope ?? 'season';
      const body = { entity, id: entity === 'player' ? ids.player.id : ids.team.id, scope, season_type: type, splits: splitsFor(plan, entity) };
      if (scope !== 'career') body.season = season;
      return { method: 'POST', path: '/query', body };
    }
    case 'leaders': return { method: 'POST', path: '/query', body: { scope: 'leaderboard', season, season_type: rankTypes(type), stat: plan.stat, limit: plan.limit ?? 10 } };
    case 'player_rankings': return { method: 'GET', path: `/rankings/players?season=${season}&season_type=${rankTypes(type)}&position=${plan.position}&scope=${plan.scope === 'last10' ? 'last10' : 'season'}&limit=200` };
    case 'team_rankings': return { method: 'GET', path: `/rankings/teams?season=${season}&season_type=${rankTypes(type)}&scope=${plan.scope === 'last10' ? 'last10' : 'season'}` };
    case 'matchups': return { method: 'GET', path: `/rankings/matchups?season=${season}&season_type=${rankTypes(type)}&scope=${plan.scope === 'last10' ? 'last10' : 'season'}` };
    case 'props': return { method: 'GET', path: `/players/${ids.player.id}/props` };
    case 'standings': return { method: 'GET', path: `/standings?season=${season}` };
    case 'game': return { method: 'POST', path: '/query', body: { entity: 'team', id: ids.team.id, scope: 'game_log', season, season_type: 'all' } };
    case 'series': return { method: 'GET', path: `/bracket?season=${season}` };
    default: return null;
  }
}

/** Filter chips (removable in the UI: removing one re-runs the plan without it). */
export function chips(plan, ctx) {
  const c = [];
  if (plan.kind === 'unsupported') return c;
  const season = seasonFor(plan, ctx);
  if (plan.scope !== 'career' && !['game'].includes(plan.kind)) c.push({ key: 'season', label: plan.season ? season : `${season} (latest)`, removable: Boolean(plan.season) });
  if (plan.season_type && plan.season_type !== 'regular') c.push({ key: 'season_type', label: TYPE[plan.season_type] });
  if (plan.scope && plan.scope !== 'season') c.push({ key: 'scope', label: { last5: 'Last 5', last10: 'Last 10', career: 'Career', game_log: 'Game log' }[plan.scope] });
  if (plan.venue) c.push({ key: 'venue', label: plan.venue === 'home' ? 'Home' : 'Away' });
  if (plan.b2b) c.push({ key: 'b2b', label: `Back-to-back night ${plan.b2b}` });
  if (plan.rest) c.push({ key: 'rest', label: `${plan.rest} days rest` });
  if (plan.rest_by === 'team') c.push({ key: 'rest_by', label: "Rest by team schedule" });
  if (plan.national_tv) c.push({ key: 'national_tv', label: { major: 'National TV', nba_tv: 'NBA TV', local: 'Local TV' }[plan.national_tv] });
  if (plan.altitude !== undefined) c.push({ key: 'altitude', label: plan.altitude ? 'At altitude' : 'Not at altitude' });
  if (plan.position) c.push({ key: 'position', label: POS[plan.position], removable: false });
  if (plan.line != null) c.push({ key: 'line', label: `Line ${plan.line}` });
  if (plan.opponent) c.push({ key: 'opponent', label: `vs ${plan.opponent}` });
  if (plan.date) c.push({ key: 'date', label: plan.date });
  return c.map((x) => ({ removable: true, ...x }));
}

/** "on the road on the second night of a back-to-back" */
export function filterPhrase(plan) {
  return [
    plan.venue === 'away' ? 'on the road' : plan.venue === 'home' ? 'at home' : null,
    plan.b2b === 2 ? 'on the second night of a back-to-back' : plan.b2b === 1 ? 'on the first night of a back-to-back' : null,
    plan.rest != null ? `on ${plan.rest} day${plan.rest === '1' ? '' : 's'}' rest` : null,
    plan.national_tv === 'major' ? 'on national TV' : plan.national_tv === 'nba_tv' ? 'on NBA TV' : plan.national_tv === 'local' ? 'on local TV' : null,
    plan.altitude === true ? 'at altitude' : plan.altitude === false ? 'away from altitude' : null,
  ].filter(Boolean).join(' ');
}

/** Link into the app's full view for this answer. */
export function appLink(plan, ids, ctx) {
  const season = seasonFor(plan, ctx);
  const qs = (o) => { const u = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')); const s = u.toString(); return s ? `?${s}` : ''; };
  const type = plan.season_type && plan.season_type !== 'regular' ? plan.season_type : undefined;
  const common = { season, type, scope: plan.scope && plan.scope !== 'season' ? plan.scope : undefined, venue: plan.venue, b2b: plan.b2b, rest: plan.rest,
    tv: plan.national_tv, alt: plan.altitude === undefined ? undefined : plan.altitude ? 'yes' : 'no' };
  switch (plan.kind) {
    case 'player_stats': return `/players/${ids.player.id}${qs({ ...common, restby: plan.rest_by === 'team' ? 'team' : undefined })}`;
    case 'props': return `/players/${ids.player.id}${qs({ season, scope: plan.scope && plan.scope !== 'season' ? plan.scope : undefined })}`;
    case 'team_stats': return `/teams/${ids.team.id}${qs(common)}`;
    case 'leaders': return `/leaders${qs({ season, type: type === 'playoffs' || type === 'all' ? type : undefined, stat: plan.stat })}`;
    case 'player_rankings': return `/rankings${qs({ season, pos: plan.position, scope: plan.scope === 'last10' ? 'last10' : undefined })}`;
    case 'team_rankings': return `/rankings${qs({ view: 'teams', season, sort: plan.stat, scope: plan.scope === 'last10' ? 'last10' : undefined })}`;
    case 'matchups': return `/rankings${qs({ view: 'matchups', season, pos: plan.position, sort: ['pts', 'reb', 'ast', 'fg3m'].includes(plan.stat) ? plan.stat : undefined, scope: plan.scope === 'last10' ? 'last10' : undefined })}`;
    case 'standings': return `/standings${qs({ season })}`;
    case 'series': return `/standings${qs({ season, view: 'bracket' })}`;
    default: return null;
  }
}

/**
 * API result(s) -> {sentence, view}. Pure; tested.
 * @param r  {main, props?, hits?}  API responses
 */
export function summarize(plan, ids, r, ctx) {
  const season = seasonFor(plan, ctx);
  const type = TYPE[plan.season_type ?? 'regular'];
  const where = plan.scope === 'career' ? `career ${type}` : `${season} ${type}`;
  const f = filterPhrase(plan);
  switch (plan.kind) {
    case 'player_stats': case 'team_stats': {
      const q = r.main, n = q.meta.sample_size, name = q.subject.name, isP = plan.kind === 'player_stats';
      const subj = isP ? name : `The ${name}`;
      if (!n) return { sentence: `No ${where} games for ${isP ? name : `the ${name}`}${f ? ` ${f}` : ''}.`, view: { type: 'stats', query: q } };
      const lastN = plan.scope === 'last5' || plan.scope === 'last10';
      const window = lastN
        ? `over ${isP ? 'his' : 'their'} last ${n} games${f ? ` ${f}` : ''}`
        : `in ${n} ${where} game${n === 1 ? '' : 's'}${f ? ` ${f}` : ''}`;
      const notes = [lastN ? where : null, isP && q.meta.record ? `his team went ${q.meta.record}` : null].filter(Boolean);
      const rec = notes.length ? ` (${notes.join('; ')})` : '';
      if (plan.scope === 'game_log') {
        const g = q.data[0];
        return { sentence: `${subj} played ${n} ${where} game${n === 1 ? '' : 's'}${f ? ` ${f}` : ''}; most recent ${g.date} ${g.venue === 'away' ? '@' : 'vs'} ${g.opponent}${isP ? `: ${g.pts} pts, ${g.reb} reb, ${g.ast} ast` : `: ${g.won ? 'W' : 'L'} ${g.pts}-${g.opp_pts}`}.`, view: { type: 'stats', query: q } };
      }
      const d = plan.scope === 'career' ? q.data.totals : q.data;
      if (plan.stat && d[plan.stat] !== undefined) {
        const v = fmt(plan.stat, d[plan.stat]), label = STAT_LABEL[plan.stat];
        const verb = PCT.has(plan.stat) || ['off_rtg', 'def_rtg', 'usg_pct'].includes(plan.stat) ? `had a ${label} of ${v}` : `averaged ${v} ${label}`;
        return { sentence: `${subj} ${verb} ${window}${rec}.`, view: { type: 'stats', query: q } };
      }
      return {
        sentence: isP
          ? `${subj} averaged ${fmt('pts', d.pts)} points, ${fmt('reb', d.reb)} rebounds and ${fmt('ast', d.ast)} assists ${window}${rec}.`
          : `${subj} went ${q.meta.record} ${window}${lastN ? ` (${where})` : ''}, scoring ${fmt('pts', d.pts)} and allowing ${fmt('pts', d.opp_pts)} per game.`,
        view: { type: 'stats', query: q },
      };
    }
    case 'leaders': {
      const rows = r.main.data;
      if (!rows.length) return { sentence: `No qualified players for ${where} yet.`, view: { type: 'leaders', rows, meta: r.main.meta } };
      const t = rows[0];
      const live = ctx.seasonInProgress && season === ctx.latestSeason;
      return { sentence: `${t.full_name} (${t.team}) ${live ? 'leads' : 'led'} the ${where} in ${STAT_LABEL[plan.stat]} at ${plan.stat === 'usg_pct' ? `${usg(t.value)} (est.)` : `${num(t.value)} per game`} over ${t.gp} games.`, view: { type: 'leaders', stat: plan.stat, rows, meta: r.main.meta } };
    }
    case 'player_rankings': {
      const rows = r.main.data, worst = plan.order === 'worst';
      const list = worst ? [...rows].reverse() : rows;
      if (!rows.length) return { sentence: `No qualified ${POS[plan.position]} for ${where}.`, view: { type: 'player_rankings', rows: [] } };
      const t = list[0];
      return { sentence: `${t.name} (${t.team}) ranks ${worst ? 'last' : 'first'} among ${rows.length} qualified ${POS[plan.position]} in the ${where}${plan.scope === 'last10' ? ' over their last 10 games' : ''} (score ${signed(t.score)}).`,
        view: { type: 'player_rankings', rows: list.slice(0, plan.limit ?? 10), position: plan.position } };
    }
    case 'team_rankings': {
      const rows = [...r.main.data].sort((a, b) => a.ranks[plan.stat] - b.ranks[plan.stat]);
      const list = plan.order === 'worst' ? rows.reverse() : rows;
      if (!list.length) return { sentence: `No games for ${where}.`, view: { type: 'team_rankings', rows: [] } };
      const t = list[0], label = STAT_LABEL[plan.stat];
      const adj = plan.stat === 'pace' ? (plan.order === 'worst' ? 'slowest' : 'fastest') : (plan.order === 'worst' ? 'worst' : 'best');
      return { sentence: `The ${t.name} have the ${adj} ${plan.stat === 'pace' ? 'pace' : label} in the ${where}: ${num(t[plan.stat])}${plan.stat === 'pace' ? ' possessions per game' : ' per 100 possessions'} (est.).`,
        view: { type: 'team_rankings', rows: list.slice(0, plan.limit ?? 10), stat: plan.stat } };
    }
    case 'matchups': {
      const all = r.main.data[plan.position] ?? [];
      const rows = [...all].sort((a, b) => (a.rank[plan.stat] ?? 99) - (b.rank[plan.stat] ?? 99));
      const label = MARKET_LABEL[plan.stat].toLowerCase();
      if (!rows.length) return { sentence: `No games for ${where}.`, view: { type: 'matchups', rows: [] } };
      if (ids.team) {
        const t = rows.find((x) => x.team_id === ids.team.id);
        if (!t) return { sentence: `No ${where} games for the ${ids.team.name}.`, view: { type: 'matchups', rows: [] } };
        return { sentence: `The ${ids.team.name} rank ${ord(t.rank[plan.stat])} of ${rows.length} against ${POS[plan.position]} in ${label} allowed: ${num(t.allowed[plan.stat])} per game (${signed(t.vs_avg[plan.stat])} vs league average, ${where}).`,
          view: { type: 'matchups', rows: [t], stat: plan.stat, position: plan.position } };
      }
      const list = plan.order === 'worst' ? [...rows].reverse() : rows;
      const t = list[0];
      return { sentence: `${t.abbr} allow the ${plan.order === 'worst' ? 'most' : 'fewest'} ${label} to ${POS[plan.position]}: ${num(t.allowed[plan.stat])} per game (${signed(t.vs_avg[plan.stat])} vs league average, ${where}).`,
        view: { type: 'matchups', rows: list.slice(0, plan.limit ?? 10), stat: plan.stat, position: plan.position } };
    }
    case 'props': {
      const up = r.main.data.upcoming, dk = up?.lines.find((l) => l.market === plan.market);
      const label = MARKET_LABEL[plan.market].toLowerCase();
      const parts = [];
      if (dk) parts.push(`DraftKings has ${ids.player.name} at ${dk.line} ${label} for ${up.game.away} @ ${up.game.home} (${up.game.date}).`);
      const h = r.hits?.props?.[plan.market];
      if (h?.games) {
        const scope = plan.scope === 'last5' || plan.scope === 'last10' ? `his last ${h.games} games` : `${h.games} ${where} games`;
        parts.push(`${dk ? 'He' : ids.player.name} went over ${h.line} ${dk ? '' : `${label} `}in ${h.over} of ${scope}${h.push ? ` (${h.push} push${h.push === 1 ? '' : 'es'})` : ''}${f ? ` ${f}` : ''}.`);
      } else if (h) parts.push(`No games match to check ${h.line} against.`);
      if (!parts.length) parts.push(`No DraftKings ${label} line for ${ids.player.name} yet. Ask with a number, e.g. "over ${plan.market === 'pts' ? '24.5' : '6.5'} ${label}".`);
      const rec = r.main.data.record?.[plan.market];
      return { sentence: parts.join(' '), view: { type: 'props', upcoming: up, record: rec ?? null, hits: h ?? null, market: plan.market } };
    }
    case 'standings': {
      const st = r.main.data;
      const all = [...(st.East ?? []), ...(st.West ?? [])];
      if (!all.length) return { sentence: `No standings for ${season}.`, view: { type: 'standings', rows: [] } };
      if (ids.team) {
        const t = all.find((x) => x.team_id === ids.team.id);
        return { sentence: `The ${t.name} ${season === ctx.latestSeason && ctx.seasonInProgress ? 'are' : 'finished'} ${t.wins}-${t.losses}, ${ord(t.rank)} in the ${t.conference}ern Conference (${season}).`, view: { type: 'standings', rows: [t] } };
      }
      const e = st.East[0], w = st.West[0];
      return { sentence: `${e.name} (${e.wins}-${e.losses}) ${ctx.seasonInProgress && season === ctx.latestSeason ? 'lead' : 'finished first in'} the East and ${w.name} (${w.wins}-${w.losses}) the West in ${season}.`, view: { type: 'standings', rows: [...st.East.slice(0, 6), ...st.West.slice(0, 6)] } };
    }
    case 'game': {
      const games = r.main.data.filter((g) => (!ids.opponent || g.opponent === ids.opponent.abbr) && (!plan.date || g.date === plan.date));
      const g = games[0];
      if (!g) return { sentence: `No finished ${season} game for the ${ids.team.name}${ids.opponent ? ` against the ${ids.opponent.name}` : ''}${plan.date ? ` on ${plan.date}` : ''}.`, view: { type: 'game', games: [] } };
      const us = ids.team.abbr, them = g.opponent;
      const [w, l, ws, ls] = g.won ? [us, them, g.pts, g.opp_pts] : [them, us, g.opp_pts, g.pts];
      const site = g.venue === 'home' ? `at ${us}` : g.venue === 'away' ? `at ${them}` : 'at a neutral site';
      return { sentence: `${w} beat ${l} ${ws}-${ls} on ${g.date} (${site}).`,
        view: { type: 'game', games: games.slice(0, 5).map((x) => ({ ...x, team: us })) }, link: `/games/${g.game_id}` };
    }
    case 'series': {
      const ROUND = { play_in: 'play-in', first_round: 'first round', conf_semis: 'conference semifinals', conf_finals: 'conference finals', finals: 'NBA Finals' };
      const ORDER = ['finals', 'conf_finals', 'conf_semis', 'first_round', 'play_in'];
      const all = [...r.main.data].sort((a, b) => ORDER.indexOf(a.round) - ORDER.indexOf(b.round));
      const has = (x, t) => t && (x.higher_id === t.id || x.lower_id === t.id);
      const list = all.filter((x) => (!ids.team || has(x, ids.team)) && (!ids.opponent || has(x, ids.opponent)));
      const x = list[0];
      if (!all.length) return { sentence: `No postseason games for ${season} yet.`, view: { type: 'series', rows: [] } };
      if (!x) return { sentence: ids.team ? `The ${ids.team.name} didn't play in the ${season} postseason${ids.opponent ? ` against the ${ids.opponent.name}` : ''}.` : `No ${season} series found.`, view: { type: 'series', rows: [] } };
      const done = x.winner_team_id != null;
      const [w, l, ww, lw] = x.winner_team_id === x.lower_id ? [x.lower_abbr, x.higher_abbr, x.lower_wins, x.higher_wins] : [x.higher_abbr, x.lower_abbr, x.higher_wins, x.lower_wins];
      const where = `the ${season} ${ROUND[x.round]}${x.conference && x.round !== 'finals' ? ` (${x.conference})` : ''}`;
      const sentence = !done ? `${x.higher_abbr} and ${x.lower_abbr} are ${x.higher_wins}-${x.lower_wins} in ${where}.`
        : x.round === 'play_in' && x.best_of === 1 ? `${w} beat ${l} in ${where}.`
          : `${w} beat ${l} ${ww}-${lw} in ${where}.`;
      const poss = (n) => (n.endsWith('s') ? `${n}'` : `${n}'s`);
      const lastSeries = ids.team && !ids.opponent && done && w !== ids.team.abbr;   // their deepest round, and they lost it
      return { sentence: lastSeries ? `${sentence.slice(0, -1)}, the ${poss(ids.team.name)} last series that postseason.` : sentence,
        view: { type: 'series', rows: list.slice(0, 5) } };
    }
    default: return { sentence: plan.reason ? `I can only answer NBA stats questions from the data here (${plan.reason}).` : 'I can only answer NBA stats questions from the data here.', view: { type: 'unsupported' } };
  }
}
