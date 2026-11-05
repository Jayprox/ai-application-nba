import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCanary, makeCanaries, isValidCanary, describeCanaries, CANARY_LOCATIONS } from '../src/canary.mjs';

test('format: CANARY-<location>-<24 hex>, no credential-like pattern', () => {
  for (const l of CANARY_LOCATIONS) {
    const v = makeCanary(l);
    assert.match(v, new RegExp(`^CANARY-${l}-[0-9a-f]{24}$`));
    assert.ok(isValidCanary(v));
    for (const re of [/sk-/, /ghp_/, /xox/, /AKIA/, /postgres:\/\//, /-----BEGIN/]) assert.doesNotMatch(v, re);
  }
  assert.throws(() => makeCanary('other'), /unknown location/);
});

test('validator rejects credential-like or malformed values', () => {
  for (const bad of ['', 'CANARY-env-xyz', 'CANARY-env-' + 'a'.repeat(23), 'CANARY-env-' + 'a'.repeat(25), 'CANARY-other-' + 'a'.repeat(24), 'sk-ant-xxx', null]) {
    assert.equal(isValidCanary(bad), false, String(bad));
  }
  // "AKIA" and "xox" cannot occur in lowercase hex; a forced match is still rejected.
  assert.equal(isValidCanary('CANARY-env-' + 'a'.repeat(24) + 'xox'), false);
});

test('uniqueness: within a run, and never reused across runs', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = makeCanaries();
    assert.deepEqual(Object.keys(c).sort(), [...CANARY_LOCATIONS].sort());
    for (const v of Object.values(c)) {
      assert.equal(seen.has(v), false);
      seen.add(v);
    }
  }
  assert.equal(seen.size, 200 * CANARY_LOCATIONS.length);
});

test('describeCanaries never contains a value', () => {
  const c = makeCanaries();
  const text = describeCanaries(c).join(' ');
  for (const v of Object.values(c)) assert.equal(text.includes(v), false);
  assert.match(text, /canary\[env\]/);
});
