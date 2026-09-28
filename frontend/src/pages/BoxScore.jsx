import { Link, useLocation, useParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { gameContext, made, mins, pm, restLabel, SEASON_TYPE, shortDate, tinyDate, tipTime, tvLabel } from '../lib/format.js';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

export default function BoxScore() {
  const { id } = useParams();
  const location = useLocation();
  const { data, error, loading, retry } = useFetch(`game:${id}`, (signal) => api(`/games/${id}`, { signal }));
  const game = data?.data.game;
  const backDate = location.state?.from ?? game?.game_date_local;

  return (
    <>
      <Link to={backDate ? `/?date=${backDate}` : '/'} className="self-start text-sm font-medium">
        ← Scoreboard{backDate ? `, ${tinyDate(backDate)}` : ''}
      </Link>
      {loading && <Loading label="Loading box score…" />}
      {error && <ErrorBox error={error} onRetry={error.status === 404 ? undefined : retry} />}
      {data && <Game game={game} teams={data.data.teams} />}
    </>
  );
}

function Game({ game: g, teams }) {
  // Away team first (backend orders it that way), matching "AWAY @ HOME".
  const [away, home] = teams;
  const final = g.status === 'final';
  const winner = final ? (g.home_score > g.away_score ? home : away) : null;
  // Season type is already on the arena line; keep only the extra context (Cup, neutral city).
  const context = gameContext({ ...g, series_round: null }).split(' · ').filter((b) => b !== SEASON_TYPE[g.season_type] && b !== 'Play-In').join(' · ');
  const statusLine = final ? `Final · ${shortDate(g.game_date_local)}`
    : g.status === 'live' ? 'Live'
    : `${g.status === 'postponed' ? 'Postponed' : tipTime(g.tipoff_utc)} · ${shortDate(g.game_date_local)}`;

  const side = (t, score) => {
    const dim = final && t !== winner;
    return (
      <span className={`flex items-baseline gap-3 font-display ${dim ? 'font-semibold text-muted' : 'font-bold'}`}>
        <span className="text-[32px] sm:text-[40px]">{t.abbreviation}</span>
        {score != null && <span className="num text-[44px] leading-none sm:text-[56px]">{score}</span>}
      </span>
    );
  };

  return (
    <>
      <section aria-label="Result" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-card px-5 py-5 sm:px-7">
        <div className="flex flex-wrap items-baseline gap-x-4">
          {side(away, g.away_score)}
          <span className="px-1 text-lg text-muted">@</span>
          {side(home, g.home_score)}
        </div>
        <div className="flex flex-col gap-1.5 text-sm text-muted sm:items-end">
          <span className="font-semibold text-ink">{statusLine}</span>
          <span>{[g.arena && `${g.arena}, ${g.arena_city}`, SEASON_TYPE[g.season_type]].filter(Boolean).join(' · ')}</span>
          {context && <span>{context}</span>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold text-muted">Split tags:</span>
        {[away, home].map((t) => (
          <span key={t.team_id} className="rounded-full bg-rule px-2.5 py-1">
            {t.abbreviation}: {t.venue_split} · {restLabel(t.rest_days, t.b2b_night)}
          </span>
        ))}
        <span className={`rounded-full px-2.5 py-1 ${g.is_high_altitude ? 'bg-alt-bg text-alt-ink' : 'bg-rule'}`}>Altitude: {g.is_high_altitude ? 'yes' : 'no'}</span>
        <span className="rounded-full bg-rule px-2.5 py-1">{tvLabel(g.national_tv_tier, g.national_broadcasters)}</span>
      </div>

      {away.players.length === 0 && home.players.length === 0
        ? <Empty>{final ? 'No player box score in the source data for this game.' : 'The box score appears here once the game is played.'}</Empty>
        : [away, home].map((t) => <TeamTable key={t.team_id} t={t} />)}
    </>
  );
}

const COLS = [['Min', (p) => mins(p.minutes)], ['Pts', (p) => p.pts], ['Reb', (p) => p.reb], ['Ast', (p) => p.ast],
  ['FG', (p) => made(p.fgm, p.fga)], ['3PT', (p) => made(p.fg3m, p.fg3a)], ['FT', (p) => made(p.ftm, p.fta)],
  ['Stl', (p) => p.stl], ['Blk', (p) => p.blk], ['TO', (p) => p.tov], ['+/-', (p) => pm(p.plus_minus)]];

function TeamTable({ t }) {
  // Alignment is set per cell (never two text-* classes on one element).
  const th = 'border-b-2 border-strong px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted';
  const td = 'num border-b border-rule px-3 py-2 text-sm';
  const first = 'sticky left-0 z-10 bg-card text-left';
  const right = 'text-right';
  const anyStarter = t.players.some((p) => p.started);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-display text-[28px] font-bold">{t.full_name}</h2>
      <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr><th scope="col" className={`${th} ${first}`}>Player</th>{COLS.map(([h]) => <th key={h} scope="col" className={`${th} ${right}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {t.players.map((p) => (
              <tr key={p.player_id}>
                <th scope="row" className={`${td} ${first} font-medium`}>
                  {p.full_name}{p.started && <span className="ml-1.5 text-[11px] font-semibold text-accent" title="Starter">S</span>}
                </th>
                {p.dnp
                  ? <td colSpan={COLS.length} className={`${td} text-left italic text-muted`}>DNP{p.dnp_reason ? ` — ${p.dnp_reason}` : ''}</td>
                  : COLS.map(([h, f]) => <td key={h} className={`${td} ${right} ${h === 'Pts' ? 'font-semibold' : ''}`}>{f(p)}</td>)}
              </tr>
            ))}
            <tr className="font-semibold">
              <th scope="row" className={`${td} ${first} border-t-2 border-t-strong font-semibold`}>Totals</th>
              {COLS.map(([h, f]) => <td key={h} className={`${td} ${right} border-t-2 border-t-strong`}>{h === '+/-' ? '' : f(t)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
      {anyStarter && <p className="m-0 text-[13px] text-muted">S = starter</p>}
    </section>
  );
}
