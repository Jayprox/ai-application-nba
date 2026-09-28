import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { useSeasons, SEASON_TYPE_OPTIONS } from '../lib/seasons.js';
import { avg, SEASON_TYPE_LOWER } from '../lib/format.js';
import StatExplorer from '../components/StatExplorer.jsx';
import { MatchupTable } from './Rankings.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

export default function TeamDetail() {
  const { id } = useParams();
  const team = useFetch(`team:${id}`, (signal) => api(`/teams/${id}`, { signal }));
  const seasons = useSeasons();
  const t = team.data?.data;
  const list = seasons.data?.data.map((s) => s.season) ?? [];
  const latest = seasons.data?.meta.latest_with_games;

  return (
    <>
      <Link to="/teams" className="self-start text-sm font-medium">← Teams</Link>
      {(team.loading || seasons.loading) && <Loading />}
      {team.error && <ErrorBox error={team.error} onRetry={team.error.status === 404 ? undefined : team.retry} />}
      {seasons.error && <ErrorBox error={seasons.error} onRetry={seasons.retry} />}
      {t && seasons.data && (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="m-0 font-display text-[40px] font-bold leading-none sm:text-[56px]">{t.full_name}</h1>
            <div className="text-base text-muted">
              {t.conference}ern Conference · {t.division}{t.arena ? ` · ${t.arena}` : ''}
              {t.is_high_altitude && <span className="ml-2 rounded-full bg-alt-bg px-2 py-0.5 text-xs font-semibold text-alt-ink">Altitude arena · {t.elevation_ft?.toLocaleString()} ft</span>}
            </div>
          </div>
          {latest
            ? <>
                <StatExplorer entity="team" id={Number(id)} name={`the ${t.full_name}`} seasons={list} seasonTypes={t.season_types} defaultSeason={latest} />
                <DefenseByPosition teamId={Number(id)} teamName={t.name} latest={latest} seasons={list} />
                <Roster teamId={id} teamName={t.name} latest={latest} seasons={list} />
              </>
            : <Empty>No finished games loaded yet.</Empty>}
        </>
      )}
    </>
  );
}

// What this team allows per game to opposing guards / forwards / centers, ranked
// 1-30 league-wide. Follows the explorer's season; regular season or playoffs.
function DefenseByPosition({ teamId, teamName, latest, seasons }) {
  const [params] = useSearchParams();
  const season = seasons.includes(params.get('season')) ? params.get('season') : latest;
  const type = params.get('type') === 'playoffs' ? 'playoffs' : 'regular';
  const { data, error, loading, retry } = useFetch(`team-matchups:${season}:${type}`,
    (signal) => api(`/rankings/matchups?season=${season}&season_type=${type}`, { signal }));
  const rows = data ? ['G', 'F', 'C'].map((p) => {
    const r = data.data[p].find((x) => x.team_id === teamId);
    return r && { ...r, key: p, title: { G: 'Guards', F: 'Forwards', C: 'Centers' }[p] };
  }).filter(Boolean) : [];
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-display text-[28px] font-bold">
        Defense by position <span className="font-sans text-sm font-normal text-muted">· what opponents score against the {teamName}, {season} {type === 'playoffs' ? 'playoffs' : 'regular season'}</span>
      </h2>
      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (rows.length
        ? <MatchupTable rows={rows} n={data.data.G.length} label="guards, forwards and centers" season={season} firstCol="position" />
        : <Empty>No {type === 'playoffs' ? 'playoff' : 'regular-season'} games for the {teamName} in {season}.</Empty>)}
    </section>
  );
}

// Follows the explorer's season + season type (same URL params).
function Roster({ teamId, teamName, latest, seasons }) {
  const [params] = useSearchParams();
  const season = seasons.includes(params.get('season')) ? params.get('season') : latest;
  const type = SEASON_TYPE_OPTIONS.some(([v]) => v === params.get('type')) ? params.get('type') : 'regular';
  const { data, error, loading, retry } = useFetch(`roster:${teamId}:${season}:${type}`,
    (signal) => api(`/teams/${teamId}/players?season=${season}&season_type=${type}`, { signal }));
  const th = 'border-b-2 border-strong px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted';
  const td = 'num border-b border-rule px-3 py-2 text-sm';
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-display text-[28px] font-bold">
        {season} roster <span className="font-sans text-sm font-normal text-muted">· everyone who played for the {teamName} ({SEASON_TYPE_LOWER[type]})</span>
      </h2>
      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (data.data.length === 0
        ? <Empty>No {SEASON_TYPE_LOWER[type]} games for the {teamName} in {season}.</Empty>
        : (
          <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
            <table className="w-full min-w-[520px] border-collapse">
              <thead><tr>
                <th scope="col" className={`${th} sticky left-0 bg-card text-left`}>Player</th>
                {['GP', 'Min', 'Pts', 'Reb', 'Ast'].map((h) => <th key={h} scope="col" className={`${th} text-right`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {data.data.map((p) => (
                  <tr key={p.player_id}>
                    <th scope="row" className={`${td} sticky left-0 bg-card text-left font-medium`}><Link to={`/players/${p.player_id}?season=${season}${type !== 'regular' ? `&type=${type}` : ''}`}>{p.full_name}</Link></th>
                    <td className={`${td} text-right`}>{p.gp}</td>
                    <td className={`${td} text-right`}>{avg(p.minutes)}</td>
                    <td className={`${td} text-right font-semibold`}>{avg(p.pts)}</td>
                    <td className={`${td} text-right`}>{avg(p.reb)}</td>
                    <td className={`${td} text-right`}>{avg(p.ast)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
