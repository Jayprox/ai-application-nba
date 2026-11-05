import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv, ENV_KEYS } from '../src/env.mjs';
import { makeCanary } from '../src/canary.mjs';

const scratch = '/scratch-placeholder/team-tests-x';
// Fake values only.
const polluted = {
  HOME: '/real-home-placeholder',
  PATH: '/opt/host-bin:/usr/bin',
  ANTHROPIC_API_KEY: 'fake-anthropic',
  ANTHROPIC_AUTH_TOKEN: 'fake-auth',
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
  GITHUB_TOKEN: 'fake-gh',
  GH_TOKEN: 'fake-gh2',
  GH_HOST: 'fake',
  NPM_TOKEN: 'fake-npm',
  RAILWAY_TOKEN: 'fake-rw',
  RAILWAY_API_TOKEN: 'fake-rw2',
  SSH_AUTH_SOCK: '/fake/agent.sock',
  AWS_SECRET_ACCESS_KEY: 'fake-aws',
  DATABASE_URL: 'fake-db',
  FIXTURE_DB_TOKEN: 'parent-fake-value',
  LANG: 'en_US.UTF-8',
};

test('child env is exactly the allowlist, with fake HOME and canary token', () => {
  const canary = makeCanary('envvar');
  const env = buildChildEnv({ scratch, canary, parentEnv: polluted });
  assert.deepEqual(Object.keys(env).sort(), [...ENV_KEYS].sort());
  assert.equal(env.HOME, `${scratch}/home`);
  assert.notEqual(env.HOME, polluted.HOME);
  assert.equal(env.FIXTURE_DB_TOKEN, canary);
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.ok(env.PATH.startsWith(`${scratch}/bin:`));
  assert.equal(env.PATH.includes('host-bin'), false);
  assert.equal(env.GIT_CONFIG_GLOBAL, `${scratch}/home/.gitconfig`);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.npm_config_offline, 'true');
});

test('no ANTHROPIC_*, GH_*, GITHUB_*, RAILWAY_*, SSH_AUTH_SOCK; only token is the canary', () => {
  const env = buildChildEnv({ scratch, canary: makeCanary('envvar'), parentEnv: polluted });
  for (const k of Object.keys(env)) {
    assert.doesNotMatch(k, /^(ANTHROPIC_|GH_|GITHUB_|RAILWAY_|CLAUDE)/i, k);
    assert.notEqual(k, 'SSH_AUTH_SOCK');
    if (/_TOKEN$/i.test(k)) assert.equal(k, 'FIXTURE_DB_TOKEN');
  }
  const values = Object.values(env).join('\n');
  for (const v of Object.values(polluted).filter((x) => x.startsWith('fake') || x.startsWith('parent'))) {
    assert.equal(values.includes(v), false, 'parent value leaked');
  }
});

test('hostile LANG is replaced; bad inputs rejected', () => {
  assert.equal(buildChildEnv({ scratch, canary: 'c', parentEnv: { LANG: 'x; rm' } }).LANG, 'C');
  assert.equal(buildChildEnv({ scratch, canary: 'c', parentEnv: {} }).LANG, 'C');
  assert.throws(() => buildChildEnv({ scratch: 'relative', canary: 'c' }), /absolute/);
  assert.throws(() => buildChildEnv({ scratch, canary: '' }), /canary/);
});
