import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { SEASON_TYPE_OPTIONS, useSeasons } from '../lib/seasons.js';
import { avg, SEASON_TYPE } from '../lib/format.js';
import { PageTitle, Pills, Select, Tabs } from '../components/Controls.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

const STATS = [['pts', 'Points'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['fg3m', '3-pointers'], ['stl', 'Steals'], ['blk', 'Blocks']];
// The leaderboard scope has no play-in option: too few games to rank.
const TYPES = SEASON_TYPE_OPTIONS.filter(([v]) => v !== 'play_in');

export default function Leaders() {
  const [params, setParams] = useSearchParams();
  const seasons = useSeasons();
  const list = seasons.data?.data.map((s) => s.season) ?? [];
  const season = list.includes(params.get('season')) ? params.get('season') : seasons.data?.meta.latest_with_games;
  const type = TYPES.some(([v]) => v === params.get('type')) ? params.get('type') : 'regular';
  const stat = STATS.some(([v]) => v === params.get('stat')) ? params.get('stat') : 'pts';
  const set = (k, v, d) => setParams((prev) => { const n = new URLSearchParams(prev); v === d ? n.delete(k) : n.set(k, v); return n; }, { replace: true });

  const body = season ? { scope: 'leaderboard', season, season_type: type, stat, limit: 25 } : null;
  const { data, error, loading, retry } = useFetch(body && JSON.stringify(body), (signal) => api('/query', { method: 'POST', body, signal }));
  const q = data?.meta.qualifier;
  const label = STATS.find(([v]) => v === stat)[1];
  const typeName = type === 'all' ? 'All game types' : SEASON_TYPE[type];

  return (
    <>
      <PageTitle eyebrow={season ? `${season} · ${typeName} · per game` : 'Per game'}>League leaders</PageTitle>
      {seasons.error && <ErrorBox error={seasons.error} onRetry={seasons.retry} />}
      {season && (
        <div className="flex flex-wrap items-end gap-4">
          <Select id="season" label="Season" value={season} onChange={(v) => set('season', v, seasons.data.meta.latest_with_games)}>
            {list.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">Season type</span>
            <Pills label="Season type" value={type} options={TYPES} onChange={(v) => set('type', v, 'regular')} />
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <Tabs label="Stat" value={stat} options={STATS} onChange={(v) => set('stat', v, 'pts')} />
          {(loading || seasons.loading) && <Loading />}
          {error && <ErrorBox error={error} onRetry={retry} />}
          {data && (data.data.length === 0
            ? <Empty>No qualified players for {season} ({typeName.toLowerCase()}).</Empty>
            : (
              <ol className="m-0 list-none rounded-[10px] border border-line bg-card p-0">
                {data.data.map((r) => (
                  <li key={r.player_id} className="grid grid-cols-[36px_1fr_auto] items-center gap-x-3 border-b border-rule px-4 py-2.5 last:border-b-0 sm:grid-cols-[40px_1fr_70px_70px_80px] sm:px-5">
                    <span className="num text-lg font-semibold text-muted">{r.rank}</span>
                    <span className="flex flex-col sm:contents">
                      <Link to={`/players/${r.player_id}?season=${season}${type !== 'regular' ? `&type=${type}` : ''}`} className="text-base font-semibold">{r.full_name}</Link>
                      <span className="text-sm text-muted sm:hidden">{r.team} · {r.gp} GP</span>
                    </span>
                    <span className="hidden text-sm text-muted sm:block">{r.team}</span>
                    <span className="num hidden text-right text-sm text-muted sm:block">{r.gp} GP</span>
                    <span className="num text-right font-display text-[28px] font-bold">{avg(r.value)}</span>
                  </li>
                ))}
              </ol>
            ))}
        </div>
        <aside className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-card p-5">
            <h2 className="m-0 font-display text-2xl font-bold">Who qualifies</h2>
            {q ? (
              <p className="m-0 text-[15px] leading-relaxed">
                Played in at least <strong>70% of the team's games</strong>: {q.min_games} of {q.team_games}{season === seasons.data?.meta.current_season ? ' so far' : ''}. <strong>{q.qualified_players} player{q.qualified_players === 1 ? '' : 's'}</strong> {q.qualified_players === 1 ? 'qualifies' : 'qualify'}.
              </p>
            ) : <p className="m-0 text-[15px] leading-relaxed">Played in at least <strong>70% of the team's games</strong>.</p>}
            <p className="m-0 text-sm leading-relaxed text-muted">This is Chalk That's rule, not the NBA's official qualifier. It scales with games played, so it works early in the season too, and a 1-game outlier can't top the list.</p>
          </div>
          <p className="m-0 text-[13px] text-muted">{label} per game · computed from NBA.com game logs</p>
        </aside>
      </div>
    </>
  );
}
