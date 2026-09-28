// Scope tabs + season/season-type + split filters over ONE POST /query.
// Shared by Player Detail and Team Detail. Every control lives in the URL
// (?season=&type=&scope=&venue=...), so views are shareable and Back works.
// Players with DraftKings lines for their next game also get a "Prop check":
// how often he went over each line in exactly the games the filters select.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { SEASON_TYPE_OPTIONS } from '../lib/seasons.js';
import { ago, avg, made, mins, pct, pm, SEASON_TYPE_LOWER, signedAvg, tinyDate, tipTime } from '../lib/format.js';
import { MARKETS, MARKET_SHORT, price, RESULT } from '../lib/props.js';

const MARKET_ORDER = MARKETS.map(([m]) => m);
import { Pills, Select, Tabs } from './Controls.jsx';
import { Empty, ErrorBox, Loading } from './States.jsx';

const SCOPES = [['season', 'Season Avg'], ['last5', 'Last 5'], ['last10', 'Last 10'], ['career', 'Career'], ['game_log', 'Game Log']];
const SCOPE_LABEL = { season: 'Season average', last5: 'Last 5 games', last10: 'Last 10 games', career: 'Career', game_log: 'Game log' };
const SPLITS = [
  ['venue', 'Venue', [['all', 'All'], ['home', 'Home'], ['away', 'Away']]],
  ['b2b', 'Back-to-back', [['all', 'All'], ['1', 'Night 1'], ['2', 'Night 2']]],
  ['rest', 'Rest days', [['all', 'All'], ['0', '0'], ['1', '1'], ['2', '2'], ['3+', '3+']]],
  ['tv', 'National TV', [['all', 'All'], ['major', 'Major'], ['nba_tv', 'NBA TV'], ['local', 'Local']]],
  ['alt', 'Altitude', [['all', 'All'], ['yes', 'At altitude'], ['no', 'Not']]],
];
const SPLIT_KEYS = SPLITS.map(([k]) => k);

/** URL params -> POST /query body (+ prop lines to grade, averaged scopes only). Exported for tests. */
export function buildQuery(entity, id, p, lines = null) {
  const byPlayer = entity === 'player' && p.restby !== 'team';
  const splits = {};
  if (p.venue) splits.venue = p.venue;
  if (p.b2b) splits[byPlayer ? 'player_b2b' : 'b2b'] = Number(p.b2b);
  if (p.rest) splits[byPlayer ? 'player_rest' : 'rest'] = p.rest === '3+' ? '3+' : Number(p.rest);
  if (p.tv) splits.national_tv = p.tv;
  if (p.alt) splits.altitude = p.alt === 'yes';
  const body = { entity, id, scope: p.scope, season_type: p.type, splits };
  if (p.scope !== 'career') body.season = p.season;
  if (entity === 'player' && lines && Object.keys(lines).length && p.scope !== 'game_log') body.lines = lines;
  return body;
}

