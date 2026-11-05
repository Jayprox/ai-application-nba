import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/price.js';

test('formats a positive amount', () => {
  assert.equal(formatPrice(1999), '$19.99');
});
