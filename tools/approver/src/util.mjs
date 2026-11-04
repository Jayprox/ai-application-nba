import crypto from 'node:crypto';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Canonical JSON: keys sorted at every level, no whitespace. This is the form whose hash matched
// the transcript's tool_use input in the Step A verification.
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
