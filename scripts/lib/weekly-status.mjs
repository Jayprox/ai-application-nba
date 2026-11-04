// The "weekly:" line of db:status (M6): derived from the ingestion_runs rows that share the newest weekly_run_id.
// rows: [{source, status, details}] in id order.
export function weeklyStatusLine(rows) {
  if (!rows.length) return '  weekly: no weekly run recorded yet';
  const hl = rows.filter((r) => r.source === 'highlightly'), nba = rows.filter((r) => r.source === 'nba_stats');
  const state = hl.map((r) => r.details?.nba_state).find((x) => x === 'down' || x === 'disabled')
    ?? (nba.some((r) => r.status === 'failed') ? 'down' : nba.length ? 'ok' : 'unknown');
  const stop = hl.map((r) => r.details?.stop).find(Boolean) ?? null;
  const requests = hl.reduce((n, r) => n + (r.details?.requests?.total ?? 0), 0);
  const lastQ = [...hl].reverse().map((r) => r.details?.quota).find((x) => x?.remaining != null);
  const degraded = (state !== 'ok') || Boolean(stop) || rows.some((r) => r.status === 'failed');
  const sources = ['highlightly', ...(nba.some((r) => r.status === 'success') ? ['nba_stats'] : [])].join('+');
  return `  weekly: ${rows[0].details.weekly_run_id} source=${sources} degraded=${degraded ? 'yes' : 'no'}` +
    ` (nba=${state}${stop ? `; stop=${stop}` : ''}) hl_requests=${requests} quota=${lastQ ? `${lastQ.remaining}/${lastQ.limit}` : 'unknown'}`;
}
