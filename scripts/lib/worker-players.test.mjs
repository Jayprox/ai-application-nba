import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkToWorkerCreated } from './worker-players.mjs';

test('NBA.com newcomer links to the player the worker created (accents, team), never twice', () => {
  const pool = [{ id: 'w1', name: 'Nikola Djurisic', teamId: 1 }, { id: 'w2', name: 'Chris Jones', teamId: 2 }, { id: 'w3', name: 'Chris Jones', teamId: 3 }];
  const m = linkToWorkerCreated([
    { nbaId: 10, name: 'Nikola Đurišić', teamId: 1 },   // accent variant, same team
    { nbaId: 11, name: 'Chris Jones', teamId: 3 },      // same name twice in pool: team decides
    { nbaId: 12, name: 'Chris Jones', teamId: 9 },      // unknown team + two candidates: no guess
    { nbaId: 13, name: 'Brand New', teamId: 1 },
  ], pool);
  assert.deepEqual(Object.fromEntries(m), { 10: 'w1', 11: 'w3' });
});
