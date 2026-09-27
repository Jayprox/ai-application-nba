import { Link, useParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import StatExplorer from '../components/StatExplorer.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

const height = (inches) => (inches ? `${Math.floor(inches / 12)}'${inches % 12}"` : null);

export default function PlayerDetail() {
  const { id } = useParams();
  const { data, error, loading, retry } = useFetch(`player:${id}`, (signal) => api(`/players/${id}`, { signal }));
  const p = data?.data;
  return (
    <>
      <Link to="/players" className="self-start text-sm font-medium">← Players</Link>
      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={error.status === 404 ? undefined : retry} />}
      {p && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="m-0 font-display text-[40px] font-bold leading-none sm:text-[56px]">{p.full_name}</h1>
              <div className="text-base text-muted">
                {[p.listed_position, p.team_name, height(p.height_in), p.weight_lb && `${p.weight_lb} lb`, !p.is_active && 'Retired'].filter(Boolean).join(' · ')}
              </div>
            </div>
            {p.current_injury && (
              <span className="rounded-full bg-alt-bg px-3 py-1 text-sm font-semibold text-alt-ink" title={p.current_injury.description ?? ''}>
                {p.current_injury.status}{p.current_injury.description ? ` — ${p.current_injury.description}` : ''}
              </span>
            )}
          </div>
          {p.seasons.length
            ? <StatExplorer entity="player" id={p.id} name={`${p.full_name}'s`} seasons={p.seasons} defaultSeason={p.seasons[0]} />
            : <Empty>No games for {p.full_name} since 2003-04 (where our stats begin).</Empty>}
        </>
      )}
    </>
  );
}
