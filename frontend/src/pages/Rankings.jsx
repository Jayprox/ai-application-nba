// Rankings: players by position (composite score), team units (ratings), and
// matchups (what each defense allows by position). Plain counts and averages
// from box scores; the score is a documented z-score blend, not a model.
// ?view=players|teams|matchups&season=&type=&scope=&pos=&sort= all in the URL.
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { useSeasons } from '../lib/seasons.js';
import { avg, pct, signedAvg } from '../lib/format.js';
import { ordinal } from '../lib/rankings.js';
import { PageTitle, Pills, Select, Tabs } from '../components/Controls.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

const VIEWS = [['players', 'Players'], ['teams', 'Teams'], ['matchups', 'Matchups']];
const TYPES = [['regular', 'Regular'], ['playoffs', 'Playoffs']];
const SCOPES = [['season', 'Season'], ['last10', 'Last 10']];
const POSITIONS = [['G', 'Guards'], ['F', 'Forwards'], ['C', 'Centers']];
const Z_LABEL = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', fg3m: '3PM', ts_pct: 'TS%', tov: 'TOV' };
const MATCHUP_STATS = [['pts', 'Points'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['fg3m', '3PM']];
const TEAM_SORTS = [['net_rtg', 'Net rating'], ['off_rtg', 'Offense'], ['def_rtg', 'Defense'], ['pace', 'Pace']];

const th = 'border-b-2 border-strong px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted whitespace-nowrap';
const td = 'num border-b border-rule px-3 py-2 text-sm whitespace-nowrap';
const sticky = 'sticky left-0 z-10 bg-card';
const Rank = ({ n, of }) => (n == null ? null : <span className="ml-1 text-xs text-muted" title={`${ordinal(n)} of ${of}`}>{ordinal(n)}</span>);

export default function Rankings() {
  const [params, setParams] = useSearchParams();
  const seasons = useSeasons();
  const list = seasons.data?.data.map((s) => s.season) ?? [];
  const latest = seasons.data?.meta.latest_with_games;
  const pick = (k, opts, d) => (opts.some(([v]) => v === params.get(k)) ? params.get(k) : d);
  const p = {
    view: pick('view', VIEWS, 'players'),
    season: list.includes(params.get('season')) ? params.get('season') : latest,
    type: pick('type', TYPES, 'regular'),
    scope: pick('scope', SCOPES, 'season'),
    pos: pick('pos', POSITIONS, 'G'),
  };
  const set = (k, v, d) => setParams((prev) => { const n = new URLSearchParams(prev); v === d ? n.delete(k) : n.set(k, v); return n; }, { replace: true });
  const q = `season=${p.season}&season_type=${p.type}&scope=${p.scope}`;

  return (
    <>
      <PageTitle eyebrow={p.season ? `${p.season} · ${p.type === 'regular' ? 'Regular season' : 'Playoffs'} · ${p.scope === 'season' ? 'full season' : 'last 10 games'}` : undefined}>Rankings</PageTitle>
      {seasons.error && <ErrorBox error={seasons.error} onRetry={seasons.retry} />}
      {seasons.loading && <Loading />}
      {p.season && (
        <>
          <Tabs label="View" value={p.view} options={VIEWS} onChange={(v) => set('view', v, 'players')} />
          <div className="flex flex-wrap items-end gap-4">
            <Select id="season" label="Season" value={p.season} onChange={(v) => set('season', v, latest)}>
              {list.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <Field label="Season type"><Pills label="Season type" value={p.type} options={TYPES} onChange={(v) => set('type', v, 'regular')} /></Field>
            <Field label="Games"><Pills label="Games" value={p.scope} options={SCOPES} onChange={(v) => set('scope', v, 'season')} /></Field>
            {p.view !== 'teams' && <Field label="Position"><Pills label="Position" value={p.pos} options={POSITIONS} onChange={(v) => set('pos', v, 'G')} /></Field>}
          </div>
          {p.view === 'players' && <Players q={`${q}&position=${p.pos}`} season={p.season} />}
          {p.view === 'teams' && <Teams q={q} sort={pick('sort', TEAM_SORTS, 'net_rtg')} onSort={(v) => set('sort', v, 'net_rtg')} season={p.season} />}
          {p.view === 'matchups' && <Matchups q={q} pos={p.pos} sort={pick('sort', MATCHUP_STATS, 'pts')} onSort={(v) => set('sort', v, 'pts')} season={p.season} />}
        </>
      )}
    </>
  );
}

const Field = ({ label, children }) => <div className="flex flex-col gap-1.5"><span className="text-[13px] font-semibold">{label}</span>{children}</div>;
const Notes = ({ notes }) => <ul className="m-0 flex list-none flex-col gap-1 border-t border-line p-0 pt-3 text-[13px] text-muted">{notes.map((n) => <li key={n}>{n}</li>)}</ul>;

function useApi(path) {
  return useFetch(`rankings:${path}`, (signal) => api(path, { signal }));
}

// ---- players ----------------------------------------------------------------------------------
function Players({ q, season }) {
  const { data, error, loading, retry } = useApi(`/rankings/players?${q}`);
  if (loading) return <Loading label="Ranking…" />;
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  const rows = data.data, m = data.meta;
  return (
    <>
      <div className="num flex flex-wrap items-baseline gap-x-3"><strong className="text-lg">{m.position_label} · {m.count} qualified</strong>
        <span className="text-sm text-muted">score 0 = an average qualified {m.position_label.toLowerCase().replace(/s$/, '')}</span></div>
      {rows.length === 0 ? <Empty>No qualified {m.position_label.toLowerCase()} for these filters.</Empty> : (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
          <table className="w-full min-w-[860px] border-collapse">
            <thead><tr>
              <th scope="col" className={`${th} ${sticky} text-left`}>Player</th>
              <th scope="col" className={`${th} text-right`} title="Average of the eight z-scores">Score</th>
              <th scope="col" className={`${th} text-right`}>GP</th>
              {m.stats.map((k) => <th key={k} scope="col" className={`${th} text-right`}>{Z_LABEL[k]}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.player_id}>
                  <th scope="row" className={`${td} ${sticky} text-left font-normal`}>
                    <span className="inline-block w-7 text-muted">{r.rank}</span>
                    <Link to={`/players/${r.player_id}?season=${season}`} className="font-semibold">{r.name}</Link>
                    <span className="ml-1.5 text-xs text-muted">{r.team}</span>
                  </th>
                  <td className={`${td} text-right font-display text-lg font-bold`}>{signedAvg(r.score)}</td>
                  <td className={`${td} text-right`}>{r.gp}</td>
                  {m.stats.map((k) => (
                    <td key={k} className={`${td} text-right`} title={`${Z_LABEL[k]} z-score ${signedAvg(r.z[k])}`}>
                      {k === 'ts_pct' ? pct(r[k]) : avg(r[k])}
                      <div className={`text-[11px] ${r.z[k] > 0 ? 'text-ink' : 'text-muted'}`}>{signedAvg(r.z[k])}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Notes notes={m.notes} />
    </>
  );
}

// ---- teams ------------------------------------------------------------------------------------
function Teams({ q, sort, onSort, season }) {
  const { data, error, loading, retry } = useApi(`/rankings/teams?${q}`);
  if (loading) return <Loading label="Ranking…" />;
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  const rows = [...data.data].sort((a, b) => (a.ranks[sort] ?? 99) - (b.ranks[sort] ?? 99) || a.abbr.localeCompare(b.abbr));
  const n = rows.length;
  return (
    <>
      <Select id="sort" label="Rank by" value={sort} onChange={onSort} className="self-start">
        {TEAM_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      {n === 0 ? <Empty>No games for these filters.</Empty> : (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
          <table className="w-full min-w-[720px] border-collapse">
            <thead><tr>
              <th scope="col" className={`${th} ${sticky} text-left`}>Team</th>
              {['W-L', 'Off rtg', 'Def rtg', 'Net', 'Pace', 'Pts', 'Opp'].map((h) => <th key={h} scope="col" className={`${th} text-right`}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.team_id}>
                  <th scope="row" className={`${td} ${sticky} text-left font-normal`}>
                    <span className="inline-block w-7 text-muted">{r.ranks[sort]}</span>
                    <Link to={`/teams/${r.team_id}?season=${season}`} className="font-semibold">{r.name}</Link>
                  </th>
                  <td className={`${td} text-right`}>{r.w}-{r.l}</td>
                  <td className={`${td} text-right`}>{avg(r.off_rtg)}<Rank n={r.ranks.off_rtg} of={n} /></td>
                  <td className={`${td} text-right`}>{avg(r.def_rtg)}<Rank n={r.ranks.def_rtg} of={n} /></td>
                  <td className={`${td} text-right font-semibold`}>{signedAvg(r.net_rtg)}<Rank n={r.ranks.net_rtg} of={n} /></td>
                  <td className={`${td} text-right`}>{avg(r.pace)}<Rank n={r.ranks.pace} of={n} /></td>
                  <td className={`${td} text-right`}>{avg(r.pts)}</td>
                  <td className={`${td} text-right`}>{avg(r.opp_pts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Notes notes={[...data.meta.notes, 'Defense: rank 1 = fewest points allowed per 100 possessions. Pace: rank 1 = fastest.']} />
    </>
  );
}

// ---- matchups ---------------------------------------------------------------------------------
function Matchups({ q, pos, sort, onSort, season }) {
  const { data, error, loading, retry } = useApi(`/rankings/matchups?${q}`);
  if (loading) return <Loading label="Ranking…" />;
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  const rows = [...data.data[pos]].sort((a, b) => (a.rank[sort] ?? 99) - (b.rank[sort] ?? 99) || a.abbr.localeCompare(b.abbr));
  const avgRow = data.league_avg?.[pos];
  const label = POSITIONS.find(([v]) => v === pos)[1].toLowerCase();
  return (
    <>
      <Select id="sort" label="Rank by" value={sort} onChange={onSort} className="self-start">
        {MATCHUP_STATS.map(([v, l]) => <option key={v} value={v}>{l} allowed</option>)}
      </Select>
      {rows.length === 0 ? <Empty>No games for these filters.</Empty> : (
        <MatchupTable rows={rows} sort={sort} n={rows.length} avgRow={avgRow} label={label} season={season} />
      )}
      <Notes notes={data.meta.notes} />
    </>
  );
}

/** Also used on team pages (one team, three positions). Exported for tests. */
export function MatchupTable({ rows, sort = 'pts', n, avgRow, label, season, firstCol = 'team' }) {
  const badge = (l) => (l === 'weak' ? <span className="ml-1.5 rounded-full bg-alt-bg px-1.5 py-0.5 text-[11px] font-semibold text-alt-ink">weak</span>
    : l === 'strong' ? <span className="ml-1.5 rounded-full border border-line px-1.5 py-0.5 text-[11px] font-semibold">strong</span> : null);
  return (
    <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
      <table className="w-full min-w-[640px] border-collapse">
        <thead><tr>
          <th scope="col" className={`${th} ${sticky} text-left`}>{firstCol === 'team' ? 'Defense' : 'Vs'}</th>
          <th scope="col" className={`${th} text-right`}>GP</th>
          {MATCHUP_STATS.map(([k, l]) => <th key={k} scope="col" className={`${th} text-right ${k === sort ? 'text-ink' : ''}`}>{l}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key ?? r.team_id}>
              <th scope="row" className={`${td} ${sticky} text-left font-normal`}>
                {firstCol === 'team'
                  ? <><span className="inline-block w-7 text-muted">{r.rank[sort]}</span><Link to={`/teams/${r.team_id}?season=${season}`} className="font-semibold">{r.abbr}</Link>{badge(r.label[sort])}</>
                  : <span className="font-semibold">{r.title}</span>}
              </th>
              <td className={`${td} text-right`}>{r.games}</td>
              {MATCHUP_STATS.map(([k]) => (
                <td key={k} className={`${td} text-right ${k === sort ? 'font-semibold' : ''}`} title={`${signedAvg(r.vs_avg[k])} vs league average`}>
                  {avg(r.allowed[k])}<Rank n={r.rank[k]} of={n} />
                  <div className="text-[11px] font-normal text-muted">{signedAvg(r.vs_avg[k])}{firstCol !== 'team' && r.label[k] ? ` · ${r.label[k]}` : ''}</div>
                </td>
              ))}
            </tr>
          ))}
          {avgRow && firstCol === 'team' && (
            <tr>
              <th scope="row" className={`${td} ${sticky} border-t-2 border-t-strong text-left font-semibold`}>League avg</th>
              <td className={`${td} border-t-2 border-t-strong`} />
              {MATCHUP_STATS.map(([k]) => <td key={k} className={`${td} border-t-2 border-t-strong text-right font-semibold`}>{avg(avgRow[k])}</td>)}
            </tr>
          )}
        </tbody>
      </table>
      <p className="m-0 px-3 py-2 text-xs text-muted">Per game to opposing {label}; small number = vs league average. Rank 1 = allows the fewest.</p>
    </div>
  );
}
