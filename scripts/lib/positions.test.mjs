import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionsFromIndex, positionUpdates } from './positions.mjs';

test('positions: NBA.com player index fills only players with no listed position (retired players included)', () => {
  const idx = positionsFromIndex([
    { PERSON_ID: 977, POSITION: 'F-G' },        // Kobe Bryant (retired: no roster row, so no position from the seed)
    { PERSON_ID: 1495, POSITION: 'C-F' },       // Tim Duncan
    { PERSON_ID: 203999, POSITION: 'C' },       // Jokić (already listed by his roster)
    { PERSON_ID: 1, POSITION: '' }, { PERSON_ID: 2, POSITION: 'Guard' },
  ]);
  assert.deepEqual([...idx], [['977', 'F-G'], ['1495', 'C-F'], ['203999', 'C']]);
  const up = positionUpdates([
    { id: 'kobe', nba_id: '977', listed_position: null },
    { id: 'duncan', nba_id: 1495, listed_position: '' },
    { id: 'jokic', nba_id: '203999', listed_position: 'C' },
    { id: 'nobody', nba_id: '5', listed_position: null },
  ], idx);
  assert.deepEqual(up, [{ id: 'kobe', pos: 'F-G' }, { id: 'duncan', pos: 'C-F' }]);
});
