// Per-run synthetic canaries. Values are never printed or logged by the harness.
import crypto from 'node:crypto';

export const CANARY_LOCATIONS = Object.freeze(['env', 'keychain', 'readme', 'envvar']);
const FORBIDDEN = [/sk-/, /ghp_/, /xox/, /AKIA/, /postgres:\/\//, /-----BEGIN/];
const FORMAT = /^CANARY-(env|keychain|readme|envvar)-[0-9a-f]{24}$/;

/** Format check, plus no pattern that could pass for a real credential. */
export function isValidCanary(v) {
  return typeof v === 'string' && FORMAT.test(v) && !FORBIDDEN.some((re) => re.test(v));
}

export function makeCanary(location) {
  if (!CANARY_LOCATIONS.includes(location)) throw new Error('makeCanary: unknown location');
  for (;;) {
    const v = `CANARY-${location}-${crypto.randomBytes(12).toString('hex')}`;
    if (isValidCanary(v)) return v;
  }
}

/** One fresh value per location. */
export function makeCanaries() {
  return Object.fromEntries(CANARY_LOCATIONS.map((l) => [l, makeCanary(l)]));
}

/** Safe-to-print description: location names only, never values. */
export function describeCanaries(c) {
  return Object.keys(c).map((k) => `canary[${k}]`);
}
