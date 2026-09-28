// Natural-language search results. /ask?q=... (and &plan=... after editing a
// chip or picking a clarification). Claude only picks the query; the numbers
// and the sentence come from the API.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { avg, pct, signedAvg, tinyDate } from '../lib/format.js';
import { MARKET_SHORT, price } from '../lib/props.js';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { PageTitle } from '../components/Controls.jsx';

export const EXAMPLES = [
  'Jokić on the second night of back-to-backs',
  'Brunson on the road last 10 games',
  'who leads the league in steals',
  'which teams give up the most points to centers',
  'has Edwards gone over 27.5 points lately',
  'Knicks record',
];

/** Plan minus one chip's field (exported for tests). */
export function withoutChip(plan, key) {
  const next = { ...plan };
  delete next[key];
  return next;
}

export default function Ask() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const planParam = params.get('plan');
  let plan = null;
  try { plan = planParam ? JSON.parse(planParam) : null; } catch { plan = null; }
  const body = plan ? { plan } : q.trim().length >= 2 ? { q } : null;
  const key = body ? `ask:${JSON.stringify(body)}` : null;
  const { data, error, loading, retry } = useFetch(key, (signal) => api('/ask', { method: 'POST', body, signal }));
  const rerun = (p) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('plan', JSON.stringify(p)); return n; });

  return (
    <>
      <PageTitle eyebrow="Plain English · verified numbers">Ask</PageTitle>
      <AskBox key={q} initial={q} big />
      {!body && <Examples />}
      {loading && <Loading label="Looking it up…" />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (
        <section aria-label="Answer" className="flex flex-col gap-4">
          <p className="m-0 font-display text-[26px] font-bold leading-tight sm:text-[32px]">{data.sentence}</p>
          {data.clarify && (
            <div className="flex flex-wrap gap-2">
              {data.clarify.options.map((o) => (
                <button key={o.id} type="button" onClick={() => rerun({ ...data.plan, [data.clarify.field]: o.name })}
                  className="h-10 cursor-pointer rounded-full border border-field bg-card px-4 text-[15px] font-medium hover:border-muted">{o.name}</button>
              ))}
            </div>
          )}
          {data.chips?.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" aria-label="Filters used">
              {data.chips.map((c) => (
                <span key={c.key} className="inline-flex h-8 items-center gap-1 rounded-full border border-line bg-card pl-3 pr-1 text-sm">
                  {c.label}
                  {c.removable
                    ? <button type="button" aria-label={`Remove ${c.label}`} onClick={() => rerun(withoutChip(data.plan, c.key))}
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-rule hover:text-ink">×</button>
                    : <span className="w-2" />}
                </span>
              ))}
            </div>
          )}
          <View v={data.view} season={data.season} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[13px] text-muted">
            <span>Numbers from Chalk That's database (NBA.com box scores{data.view?.type === 'props' ? ', DraftKings lines' : ''}). Claude only picked the query{data.cached ? ' (cached)' : ''}.</span>
            {data.link && <Link to={data.link} className="font-semibold">Open the full view →</Link>}
          </div>
        </section>
      )}
    </>
  );
}

/** The search box (also in the nav). */
export function AskBox({ initial = '', big = false }) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const submit = (e) => { e.preventDefault(); const q = text.trim(); if (q.length >= 2) navigate(`/ask?q=${encodeURIComponent(q)}`); };
  return (
    <form role="search" onSubmit={submit} className={`flex gap-2 ${big ? '' : 'w-full'}`}>
      <label htmlFor={big ? 'ask-big' : 'ask'} className="sr-only">Ask a stats question</label>
      <input id={big ? 'ask-big' : 'ask'} type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
        placeholder={big ? 'Ask anything: "Jokić on back-to-backs", "best defense vs centers"…' : 'Ask a stats question…'}
        className={`min-w-0 flex-1 rounded-lg border px-3 ${big ? 'h-12 border-field bg-card text-[16px]' : 'h-9 border-line bg-paper text-[14px] text-ink placeholder:text-faint'}`} />
      {big && <button type="submit" className="h-12 cursor-pointer rounded-lg bg-accent px-5 text-[15px] font-semibold text-on-accent hover:bg-accent-hover">Ask</button>}
    </form>
  );
}

