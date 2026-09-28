import { describe, expect, it } from 'vitest';
import { buildQuery } from './StatExplorer.jsx';

const base = { season: '2025-26', type: 'regular', scope: 'season', restby: 'player', venue: null, b2b: null, rest: null, tv: null, alt: null };

describe('StatExplorer -> POST /query body', () => {
  it('player rest filters use the PLAYER\'s own games by default', () => {
    expect(buildQuery('player', 'p1', { ...base, rest: '3+', b2b: '2' }).splits).toEqual({ player_rest: '3+', player_b2b: 2 });
  });
  it('"Team\'s schedule" switches a player query to team rest', () => {
    expect(buildQuery('player', 'p1', { ...base, restby: 'team', rest: '1' }).splits).toEqual({ rest: 1 });
  });
  it('team queries always use team rest (the API rejects player_* for teams)', () => {
    expect(buildQuery('team', 7, { ...base, rest: '0', b2b: '1' }).splits).toEqual({ rest: 0, b2b: 1 });
  });
  it('other splits map to API names and types', () => {
    expect(buildQuery('player', 'p1', { ...base, venue: 'home', tv: 'nba_tv', alt: 'no' }).splits).toEqual({ venue: 'home', national_tv: 'nba_tv', altitude: false });
  });
  it('career drops the season; other scopes keep it', () => {
    expect(buildQuery('player', 'p1', { ...base, scope: 'career' })).not.toHaveProperty('season');
    expect(buildQuery('player', 'p1', { ...base, scope: 'last10' })).toMatchObject({ season: '2025-26', scope: 'last10', season_type: 'regular' });
  });
  it('prop lines ride along on averaged player scopes only', () => {
    const lines = { pts: 25.5, pra: 38.5 };
    expect(buildQuery('player', 'p1', { ...base, scope: 'last10' }, lines).lines).toEqual(lines);
    expect(buildQuery('player', 'p1', { ...base, scope: 'game_log' }, lines)).not.toHaveProperty('lines');
    expect(buildQuery('team', 7, base, lines)).not.toHaveProperty('lines');
    expect(buildQuery('player', 'p1', base, {})).not.toHaveProperty('lines');
    expect(buildQuery('player', 'p1', base, null)).not.toHaveProperty('lines');
  });
});
