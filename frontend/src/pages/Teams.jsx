import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/useFetch.js';
import { PageTitle } from '../components/Controls.jsx';
import { ErrorBox, Loading } from '../components/States.jsx';

export const useTeams = () => useFetch('teams', (signal) => api('/teams', { signal }));

export default function Teams() {
  const { data, error, loading, retry } = useTeams();
  const teams = data?.data ?? [];
  const confs = ['East', 'West'].map((c) => ({
    name: `${c}ern Conference`,
    divs: [...new Set(teams.filter((t) => t.conference === c).map((t) => t.division))].sort()
      .map((d) => ({ name: d, teams: teams.filter((t) => t.conference === c && t.division === d) })),
  }));
  const altitude = teams.filter((t) => t.is_high_altitude).map((t) => t.city);
  return (
    <>
      <PageTitle>Teams</PageTitle>
      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={retry} />}
      {data && (
        <>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            {confs.map((c) => (
              <section key={c.name} className="flex flex-col gap-4">
                <h2 className="m-0 border-b-[3px] border-ink pb-1.5 font-display text-[30px] font-bold">{c.name}</h2>
                {c.divs.map((d) => (
                  <div key={d.name} className="flex flex-col gap-1.5">
                    <h3 className="eyebrow m-0 tracking-[0.08em]">{d.name}</h3>
                    <ul className="m-0 list-none rounded-[10px] border border-line bg-card p-0">
                      {d.teams.map((t) => (
                        <li key={t.id} className="flex min-h-11 items-center justify-between gap-3 border-b border-rule px-4 last:border-b-0">
                          <Link to={`/teams/${t.id}`} className="py-2.5 text-[15px] font-semibold">{t.full_name}</Link>
                          {t.is_high_altitude && <span className="shrink-0 rounded-full bg-alt-bg px-2 py-0.5 text-xs font-semibold text-alt-ink">Altitude arena</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
          </div>
          <p className="m-0 text-[13px] text-muted">"Altitude arena" = home arena at 4,000 ft or higher ({altitude.join(', ')}). The altitude split also counts road games there and in Mexico City.</p>
        </>
      )}
    </>
  );
}
