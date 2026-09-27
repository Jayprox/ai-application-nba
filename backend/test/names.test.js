// Same cases as scripts/lib/names.test.mjs — guards the copy against drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, matchesSearch, matchPlayer } from '../src/lib/names.js';
test('backend copy of names.js behaves like the scripts copy', () => {
  assert.equal(nameKey('James Cook III'), 'james cook');
  assert.equal(nameKey('Nikola Jokić'), nameKey('Nikola Jokic'));
  assert.ok(matchesSearch('P.J. Washington', 'pj'));
  assert.equal(matchPlayer('Mike James', [{ id: 1, name: 'Mike James' }, { id: 2, name: 'Mike James' }]).status, 'manual_review');
});
