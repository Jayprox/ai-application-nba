import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { PageTitle, Select } from '../components/Controls.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { useTeams } from './Teams.jsx';

export default function Players() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const team = params.get('team') ?? '';
  const active = params.get('active') !== 'false';
  const [text, setText] = useState(q);

  const update = (k, v) => setParams((prev) => { const n = new URLSearchParams(prev); v ? n.set(k, v) : n.delete(k); return n; }, { replace: true });
  // Debounce typing into the URL (and so into the request) by 250 ms.
  useEffect(() => { const t = setTimeout(() => { if (text.trim() !== q) update('q', text.trim()); }, 250); return () => clearTimeout(t); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const teams = useTeams();
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(team ? { team } : {}), active: String(active) }).toString();
  const { data, error, loading, retry } = useFetch(`players:${qs}`, (signal) => api(`/players?${qs}`, { signal }));
  // How many retired players the Active toggle is hiding (only asked when it matters).
  const hidden = useFetch(active && q ? `players-all:${q}:${team}` : null,
    (signal) => api(`/players?${new URLSearchParams({ q, ...(team ? { team } : {}), active: 'false' })}`, { signal }));
  const hiddenRetired = active && hidden.data ? hidden.data.meta.total - (data?.meta.total ?? 0) : 0;

  const rows = data?.data ?? [];
  const meta = data?.meta;
  return (
    <>
      <PageTitle>Players</PageTitle>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <label className="flex grow flex-col gap-1.5 text-[13px] font-semibold">Search by name
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder='Try "jokic", "cook" or "lebron"'
            className="h-11 rounded-lg border border-field bg-card px-3 text-base font-normal" />
        </label>
        <Select id="team" label="Team" value={team} onChange={(v) => update('team', v)} className="sm:w-60">
          <option value="">All teams</option>
          {(teams.data?.data ?? []).slice().sort((a, b) => a.full_name.localeCompare(b.full_name)).map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
        </Select>
        <label className="flex h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-field bg-card px-4 text-[15px] font-semibold">
          <input type="checkbox" checked={active} onChange={() => update('active', active ? 'false' : '')} className="h-5 w-5 accent-ink" />
          Active only
        </label>
      </div>
      {loading && <Loading label="Searching…" />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (
        <>
          <div className="text-sm text-muted">
            {meta.truncated ? `Showing the first ${rows.length} of ${meta.total} players — type a name to narrow it down` : `${meta.total} player${meta.total === 1 ? '' : 's'}`}
            {hiddenRetired > 0 ? ` · ${hiddenRetired} retired hidden by "Active only"` : ''}
          </div>
          {rows.length === 0
            ? <Empty>{hiddenRetired > 0 ? 'No active players match. Turn off "Active only" to include retired players (2003-04 onward).' : 'No players match that name.'}</Empty>
            : (
              <ul className="m-0 list-none rounded-[10px] border border-line bg-card p-0">
                {rows.map((p) => (
                  <li key={p.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 border-b border-rule px-4 py-3 last:border-b-0 sm:grid-cols-[1fr_200px_110px] sm:px-5">
                    <Link to={`/players/${p.id}`} className="text-base font-semibold">{p.full_name}</Link>
                    <span className="col-start-1 row-start-2 text-sm text-muted empty:hidden sm:col-start-2 sm:row-start-1 sm:empty:block">{[p.team, p.listed_position].filter(Boolean).join(' · ')}</span>
                    <span className={`row-span-2 justify-self-end rounded-full px-2.5 py-1 text-[13px] font-semibold sm:row-span-1 ${p.is_active ? 'bg-[#DDEBDF] text-[#1C5B2E]' : 'bg-rule text-[#3F434C]'}`}>{p.is_active ? 'Active' : 'Retired'}</span>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </>
  );
}
