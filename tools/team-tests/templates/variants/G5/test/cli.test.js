import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';

test('prints a labelled price', () => {
  assert.equal(run(['Pen', '150']), 'Pen: $1.50');
});
