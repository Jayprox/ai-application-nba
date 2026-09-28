// Props board: DraftKings lines for one date, one market at a time, next to how
// often each player went over that exact line before. Counts, not picks.
// ?date=&market=&game=&sort= all live in the URL.
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { avg, isYmd, longDate, tinyDate, tipTime } from '../lib/format.js';
import { hits, MARKETS, movement, price, ratePct, RESULT, sortRows } from '../lib/props.js';
import { Select, Tabs } from '../components/Controls.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

const SORTS = [['l10', 'Last 10 over rate'], ['season', 'Season over rate'], ['line', 'Line (high to low)'], ['game', 'Game']];
const Chevron = ({ d }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export default function Props() {
  const [params, setParams] = useSearchParams();
  const date = isYmd(params.get('date')) ? params.get('date') : null;           // none: the server picks the next date with lines
  const market = MARKETS.some(([m]) => m === params.get('market')) ? params.get('market') : 'pts';
  const sort = SORTS.some(([s]) => s === params.get('sort')) ? params.get('sort') : 'l10';
  const set = (k, v, d) => setParams((prev) => { const n = new URLSearchParams(prev); v == null || v === d ? n.delete(k) : n.set(k, v); return n; }, { replace: k !== 'date' });

  const url = `/props?market=${market}${date ? `&date=${date}` : ''}`;
  const { data, error, loading, retry } = useFetch(`props:${url}`, (signal) => api(url, { signal }));
  const meta = data?.meta;
  const shown = meta?.date ?? date;
  const games = data?.games ?? [];
  const game = games.some((g) => g.id === params.get('game')) ? params.get('game') : 'all';
  const order = new Map(games.map((g, i) => [g.id, i]));
  const rows = sortRows((data?.data ?? []).filter((r) => game === 'all' || r.game_id === game), sort, order);
  const go = (d) => d && setParams((prev) => { const n = new URLSearchParams(prev); n.set('date', d); n.delete('game'); return n; });
  const btn = 'flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-field bg-card text-ink hover:border-ink disabled:cursor-not-allowed disabled:opacity-40';
  const closed = rows.filter((r) => r.snapshot === 'close').length;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="eyebrow">Props · DraftKings</div>
          <h1 className="m-0 font-display text-[34px] font-bold leading-tight sm:text-[44px]">{shown ? longDate(shown) : 'Props'}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={btn} disabled={!meta?.prev_date} onClick={() => go(meta.prev_date)}
            aria-label={meta?.prev_date ? `Previous date with lines, ${tinyDate(meta.prev_date, shown)}` : 'No earlier lines'}>
            <Chevron d="M15 18l-6-6 6-6" />
          </button>
          <label htmlFor="date" className="sr-only">Date</label>
          <input id="date" type="date" value={shown ?? ''} onChange={(e) => isYmd(e.target.value) && go(e.target.value)}
            className="h-11 rounded-lg border border-field bg-card px-3 text-[15px]" />
          <button type="button" className={btn} disabled={!meta?.next_date} onClick={() => go(meta.next_date)}
            aria-label={meta?.next_date ? `Next date with lines, ${tinyDate(meta.next_date, shown)}` : 'No later lines'}>
            <Chevron d="M9 18l6-6-6-6" />
          </button>
        </div>
      </div>

      <Tabs label="Market" value={market} options={MARKETS} onChange={(v) => set('market', v, 'pts')} />

      {loading && <Loading label="Loading lines…" />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <Select id="game" label="Game" value={game} onChange={(v) => set('game', v, 'all')}>
              <option value="all">All games ({games.length})</option>
              {games.map((g) => <option key={g.id} value={g.id}>{g.away} @ {g.home} · {g.status === 'final' ? 'Final' : g.status === 'live' ? 'Live' : tipTime(g.tipoff_utc)}</option>)}
            </Select>
            <Select id="sort" label="Sort by" value={sort} onChange={(v) => set('sort', v, 'l10')}>
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          {rows.length === 0
            ? <NoLines meta={meta} games={games} go={go} />
            : (
              <>
                <div className="num flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <strong className="text-lg">{meta.market_label} · {rows.length} player{rows.length === 1 ? '' : 's'}</strong>
                  <span className="text-sm text-muted">
                    {closed === rows.length ? 'Closing lines' : closed ? `Closing lines for ${closed} of ${rows.length}, opening lines for the rest` : 'Opening lines (closing lines come ~30 min before tip)'}
                  </span>
                </div>
                <Board rows={rows} />
              </>
            )}
          <ul className="m-0 flex list-none flex-col gap-1 border-t border-line p-0 pt-3 text-[13px] text-muted">
            {meta.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </>
      )}
    </>
  );
}

