import { describe, expect, it } from 'vitest';
import { gameContext, isYmd, longDate, made, mins, pm, restLabel, tinyDate, todayLocal, tvLabel } from './format.js';

describe('format', () => {
  it('dates never shift a day', () => {
    expect(longDate('2026-04-12')).toBe('Sunday, April 12, 2026');
    expect(todayLocal(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(isYmd('2026-02-30')).toBe(true);    // Date rolls over; the backend decides
    expect(isYmd('bad')).toBe(false);
    expect(tinyDate('2026-10-03', '2026-08-01')).toBe('Oct 3');
    expect(tinyDate('2020-08-15', '2026-08-01')).toBe('Aug 15, 2020');
  });
  it('rest labels', () => {
    expect(restLabel(1, null)).toBe('1 day rest');
    expect(restLabel(0, 2)).toBe('0 days rest · 2nd night of a back-to-back');
    expect(restLabel(3, 1)).toBe('3 days rest · 1st night of a back-to-back');
    expect(restLabel(null, null)).toBe('no prior game this season');
  });
  it('game context', () => {
    expect(gameContext({ season_type: 'playoffs', series_round: 4, series_game_number: 7 })).toBe('NBA Finals · Game 7');
    expect(gameContext({ season_type: 'regular', cup_stage: 'group', is_neutral_site: true, arena_city: 'Mexico City' })).toBe('NBA Cup group · in Mexico City');
    expect(gameContext({ season_type: 'regular' })).toBe('');
  });
  it('box score cells', () => {
    expect(mins('35.00')).toBe('35');
    expect(pm(7)).toBe('+7'); expect(pm(-3)).toBe('-3'); expect(pm(null)).toBe('');
    expect(made(9, 11)).toBe('9-11');
    expect(tvLabel('major', ['ESPN'])).toBe('National TV: ESPN');
    expect(tvLabel('local', [])).toBe('Local TV only');
  });
});
