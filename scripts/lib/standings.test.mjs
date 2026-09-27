import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standingsRows } from './standings.mjs';

test('standings: NBA.com rows -> team_seasons (clinch indicator cleaned, unknown team rejected)', () => {
  const map = new Map([['1610612752', 20]]);
  const [r] = standingsRows('2025-26', [{ TeamID: 1610612752, Conference: 'East', PlayoffRank: 3, DivisionRank: 2, WINS: 53, LOSSES: 29, ClinchIndicator: ' - x' }], map);
  assert.deepEqual(r, { season: '2025-26', team_id: 20, conference: 'East', conference_rank: 3, division_rank: 2, wins: 53, losses: 29, clinch: 'x' });
  assert.throws(() => standingsRows('2025-26', [{ TeamID: 1, Conference: 'East', PlayoffRank: 1, WINS: 1, LOSSES: 0 }], map), /unknown/);
});
