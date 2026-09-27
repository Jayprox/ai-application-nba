// Standings (per conference) and the postseason bracket, one page with two tabs.
// ?season=YYYY-YY&view=bracket — both live in the URL.
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { useSeasons } from '../lib/seasons.js';
import { tinyDate } from '../lib/format.js';
import { PageTitle, Select, Tabs } from '../components/Controls.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';

const CLINCH = { z: 'best record in the league', w: 'clinched the West', e: 'clinched the East', y: 'clinched division', x: 'clinched playoffs',
  p: 'clinched a playoff spot', sw: 'clinched the Southwest', se: 'clinched the Southeast', a: 'clinched the Atlantic', c: 'clinched the Central',
  nw: 'clinched the Northwest', pi: 'clinched a play-in spot', o: 'eliminated' };

export default function Standings() {
  const [params, setParams] = useSearchParams();
  const seasons = useSeasons();
  const list = seasons.data?.data.map((s) => s.season) ?? [];
  const season = list.includes(params.get('season')) ? params.get('season') : seasons.data?.meta.latest_with_games;
  const view = params.get('view') === 'bracket' ? 'bracket' : 'table';
  const set = (k, v, d) => setParams((prev) => { const n = new URLSearchParams(prev); v === d ? n.delete(k) : n.set(k, v); return n; }, { replace: true });

  return (
    <>
      <PageTitle eyebrow={season ? `${season} · ${view === 'table' ? 'Regular season' : 'Postseason'}` : undefined}>Standings</PageTitle>
      {seasons.error && <ErrorBox error={seasons.error} onRetry={seasons.retry} />}
      {seasons.loading && <Loading />}
      {season && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <Select id="season" label="Season" value={season} onChange={(v) => set('season', v, seasons.data.meta.latest_with_games)}>
              {list.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <Tabs label="View" value={view} options={[['table', 'Standings'], ['bracket', 'Playoffs']]} onChange={(v) => set('view', v, 'table')} />
          {view === 'table' ? <Table season={season} /> : <Bracket season={season} />}
        </>
      )}
    </>
  );
}

// ---- standings table -------------------------------------------------------
function Table({ season }) {
  const { data, error, loading, retry } = useFetch(`standings:${season}`, (signal) => api(`/standings?season=${season}`, { signal }));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  const { format, notes } = data.meta;
  if (!data.data.East.length || data.meta.games === 0) return <Empty>No regular-season games yet for {season}.</Empty>;
  const legend = [...new Set([...data.data.East, ...data.data.West].map((t) => t.clinch).filter(Boolean))];
  return (
    <>
      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        {['East', 'West'].map((c) => <Conference key={c} name={c} rows={data.data[c]} format={format} season={season} />)}
      </div>
      <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px] text-muted">
        <span>
          Seeds 1–{format.playoff_seeds}: playoffs{format.play_in_seeds.length ? ` · seeds ${format.play_in_seeds[0]}–${format.play_in_seeds.at(-1)}: ${season === '2019-20' ? 'bubble play-in' : 'play-in'}` : ''}.
          {legend.length ? ` ${legend.map((k) => `${k} = ${CLINCH[k] ?? k}`).join(' · ')}.` : ''}
        </span>
        {notes.map((n) => <span key={n}>{n}</span>)}
      </div>
    </>
  );
}

