// NBA.com standings -> team_seasons (official conference rank + W-L), used by
// db:backfill and db:standings. Rank ties are NBA.com's tiebreakers.
export function standingsRows(season, standings, teamByNba) {
  return standings.map((s) => {
    const team = teamByNba.get(String(s.TeamID));
    if (!team) throw new Error(`standings ${season}: unknown NBA.com team id ${s.TeamID}`);
    const clinch = String(s.ClinchIndicator ?? '').replace(/^[\s-]+/, '').trim() || null;
    return { season, team_id: team, conference: s.Conference, conference_rank: Number(s.PlayoffRank),
      division_rank: s.DivisionRank == null ? null : Number(s.DivisionRank), wins: Number(s.WINS), losses: Number(s.LOSSES), clinch };
  });
}

export async function writeStandings(db, season, standings, teamByNba) {
  const r = standingsRows(season, standings, teamByNba);
  if (!r.length) return 0;
  const col = (k) => r.map((x) => x[k]);
  const res = await db.query(
    `INSERT INTO team_seasons (season, team_id, conference, conference_rank, division_rank, wins, losses, clinch, updated_at)
     SELECT *, now() FROM unnest($1::text[], $2::int[], $3::text[], $4::smallint[], $5::smallint[], $6::smallint[], $7::smallint[], $8::text[])
     ON CONFLICT (season, team_id) DO UPDATE SET conference = EXCLUDED.conference, conference_rank = EXCLUDED.conference_rank,
       division_rank = EXCLUDED.division_rank, wins = EXCLUDED.wins, losses = EXCLUDED.losses, clinch = EXCLUDED.clinch, updated_at = now()`,
    ['season', 'team_id', 'conference', 'conference_rank', 'division_rank', 'wins', 'losses', 'clinch'].map(col));
  return res.rowCount;
}
