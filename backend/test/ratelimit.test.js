import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/ratelimit.js';

test('limiter: counts failures in a sliding window; success clears the account counter', () => {
  let t = 0;
  const l = createLimiter({ windowMs: 1000, perKey: 3, perIp: 5, now: () => t });
  for (let i = 0; i < 3; i++) l.fail('1.1.1.1', 'jd');
  assert.ok(l.blockedFor('1.1.1.1', 'jd') > 0);
  assert.equal(l.blockedFor('2.2.2.2', 'jd'), 0, 'another IP is not blocked');
  t = 1001;
  assert.equal(l.blockedFor('1.1.1.1', 'jd'), 0, 'window expired');
  l.fail('1.1.1.1', 'jd'); l.fail('1.1.1.1', 'jd'); l.succeed('1.1.1.1', 'jd');
  assert.equal(l.blockedFor('1.1.1.1', 'jd'), 0);
  for (let i = 0; i < 5; i++) l.fail('1.1.1.1', `user${i}`);
  assert.ok(l.blockedFor('1.1.1.1', 'anyone') > 0, 'spraying many accounts from one IP is blocked');
  t = 5000;
  l.sweep();
  assert.equal(l.size(), 0, 'expired entries are dropped');
});
