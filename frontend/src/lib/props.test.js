import { expect, it } from 'vitest';
import { hits, movement, price, ratePct, sortRows } from './props.js';

it('prices, hit counts, movement', () => {
  expect([price(105), price(-110), price(null)]).toEqual(['+105', '-110', '']);
  expect([hits({ over: 7, games: 10 }), hits({ over: 0, games: 0 }), ratePct({ over: 7, games: 10 }), ratePct(undefined)]).toEqual(['7/10', '—', '70%', '—']);
  expect(movement(24.5, 23.5)).toEqual({ dir: 'down', by: 1 });
  expect(movement(24.5, 24.5)).toBe(null);
  expect(movement(null, 24.5)).toBe(null);
});

it('board sort: over rate first, the bigger sample on equal rates, then the line', () => {
  const r = (name, over, games, line = 20.5, game_id = 'g1') => ({ name, line, game_id, last10: { over, games }, season: { over, games } });
  const rows = [r('A', 1, 1), r('B', 9, 10), r('C', 10, 10), r('D', 0, 0), r('E', 9, 10, 25.5, 'g0')];
  expect(sortRows(rows, 'l10').map((x) => x.name)).toEqual(['C', 'A', 'E', 'B', 'D']);   // 10/10 before 1/1; 9/10 at the higher line first; no games last
  expect(sortRows(rows, 'line').map((x) => x.name)[0]).toBe('E');
  expect(sortRows(rows, 'game', new Map([['g0', 0], ['g1', 1]])).map((x) => x.name)).toEqual(['E', 'A', 'B', 'C', 'D']);
});