function NoLines({ meta, games, go }) {
  const link = 'cursor-pointer font-medium text-link underline hover:text-link-hover';
  const any = meta.prev_date || meta.next_date;
  return (
    <Empty>
      <p className="m-0 mb-3">
        {!any && meta.count === 0 && !games.length
          ? 'No prop lines yet. The worker pulls DraftKings lines on game days, starting with the regular season.'
          : games.length
            ? `No ${meta.market_label.toLowerCase()} lines for ${longDate(meta.date)} yet. Opening lines are pulled from 9 am ET on game day, closing lines about 30 minutes before tip.`
            : `No games with lines on ${longDate(meta.date)}.`}
      </p>
      <div className="flex flex-wrap gap-3">
        {meta.prev_date && <button type="button" className={link} onClick={() => go(meta.prev_date)}>← {tinyDate(meta.prev_date, meta.date)}</button>}
        {meta.next_date && <button type="button" className={link} onClick={() => go(meta.next_date)}>{tinyDate(meta.next_date, meta.date)} →</button>}
      </div>
    </Empty>
  );
}

const th = 'border-b-2 border-ink px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted whitespace-nowrap';
const td = 'num border-b border-rule px-3 py-2.5 text-sm whitespace-nowrap align-top';

const seasonOf = (r) => (r.season.games ? r.season : r.last_season);
const matchup = (r) => (r.team ? `${r.team} ${r.venue === 'home' ? 'vs' : '@'} ${r.opponent}` : '');
const Result = ({ r }) => (r.result
  ? <><div className="font-semibold">{RESULT[r.result]}</div>{r.actual != null && <div className="text-xs text-muted">{r.actual}</div>}</>
  : <span className="text-muted">{r.snapshot === 'close' ? 'Closing' : 'Opening'}</span>);

/** Phones: one card per player (the table needs ~760px). */
function Cards({ rows }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 sm:hidden">
      {rows.map((r) => {
        const mv = movement(r.open_line, r.line);
        const season = seasonOf(r);
        return (
          <li key={`${r.game_id}:${r.player_id}`} className="flex flex-col gap-2 rounded-[10px] border border-line bg-card px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link to={`/players/${r.player_id}`} className="font-semibold">{r.name}</Link>
                <div className="text-xs text-muted">{matchup(r)}</div>
              </div>
              <div className="num shrink-0 text-right">
                <div className="font-display text-2xl font-bold leading-none">{r.line}</div>
                <div className="text-xs text-muted">o{price(r.over_price)} / u{price(r.under_price)}{mv ? ` · ${mv.dir === 'up' ? '▲' : '▼'} ${r.open_line}` : ''}</div>
              </div>
            </div>
            <dl className="num m-0 grid grid-cols-4 gap-2 border-t border-rule pt-2 text-sm">
              <div><dt className="eyebrow">Last 10</dt><dd className="m-0 font-semibold">{hits(r.last10)}</dd></div>
              <div><dt className="eyebrow">{season === r.last_season && season?.games ? 'Last szn' : 'Season'}</dt><dd className="m-0 font-semibold">{hits(season)}</dd></div>
              <div><dt className="eyebrow">Avg</dt><dd className="m-0">{avg(season?.avg)}</dd></div>
              <div className="text-right"><dt className="eyebrow">Result</dt><dd className="m-0"><Result r={r} /></dd></div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function Board({ rows }) {
  return (
    <>
    <Cards rows={rows} />
    <div className="hidden overflow-x-auto rounded-[10px] border border-line bg-card sm:block">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr>
            <th scope="col" className={`${th} sticky left-0 z-10 bg-card text-left`}>Player</th>
            <th scope="col" className={`${th} text-right`}>Line</th>
            <th scope="col" className={`${th} text-right`} title="Games over this line, of his last 10">Last 10</th>
            <th scope="col" className={`${th} text-right`} title="Games over this line this season">Season</th>
            <th scope="col" className={`${th} text-right`} title="His season average in this stat">Avg</th>
            <th scope="col" className={`${th} text-right`}>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const mv = movement(r.open_line, r.line);
            const season = seasonOf(r);
            return (
              <tr key={`${r.game_id}:${r.player_id}`}>
                <th scope="row" className={`${td} sticky left-0 z-10 bg-card text-left font-normal`}>
                  <Link to={`/players/${r.player_id}`} className="font-semibold">{r.name}</Link>
                  <div className="text-xs text-muted">{matchup(r)}</div>
                </th>
                <td className={`${td} text-right`}>
                  <div className="font-display text-xl font-bold leading-none">{r.line}</div>
                  <div className="text-xs text-muted" title={`Over ${price(r.over_price)} · Under ${price(r.under_price)}`}>
                    o{price(r.over_price)} / u{price(r.under_price)}
                  </div>
                  {mv && <div className="text-xs text-muted" title={`Opened at ${r.open_line}`}>{mv.dir === 'up' ? '▲' : '▼'} from {r.open_line}</div>}
                </td>
                <td className={`${td} text-right`}><div className="font-semibold">{hits(r.last10)}</div><div className="text-xs text-muted">{ratePct(r.last10)}</div></td>
                <td className={`${td} text-right`}>
                  <div className="font-semibold">{hits(season)}</div>
                  <div className="text-xs text-muted">{season === r.last_season && season?.games ? 'last season' : ratePct(season)}</div>
                </td>
                <td className={`${td} text-right`}>{avg(season?.avg)}</td>
                <td className={`${td} text-right`}><Result r={r} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
