import { expect, it } from 'vitest';
import { arrangeBracket } from './Standings.jsx';

const s = (id, round, conference, higher_seed, lower_seed, slot = `${conference?.[0]}-${higher_seed}v${lower_seed}`) => ({ id, round, conference, higher_seed, lower_seed, bracket_slot: slot });

it('bracket order: first round 1v8, 4v5, 3v6, 2v7; semis by half; finals separate', () => {
  const b = arrangeBracket([
    s(1, 'first_round', 'East', 2, 7), s(2, 'first_round', 'East', 1, 8), s(3, 'first_round', 'East', 3, 6), s(4, 'first_round', 'East', 4, 5),
    s(5, 'conf_semis', 'East', 2, 3), s(6, 'conf_semis', 'East', 1, 4), s(7, 'finals', null, 1, 1, 'FINALS'),
    s(8, 'play_in', 'East', 9, 10), s(9, 'play_in', 'East', 7, 8), s(10, 'play_in', 'East', 8, 9, 'E-8seed'),
  ]);
  expect(b.East.first.map((x) => `${x.higher_seed}v${x.lower_seed}`)).toEqual(['1v8', '4v5', '3v6', '2v7']);
  expect(b.East.semis.map((x) => x.higher_seed)).toEqual([1, 2]);
  expect(b.East.playIn.map((x) => x.bracket_slot)).toEqual(['E-7v8', 'E-9v10', 'E-8seed']);
  expect(b.finals.id).toBe(7);
  expect(b.West.first).toEqual([]);
});
