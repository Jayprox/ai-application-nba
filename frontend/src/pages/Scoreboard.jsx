import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { gameContext, isYmd, longDate, SEASON_TYPE, tinyDate, tipTime, todayLocal } from '../lib/format.js';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

const Chevron = ({ d }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export default function Scoreboard() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('date');
  const date = isYmd(raw) ? raw : todayLocal();
  const { data, error, loading, retry } = useFetch(`games:${date}`, (signal) => api(`/games?date=${date}`, { signal }));
  const go = (d) => d && setParams({ date: d });

  const games = data?.data ?? [];
  const meta = data?.meta;
  const first = games[0];
  const btn = 'flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-field bg-card text-ink hover:border-muted disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="eyebrow">{first ? `${first.season} · ${SEASON_TYPE[first.season_type]}` : 'Scoreboard'}</div>
          <h1 className="m-0 font-display text-[34px] font-bold leading-tight sm:text-[44px]">{longDate(date)}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={btn} aria-label={meta?.prev_date ? `Previous game day, ${tinyDate(meta.prev_date, date)}` : 'No earlier games'}
            title={meta?.prev_date ? `Previous game day: ${tinyDate(meta.prev_date, date)}` : undefined} disabled={!meta?.prev_date} onClick={() => go(meta.prev_date)}>
            <Chevron d="M15 18l-6-6 6-6" />
          </button>
          <label htmlFor="date" className="sr-only">Date</label>
          <input id="date" type="date" value={date} onChange={(e) => isYmd(e.target.value) && go(e.target.value)}
            className="h-11 rounded-lg border border-field bg-card px-3 text-[15px]" />
          <button type="button" className={btn} aria-label={meta?.next_date ? `Next game day, ${tinyDate(meta.next_date, date)}` : 'No later games'}
            title={meta?.next_date ? `Next game day: ${tinyDate(meta.next_date, date)}` : undefined} disabled={!meta?.next_date} onClick={() => go(meta.next_date)}>
            <Chevron d="M9 18l6-6-6-6" />
          </button>
        </div>
      </div>

      {loading && <Loading label="Loading games…" />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && games.length === 0 && (
        <Empty>
          <p className="m-0 mb-3">No NBA games on {longDate(date)}.</p>
          <div className="flex flex-wrap gap-3">
            {meta.prev_date && <button type="button" className="cursor-pointer font-medium text-link underline hover:text-link-hover" onClick={() => go(meta.prev_date)}>← Previous game day ({tinyDate(meta.prev_date, date)})</button>}
            {meta.next_date && <button type="button" className="cursor-pointer font-medium text-link underline hover:text-link-hover" onClick={() => go(meta.next_date)}>Next game day ({tinyDate(meta.next_date, date)}) →</button>}
          </div>
        </Empty>
      )}
      {games.length > 0 && (
        <>
          <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => <li key={g.id}><GameCard g={g} date={date} /></li>)}
          </ul>
          <p className="m-0 border-t border-line pt-3 text-[13px] text-muted">
            {games.length} game{games.length === 1 ? '' : 's'} · tip-off times in your time zone
          </p>
        </>
      )}
    </>
  );
}

function GameCard({ g, date }) {
  const final = g.status === 'final';
  const status = final ? 'Final' : g.status === 'live' ? 'Live' : g.status === 'postponed' ? 'Postponed' : g.status === 'cancelled' ? 'Cancelled' : tipTime(g.tipoff_utc);
  const awayWon = final && g.away_score > g.home_score;
  const homeWon = final && g.home_score > g.away_score;
  const context = gameContext(g);
  const tv = g.national_tv_tier !== 'local' && g.national_broadcasters?.length ? g.national_broadcasters.join(', ') : null;
  const row = (team, score, won) => (
    <div className={`num flex justify-between text-xl ${won ? 'font-bold' : final ? 'font-normal text-muted' : 'font-medium'}`}>
      <span>{team}</span><span>{score ?? ''}</span>
    </div>
  );
  return (
    <Link to={`/games/${g.id}`} state={{ from: date }}
      className={`flex h-full flex-col gap-2.5 rounded-[10px] bg-card px-[18px] py-4 text-ink no-underline hover:border-link hover:text-ink ${final ? 'border-2 border-strong' : 'border border-line'}`}>
      <div className="eyebrow flex justify-between">
        <span className={g.status === 'live' ? 'text-live' : ''}>{status}</span>
        <span className="text-link">{final ? 'Box score →' : 'Preview →'}</span>
      </div>
      {row(g.away, g.away_score, awayWon)}
      {row(g.home, g.home_score, homeWon)}
      {(context || tv) && (
        <div className="flex flex-wrap justify-between gap-x-3 text-[13px] text-muted">
          <span>{context}</span>{tv && <span>{tv}</span>}
        </div>
      )}
    </Link>
  );
}
