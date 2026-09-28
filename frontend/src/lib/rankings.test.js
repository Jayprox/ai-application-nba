import { expect, it } from 'vitest';
import { matchupText, ordinal } from './rankings.js';

it('ordinals, including the teens', () => {
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '30th', '101st', '111th']);
  expect(ordinal(null)).toBe('');
});

it('props matchup note text', () => {
  expect(matchupText({ opponent: 'BOS', rank: 27, of: 30, position_label: 'Guards' })).toBe('BOS: 27th of 30 vs guards');
  expect(matchupText(null)).toBe(null);
});