export default function StatExplorer({ entity, id, name, seasons, seasonTypes = {}, defaultSeason, props = null }) {
  const [params, setParams] = useSearchParams();
  const get = (k, d) => params.get(k) ?? d;
  const p = {
    season: seasons.includes(get('season')) ? get('season') : defaultSeason,
    type: SEASON_TYPE_OPTIONS.some(([v]) => v === get('type')) ? get('type') : 'regular',
    scope: SCOPES.some(([v]) => v === get('scope')) ? get('scope') : 'season',
    restby: get('restby') === 'team' ? 'team' : 'player',
  };
  for (const [k, , opts] of SPLITS) { const v = get(k); p[k] = opts.some(([o]) => o === v && o !== 'all') ? v : null; }
  const splitCount = SPLIT_KEYS.filter((k) => p[k]).length;
  const [showSplits, setShowSplits] = useState(false); // phones: splits panel folds away

  const set = (k, v) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v == null || v === 'all' || (k === 'type' && v === 'regular') || (k === 'scope' && v === 'season') || (k === 'restby' && v === 'player')) next.delete(k);
    else next.set(k, v);
    return next;
  }, { replace: true });
  const clear = () => setParams((prev) => { const n = new URLSearchParams(prev); SPLIT_KEYS.forEach((k) => n.delete(k)); return n; }, { replace: true });

  const upcoming = props?.upcoming ?? null;
  const lines = upcoming ? Object.fromEntries(upcoming.lines.map((l) => [l.market, l.line])) : null;
  // props === undefined: the player's lines are still loading — wait, so the query runs once, with them.
  const body = defaultSeason && props !== undefined ? buildQuery(entity, id, p, lines) : null;
  const key = body ? JSON.stringify(body) : null;
  const { data, error, loading, retry } = useFetch(key, (signal) => api('/query', { method: 'POST', body, signal }));
  const meta = data?.meta;
  const where = p.scope === 'career' ? SEASON_TYPE_LOWER[p.type] : `${p.season} ${SEASON_TYPE_LOWER[p.type]}`;

  return (
    <section aria-label="Stats" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Select id="season" label="Season" value={p.season ?? ''} onChange={(v) => set('season', v)} className={p.scope === 'career' ? 'opacity-50' : ''}>
          {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold">Season type</span>
          <Pills label="Season type" value={p.type} options={SEASON_TYPE_OPTIONS} onChange={(v) => set('type', v)} />
        </div>
      </div>

      <Tabs label="Scope" value={p.scope} options={SCOPES} onChange={(v) => set('scope', v)} />

      <button type="button" aria-expanded={showSplits} aria-controls="splits" onClick={() => setShowSplits((v) => !v)}
        className="flex h-11 cursor-pointer items-center justify-between rounded-lg border border-field bg-card px-4 text-[15px] font-semibold sm:hidden">
        <span>Splits{splitCount ? ` · ${splitCount} applied` : ''}</span><span aria-hidden="true">{showSplits ? '▴' : '▾'}</span>
      </button>
      <div id="splits" className={`${showSplits ? 'flex' : 'hidden'} flex-col gap-3 rounded-[10px] border border-line bg-card p-4 sm:flex`}>
        {entity === 'player' && (
          <SplitRow label="Rest measured by">
            <Pills size="sm" label="Rest measured by" value={p.restby} onChange={(v) => set('restby', v)}
              options={[['player', "His games"], ['team', "Team's schedule"]]} />
          </SplitRow>
        )}
        {SPLITS.map(([k, label, opts]) => (
          <SplitRow key={k} label={label}>
            <Pills size="sm" label={label} value={p[k] ?? 'all'} options={opts} onChange={(v) => set(k, v)} />
          </SplitRow>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3 text-[13px] text-muted">
          <span>
            {entity === 'player' && p.restby === 'player'
              ? 'Rest and back-to-back count the games he played (how NBA.com splits players).'
              : 'Rest and back-to-back follow the team schedule.'}
            {' '}Splits apply first, then Last 5 / Last 10.
          </span>
          <button type="button" onClick={clear} disabled={!splitCount}
            className="h-9 cursor-pointer rounded-lg border border-field bg-card px-3 text-sm font-medium text-ink hover:border-ink disabled:cursor-default disabled:opacity-40">
            Clear splits{splitCount ? ` (${splitCount})` : ''}
          </button>
        </div>
      </div>

      {(loading || props === undefined) && <Loading label="Crunching…" />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (
        <>
          <div className="num flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="text-lg">{SCOPE_LABEL[p.scope]} · {meta.sample_size} game{meta.sample_size === 1 ? '' : 's'}</strong>
            <span className="text-sm text-muted">
              {meta.sample_size > 0 && meta.record ? `${meta.record} in these games · ` : ''}{where}{splitCount ? ` · ${splitCount} split${splitCount === 1 ? '' : 's'} applied` : ''}
            </span>
          </div>
          {meta.notes.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-muted">{meta.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          )}
          {meta.sample_size === 0
            ? <NoGames name={name} p={p} where={where} splitCount={splitCount} played={p.scope === 'career' ? null : seasonTypes[p.season]}
                onType={(v) => set('type', v)} onClear={clear} />
            : p.scope === 'career' ? <><PropCheck upcoming={upcoming} hits={data.props} record={props?.record} /><Career entity={entity} data={data.data} /></>
            : p.scope === 'game_log' ? <GameLog entity={entity} rows={data.data} restby={p.restby} />
            : <><PropCheck upcoming={upcoming} hits={data.props} record={props?.record} /><Tiles entity={entity} d={data.data} /></>}
          <p className="m-0 border-t border-line pt-3 text-[13px] text-muted">
            From NBA.com game logs{meta.freshness?.synced_at ? ` · synced ${ago(meta.freshness.synced_at)}` : ''}{meta.cached ? ' · cached' : ''}
          </p>
        </>
      )}
    </section>
  );
}

const TYPE_NAME = { regular: 'regular season', play_in: 'play-in', playoffs: 'playoffs', cup: 'NBA Cup' };
const TYPE_BUTTON = { regular: 'Regular season', play_in: 'Play-In', playoffs: 'Playoffs', cup: 'NBA Cup' };

/** Why there are no games, in plain words, with the one-click way out. Exported for tests. */
export function NoGames({ name, p, where, splitCount, played, onType, onClear }) {
  const Name = name[0].toUpperCase() + name.slice(1);                  // "the Golden State Warriors" at sentence start
  const possessive = name.endsWith('s') ? `${name}'` : `${name}'s`;    // "Warriors'", "Curry's"
  const link = 'cursor-pointer font-medium text-link underline hover:text-link-hover';
  if (p.type === 'cup' && p.scope !== 'career' && p.season < '2023-24') return <Empty>The NBA Cup started in 2023-24, so there are no Cup games in {p.season}.</Empty>;
  // A game type he/they simply didn't play that season (e.g. Curry, 2025-26 playoffs: GSW lost in the play-in).
  if (!splitCount && played && p.type !== 'all' && !played.includes(p.type)) {
    const other = played.filter((t) => TYPE_NAME[t]);
    return (
      <Empty>
        <p className="m-0 mb-3">{Name} didn't play in the {p.season} {TYPE_NAME[p.type]}.
          {other.length ? ` Games that season: ${other.map((t) => TYPE_NAME[t]).join(', ')}.` : ''}</p>
        <div className="flex flex-wrap gap-4">
          {other.map((t) => <button key={t} type="button" className={link} onClick={() => onType(t)}>Show {TYPE_BUTTON[t]}</button>)}
        </div>
      </Empty>
    );
  }
  if (splitCount) {
    return (
      <Empty>
        <p className="m-0 mb-3">None of {possessive} {where} games match {splitCount === 1 ? 'this split' : 'these splits'}.</p>
        <button type="button" className={link} onClick={onClear}>Clear splits</button>
      </Empty>
    );
  }
  return <Empty>No games for {name} in the {where}.</Empty>;
}

/** Next game's DraftKings lines, graded over the games on screen (filters + scope). Exported for tests. */
export function PropCheck({ upcoming, hits, record }) {
  const rec = Object.entries(record ?? {}).sort(([a], [b]) => MARKET_ORDER.indexOf(a) - MARKET_ORDER.indexOf(b));
  if (!upcoming && !rec.length) return null;
  const g = upcoming?.game;
  return (
    <section aria-label="Prop check" className="flex flex-col gap-3 rounded-[10px] border border-line bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="eyebrow m-0">Prop check{g ? ` · ${g.away} @ ${g.home} · ${tinyDate(g.date)} ${g.status === 'live' ? '(live)' : tipTime(g.tipoff_utc)}` : ''}</h3>
        <span className="text-xs text-muted">DraftKings{upcoming ? ` · ${upcoming.lines.some((l) => l.snapshot === 'close') ? 'closing' : 'opening'} lines` : ''}</span>
      </div>
      {upcoming && (
        <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-6">
          {upcoming.lines.map((l) => {
            const h = hits?.[l.market];
            return (
              <li key={l.market} className="flex flex-col gap-0.5 rounded-lg border border-rule px-3 py-2" title={`${l.label}: over ${price(l.over_price)} / under ${price(l.under_price)}${l.open_line != null && l.open_line !== l.line ? ` · opened ${l.open_line}` : ''}`}>
                <span className="eyebrow">{MARKET_SHORT[l.market]} {l.line}</span>
                <span className="num text-[15px]">{h?.games ? <><strong>Over {h.over}</strong> of {h.games}{h.push ? ` · ${h.push} push` : ''}</> : <span className="text-muted">no games</span>}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 text-xs text-muted">
        {upcoming ? 'Counts use the games selected above (season, type, splits, last N). ' : ''}
        {rec.length ? `Vs. his past DraftKings lines (over–under${rec.some(([, r]) => r.push) ? '–push' : ''}): ${rec.map(([m, r]) => `${MARKET_SHORT[m]} ${r.over}–${r.under}${r.push ? `–${r.push}` : ''}`).join(' · ')}.` : ''}
      </p>
    </section>
  );
}

const SplitRow = ({ label, children }) => (
  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
    <span className="w-36 shrink-0 text-[13px] font-semibold text-muted">{label}</span>
    {children}
  </div>
);

function Tiles({ entity, d }) {
  const tiles = entity === 'player'
    ? [['Points', avg(d.pts)], ['Rebounds', avg(d.reb)], ['Assists', avg(d.ast)], ['3PM', avg(d.fg3m)], ['FG%', pct(d.fg_pct)],
      ['Steals', avg(d.stl)], ['Blocks', avg(d.blk)], ['Turnovers', avg(d.tov)], ['Minutes', avg(d.minutes)], ['+/-', signedAvg(d.plus_minus)]]
    : [['Points', avg(d.pts)], ['Opp points', avg(d.opp_pts)], ['Rebounds', avg(d.reb)], ['Assists', avg(d.ast)], ['3PM', avg(d.fg3m)],
      ['FG%', pct(d.fg_pct)], ['3P%', pct(d.fg3_pct)], ['Steals', avg(d.stl)], ['Blocks', avg(d.blk)], ['Turnovers', avg(d.tov)]];
  // Efficiency row: all computed from the same games (sums, as NBA.com does).
  const adv = entity === 'player'
    ? [['TS%', pct(d.ts_pct), 'True shooting: points per shot, counting 3s and free throws'], ['eFG%', pct(d.efg_pct), 'Effective FG%: a 3 counts 1.5 makes'],
      ['FT rate', pct(d.ft_rate), 'Free-throw attempts per field-goal attempt'], ['Pts / 36', avg(d.pts_per36), 'Points per 36 minutes'],
      ['Reb / 36', avg(d.reb_per36), 'Rebounds per 36 minutes'], ['Ast / 36', avg(d.ast_per36), 'Assists per 36 minutes']]
    : [['Off rtg (est.)', avg(d.off_rtg), 'Points per 100 possessions (possessions estimated from the box score)'],
      ['Def rtg (est.)', avg(d.def_rtg), 'Opponent points per 100 possessions (estimated)'],
      ['Net rtg (est.)', d.off_rtg == null || d.def_rtg == null ? '—' : signedAvg(d.off_rtg - d.def_rtg), 'Off rtg minus def rtg'],
      ['TS%', pct(d.ts_pct), 'True shooting'], ['eFG%', pct(d.efg_pct), 'Effective FG%']];
  const tile = ([k, v, hint]) => (
    <div key={k} className="flex flex-col gap-0.5 rounded-[10px] border border-line bg-card px-4 py-3" title={hint}>
      <span className="eyebrow">{k}</span>
      <span className="num font-display text-[36px] font-bold leading-tight">{v}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{tiles.map(tile)}</div>
      <section aria-label="Efficiency" className="flex flex-col gap-2">
        <h3 className="eyebrow m-0">Efficiency</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{adv.map(tile)}</div>
      </section>
    </div>
  );
}

// ---- tables -----------------------------------------------------------------
const th = 'border-b-2 border-ink px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted whitespace-nowrap';
const td = 'num border-b border-rule px-3 py-2 text-sm whitespace-nowrap';
const L = 'text-left', R = 'text-right';
const sticky = 'sticky left-0 z-10 bg-card';

function Table({ head, children, minWidth = 760 }) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
      <table className="w-full border-collapse" style={{ minWidth }}>
        <thead><tr>{head.map(([h, align], i) => <th key={h + i} scope="col" className={`${th} ${align} ${i === 0 ? sticky : ''}`}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function tags(r, restby) {
  const rest = restby === 'player' && r.player_rest_days !== undefined ? r.player_rest_days : r.rest_days;
  const b2b = restby === 'player' && r.player_b2b_night !== undefined ? r.player_b2b_night : r.b2b_night;
  return [
    r.season_type !== 'regular' ? { play_in: 'Play-In', playoffs: 'Playoffs', cup_final: 'Cup Final' }[r.season_type] : null,
    r.venue === 'neutral' ? 'Neutral site' : null,
    b2b ? `B2B night ${b2b}` : null,
    rest != null ? `${rest}d rest` : null,
    r.altitude ? 'Altitude' : null,
    r.national_tv_tier === 'major' ? 'National TV' : r.national_tv_tier === 'nba_tv' ? 'NBA TV' : null,
  ].filter(Boolean).join(' · ');
}

const opp = (r) => `${r.venue === 'home' ? 'vs' : r.venue === 'away' ? '@' : 'vs'} ${r.opponent}`;

function GameLog({ entity, rows, restby }) {
  if (entity === 'team') {
    return (
      <Table minWidth={620} head={[['Date', L], ['Opp', L], ['Result', L], ['Tags', L]]}>
        {rows.map((r) => (
          <tr key={r.game_id}>
            <td className={`${td} ${L} ${sticky}`}><Link to={`/games/${r.game_id}`}>{tinyDate(r.date)}</Link></td>
            <td className={`${td} ${L}`}>{opp(r)}</td>
            <td className={`${td} ${L} font-semibold`}>{r.won ? 'W' : 'L'} {r.pts}-{r.opp_pts}</td>
            <td className={`${td} ${L} text-[13px] text-muted`}>{tags(r, 'team')}</td>
          </tr>
        ))}
      </Table>
    );
  }
  return (
    <Table minWidth={960} head={[['Date', L], ['Opp', L], ['Result', L], ['Min', R], ['Pts', R], ['Reb', R], ['Ast', R], ['3PM', R], ['FG', R], ['+/-', R], ['Pts line', R], ['Tags', L]]}>
      {rows.map((r) => (
        <tr key={r.game_id}>
          <td className={`${td} ${L} ${sticky}`}><Link to={`/games/${r.game_id}`}>{tinyDate(r.date)}</Link></td>
          <td className={`${td} ${L}`}>{opp(r)}</td>
          <td className={`${td} ${L}`}>{r.won ? 'W' : 'L'}</td>
          <td className={`${td} ${R}`}>{mins(r.minutes)}</td>
          <td className={`${td} ${R} font-semibold`}>{r.pts}</td>
          <td className={`${td} ${R}`}>{r.reb}</td>
          <td className={`${td} ${R}`}>{r.ast}</td>
          <td className={`${td} ${R}`}>{r.fg3m}</td>
          <td className={`${td} ${R}`}>{made(r.fgm, r.fga)}</td>
          <td className={`${td} ${R}`}>{pm(r.plus_minus)}</td>
          <td className={`${td} ${R}`} title={r.props ? Object.entries(r.props).map(([m, x]) => `${MARKET_SHORT[m]} ${x.line}: ${RESULT[x.result] ?? '—'}`).join(' · ') : undefined}>
            {r.props?.pts ? <>{r.props.pts.line} <span className="text-xs text-muted">{r.props.pts.result === 'over' ? 'O' : r.props.pts.result === 'under' ? 'U' : r.props.pts.result === 'push' ? 'P' : ''}</span></> : r.props ? <span className="text-xs text-muted">lines</span> : ''}
          </td>
          <td className={`${td} ${L} text-[13px] text-muted`}>{tags(r, restby)}</td>
        </tr>
      ))}
    </Table>
  );
}

function Career({ entity, data }) {
  const rows = [...data.by_season].reverse();
  const tot = data.totals;
  if (entity === 'team') {
    const head = [['Season', L], ['GP', R], ['Pts', R], ['Opp', R], ['Reb', R], ['Ast', R], ['3PM', R], ['FG%', R], ['3P%', R], ['TS%', R], ['Net', R]];
    const cells = (r) => [r.gp, avg(r.pts), avg(r.opp_pts), avg(r.reb), avg(r.ast), avg(r.fg3m), pct(r.fg_pct), pct(r.fg3_pct), pct(r.ts_pct),
      r.off_rtg == null || r.def_rtg == null ? '—' : signedAvg(r.off_rtg - r.def_rtg)];
    return (
      <Table minWidth={760} head={head}>
        {rows.map((r) => <tr key={r.season}><td className={`${td} ${L} ${sticky}`}>{r.season}</td>{cells(r).map((c, i) => <td key={i} className={`${td} ${R}`}>{c}</td>)}</tr>)}
        <tr className="font-semibold"><td className={`${td} ${L} ${sticky} border-t-2 border-t-ink`}>All seasons</td>{cells(tot).map((c, i) => <td key={i} className={`${td} ${R} border-t-2 border-t-ink`}>{c}</td>)}</tr>
      </Table>
    );
  }
  const head = [['Season', L], ['Team', L], ['GP', R], ['Min', R], ['Pts', R], ['Reb', R], ['Ast', R], ['3PM', R], ['Stl', R], ['Blk', R], ['TO', R], ['FG%', R], ['TS%', R]];
  const cells = (r) => [r.gp, avg(r.minutes), avg(r.pts), avg(r.reb), avg(r.ast), avg(r.fg3m), avg(r.stl), avg(r.blk), avg(r.tov), pct(r.fg_pct), pct(r.ts_pct)];
  return (
    <Table minWidth={920} head={head}>
      {rows.map((r) => (
        <tr key={r.season}>
          <td className={`${td} ${L} ${sticky}`}>{r.season}</td><td className={`${td} ${L}`}>{r.team}</td>
          {cells(r).map((c, i) => <td key={i} className={`${td} ${R} ${i === 2 ? 'font-semibold' : ''}`}>{c}</td>)}
        </tr>
      ))}
      <tr className="font-semibold">
        <td className={`${td} ${L} ${sticky} border-t-2 border-t-ink`}>Career</td><td className={`${td} border-t-2 border-t-ink`} />
        {cells(tot).map((c, i) => <td key={i} className={`${td} ${R} border-t-2 border-t-ink`}>{c}</td>)}
      </tr>
    </Table>
  );
}