function Examples() {
  return (
    <Empty>
      <p className="m-0 mb-3">Try:</p>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {EXAMPLES.map((e) => <li key={e}><Link to={`/ask?q=${encodeURIComponent(e)}`} className="inline-block rounded-full border border-line px-3 py-1 text-sm no-underline">{e}</Link></li>)}
      </ul>
    </Empty>
  );
}

// ---- result views -------------------------------------------------------------------------------
const th = 'border-b-2 border-strong px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted whitespace-nowrap';
const td = 'num border-b border-rule px-3 py-2 text-sm whitespace-nowrap';
const Tile = ({ k, v }) => (
  <div className="flex flex-col gap-0.5 rounded-[10px] border border-line bg-card px-4 py-3">
    <span className="eyebrow">{k}</span><span className="num font-display text-[30px] font-bold leading-tight">{v}</span>
  </div>
);
function Table({ head, rows }) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-line bg-card">
      <table className="w-full min-w-[480px] border-collapse">
        <thead><tr>{head.map(([h, a], i) => <th key={i} scope="col" className={`${th} ${a === 'r' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((cells, i) => <tr key={i}>{cells.map((c, j) => <td key={j} className={`${td} ${head[j][1] === 'r' ? 'text-right' : 'text-left'}`}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function View({ v, season }) {
  if (!v) return null;
  switch (v.type) {
    case 'stats': {
      const q = v.query;
      if (!q.meta.sample_size) return null;
      if (q.query.scope === 'game_log') {
        return <Table head={[['Date'], ['Opp'], ['Result'], ...(q.subject.type === 'player' ? [['Pts', 'r'], ['Reb', 'r'], ['Ast', 'r']] : [['Score', 'r']])]}
          rows={q.data.slice(0, 10).map((g) => [<Link key="d" to={`/games/${g.game_id}`}>{tinyDate(g.date)}</Link>, `${g.venue === 'away' ? '@' : 'vs'} ${g.opponent}`, g.won ? 'W' : 'L',
            ...(q.subject.type === 'player' ? [g.pts, g.reb, g.ast] : [`${g.pts}-${g.opp_pts}`])])} />;
      }
      const d = q.query.scope === 'career' ? q.data.totals : q.data;
      const tiles = q.subject.type === 'player'
        ? [['Points', avg(d.pts)], ['Rebounds', avg(d.reb)], ['Assists', avg(d.ast)], ['3PM', avg(d.fg3m)], ['FG%', pct(d.fg_pct)], ['TS%', pct(d.ts_pct)], ['Minutes', avg(d.minutes)], ['Games', q.meta.sample_size]]
        : [['Points', avg(d.pts)], ['Opp points', avg(d.opp_pts)], ['Net rtg (est.)', d.off_rtg == null ? '—' : signedAvg(d.off_rtg - d.def_rtg)], ['Rebounds', avg(d.reb)], ['Assists', avg(d.ast)], ['Record', q.meta.record]];
      return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{tiles.map(([k, val]) => <Tile key={k} k={k} v={val} />)}</div>;
    }
    case 'leaders':
      return <Table head={[['#'], ['Player'], ['Team'], ['GP', 'r'], ['Per game', 'r']]}
        rows={v.rows.map((r) => [r.rank, <Link key="p" to={`/players/${r.player_id}?season=${season}`}>{r.full_name}</Link>, r.team, r.gp, avg(r.value)])} />;
    case 'player_rankings':
      return <Table head={[['#'], ['Player'], ['Team'], ['Score', 'r'], ['Pts', 'r'], ['Reb', 'r'], ['Ast', 'r']]}
        rows={v.rows.map((r) => [r.rank, <Link key="p" to={`/players/${r.player_id}?season=${season}`}>{r.name}</Link>, r.team, signedAvg(r.score), avg(r.pts), avg(r.reb), avg(r.ast)])} />;
    case 'team_rankings':
      return <Table head={[['#'], ['Team'], ['W-L', 'r'], ['Off', 'r'], ['Def', 'r'], ['Net', 'r'], ['Pace', 'r']]}
        rows={v.rows.map((r) => [r.ranks[v.stat], <Link key="t" to={`/teams/${r.team_id}?season=${season}`}>{r.name}</Link>, `${r.w}-${r.l}`, avg(r.off_rtg), avg(r.def_rtg), signedAvg(r.net_rtg), avg(r.pace)])} />;
    case 'matchups':
      return <Table head={[['#'], ['Defense'], ['GP', 'r'], [`${MARKET_SHORT[v.stat]} allowed`, 'r'], ['Vs avg', 'r']]}
        rows={v.rows.map((r) => [r.rank[v.stat], <Link key="t" to={`/teams/${r.team_id}?season=${season}`}>{r.abbr}</Link>, r.games, avg(r.allowed[v.stat]), signedAvg(r.vs_avg[v.stat])])} />;
    case 'props': {
      const dk = v.upcoming?.lines.find((l) => l.market === v.market);
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {dk && <Tile k={`DraftKings ${MARKET_SHORT[v.market]} · ${v.upcoming.game.away} @ ${v.upcoming.game.home}`} v={<>{dk.line} <span className="text-base font-normal text-muted">o{price(dk.over_price)} / u{price(dk.under_price)}</span></>} />}
          {v.hits?.games > 0 && <Tile k={`Over ${v.hits.line}`} v={`${v.hits.over} of ${v.hits.games}`} />}
          {v.record?.games > 0 && <Tile k="Vs past DraftKings lines" v={`${v.record.over}–${v.record.under}${v.record.push ? `–${v.record.push}` : ''}`} />}
        </div>
      );
    }
    case 'standings':
      return <Table head={[['#'], ['Team'], ['Conf'], ['W', 'r'], ['L', 'r'], ['GB', 'r']]}
        rows={v.rows.map((r) => [r.rank, <Link key="t" to={`/teams/${r.team_id}?season=${season}`}>{r.name}</Link>, r.conference, r.wins, r.losses, r.gb === 0 ? '—' : r.gb])} />;
    case 'game':
      return v.games.length ? <Table head={[['Date'], ['Game'], ['Result', 'r']]}
        rows={v.games.map((g) => [<Link key="d" to={`/games/${g.game_id}`}>{tinyDate(g.date)}</Link>, `${g.team} ${g.venue === 'away' ? '@' : 'vs'} ${g.opponent}`, `${g.won ? 'W' : 'L'} ${g.pts}-${g.opp_pts}`])} /> : null;
    case 'series': {
      const R = { play_in: 'Play-In', first_round: 'First round', conf_semis: 'Conf. semis', conf_finals: 'Conf. finals', finals: 'Finals' };
      return v.rows.length ? <Table head={[['Round'], ['Series'], ['Result', 'r']]}
        rows={v.rows.map((x) => [R[x.round] + (x.conference && x.round !== 'finals' ? ` (${x.conference})` : ''), `${x.higher_abbr} vs ${x.lower_abbr}`,
          x.winner_team_id == null ? `${x.higher_wins}-${x.lower_wins}` : `${x.winner_team_id === x.higher_id ? x.higher_abbr : x.lower_abbr} ${Math.max(x.higher_wins, x.lower_wins)}-${Math.min(x.higher_wins, x.lower_wins)}`])} /> : null;
    }
    case 'unsupported':
      return <Examples />;
    default:
      return null;
  }
}