function Conference({ name, rows, format, season }) {
  const th = 'border-b-2 border-ink px-2.5 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted whitespace-nowrap';
  const td = 'num border-b border-rule px-2.5 py-2 text-sm whitespace-nowrap';
  const lastPlayoff = format.playoff_seeds, lastPlayIn = format.play_in_seeds.at(-1) ?? format.playoff_seeds;
  const cut = (rank) => (rank === lastPlayoff || rank === lastPlayIn ? 'border-b-2 border-b-ink/60' : '');
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-display text-[28px] font-bold">{name}ern Conference</h2>
      <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th scope="col" className={`${th} sticky left-0 z-10 bg-card text-left`}>Team</th>
              {['W', 'L', 'Pct', 'GB', 'Home', 'Road', 'Conf', 'L10', 'Strk'].map((h) => <th key={h} scope="col" className={`${th} text-right`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const zone = t.rank <= lastPlayoff ? '' : t.rank <= lastPlayIn ? 'bg-rule/40' : 'text-muted';
              return (
                <tr key={t.team_id} className={zone}>
                  <th scope="row" className={`${td} ${cut(t.rank)} sticky left-0 z-10 bg-card text-left font-medium`}>
                    <span className="inline-block w-6 text-muted">{t.rank}</span>
                    <Link to={`/teams/${t.team_id}?season=${season}`}>{t.name}</Link>
                    {t.clinch && <span className="ml-1.5 text-xs font-semibold text-accent" title={CLINCH[t.clinch] ?? t.clinch}>{t.clinch}</span>}
                  </th>
                  {[t.wins, t.losses, t.pct == null ? '—' : t.pct.toFixed(3).replace(/^0/, ''), t.gb === 0 ? '—' : t.gb, t.home, t.road, t.conf, t.last10, t.streak ?? '—']
                    .map((v, i) => <td key={i} className={`${td} ${cut(t.rank)} text-right ${i < 2 ? 'font-semibold' : ''}`}>{v}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- bracket ------------------------------------------------------------------
const R1_ORDER = { 1: 0, 8: 0, 4: 1, 5: 1, 3: 2, 6: 2, 2: 3, 7: 3 };   // classic bracket order: 1v8, 4v5, 3v6, 2v7
const half = (s) => ([1, 8, 4, 5].includes(s.higher_seed) ? 0 : 1);

export function arrangeBracket(series) {
  const by = (round, conf) => series.filter((s) => s.round === round && (conf === undefined || s.conference === conf));
  const conf = (c) => ({
    // 7v8, 9v10, then the game for the 8th seed (loser of 7v8 vs winner of 9v10).
    playIn: by('play_in', c).sort((a, b) => a.bracket_slot.endsWith('8seed') - b.bracket_slot.endsWith('8seed') || a.higher_seed - b.higher_seed),
    first: by('first_round', c).sort((a, b) => (R1_ORDER[a.higher_seed] ?? 9) - (R1_ORDER[b.higher_seed] ?? 9)),
    semis: by('conf_semis', c).sort((a, b) => half(a) - half(b)),
    finals: by('conf_finals', c),
  });
  return { East: conf('East'), West: conf('West'), finals: by('finals')[0] ?? null };
}

function Bracket({ season }) {
  const { data, error, loading, retry } = useFetch(`bracket:${season}`, (signal) => api(`/bracket?season=${season}`, { signal }));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  if (!data.data.length) return <Empty>No postseason games for {season} yet.</Empty>;
  const b = arrangeBracket(data.data);
  return (
    <div className="flex flex-col gap-8">
      {b.finals && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 font-display text-[28px] font-bold">NBA Finals</h2>
          <div className="max-w-sm"><Series s={b.finals} season={season} big /></div>
        </section>
      )}
      {['West', 'East'].map((c) => (
        <section key={c} className="flex flex-col gap-3">
          <h2 className="m-0 font-display text-[28px] font-bold">{c}ern Conference</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Column title={season === '2019-20' ? 'Play-In (best of 2)' : 'Play-In'} items={b[c].playIn} season={season} />
            <Column title="First round" items={b[c].first} season={season} />
            <Column title="Conf. semifinals" items={b[c].semis} season={season} />
            <Column title="Conf. finals" items={b[c].finals} season={season} />
          </div>
        </section>
      ))}
      <p className="m-0 text-[13px] text-muted">Seeds from NBA.com's final standings. Series wins count finished games; click a team for its playoff stats.</p>
    </div>
  );
}

function Column({ title, items, season }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="eyebrow m-0">{title}</h3>
      {items.length ? <div className="flex flex-col justify-around gap-3 md:h-full">{items.map((s) => <Series key={s.id} s={s} season={season} />)}</div>
        : <div className="rounded-[10px] border border-dashed border-line px-3 py-4 text-sm text-muted">—</div>}
    </div>
  );
}

function Series({ s, season, big }) {
  const done = s.winner_team_id != null;
  const needed = s.round === 'play_in' ? (s.best_of === 2 ? null : 1) : 4;
  const row = (seed, id, abbr, name, wins) => {
    const won = s.winner_team_id === id;
    return (
      <div className={`flex items-center justify-between gap-3 ${done && !won ? 'text-muted' : ''}`}>
        <span className="flex items-baseline gap-2">
          <span className="num w-5 text-xs text-muted">{seed}</span>
          {id ? <Link to={`/teams/${id}?season=${season}&type=${s.round === 'play_in' ? 'play_in' : 'playoffs'}`} className={`${won ? 'font-bold' : 'font-medium'} ${big ? 'text-lg' : ''}`} title={name}>{abbr}</Link> : <span>TBD</span>}
        </span>
        <span className={`num font-display ${big ? 'text-3xl' : 'text-2xl'} ${won ? 'font-bold' : 'font-semibold'}`}>{wins}</span>
      </div>
    );
  };
  return (
    <div className={`flex flex-col gap-1.5 rounded-[10px] bg-card px-3.5 py-3 ${done ? 'border border-line' : 'border-2 border-link'}`}>
      {row(s.higher_seed, s.higher_id, s.higher_abbr, s.higher_name, s.higher_wins)}
      {row(s.lower_seed, s.lower_id, s.lower_abbr, s.lower_name, s.lower_wins)}
      <div className="text-xs text-muted">
        {done && s.first_game ? (s.first_game === s.last_game ? tinyDate(s.first_game) : `${tinyDate(s.first_game)} – ${tinyDate(s.last_game)}`)
          : needed ? `In progress · first to ${needed}` : 'In progress'}
      </div>
    </div>
  );
}
