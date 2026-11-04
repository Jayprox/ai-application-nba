// Test helpers: build `synthetic_*` fixture directories at run time by editing the recorded Highlightly
// shapes (same field names, never invented formats). Everything built here is synthetic and is listed
// in test/fixtures/weekly/README.md.
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REC = new URL('../fixtures/weekly/recorded', import.meta.url).pathname;
export const recorded = (name) => JSON.parse(readFileSync(path.join(REC, `${name}.json`), 'utf8'));

/** A fresh empty `synthetic_*` dir; `files` is { 'matches_2026-04-12': obj | {raw}, ... }. */
export function synthDir(files = {}, { copyRecorded = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'synthetic_hl_'));
  if (copyRecorded) cpSync(REC, dir, { recursive: true });
  for (const [name, v] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(v));
  return dir;
}
export const putMeta = (dir, name, meta) => writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify(meta));
export const putQuota = (dir, q) => writeFileSync(path.join(dir, '_quota.json'), JSON.stringify(q));

/** One recorded match edited into a synthetic one. */
export function match(over = {}) {
  const m = structuredClone(recorded('matches_2026-04-12').data[0]);
  return { ...m, ...over };
}
