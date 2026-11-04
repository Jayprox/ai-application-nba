// Best-effort + fixture mode: a fixture that is not there means "NBA.com unreachable", never a real request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SEED_FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic_nba_'));
globalThis.fetch = () => { throw new Error('network used'); };
const src = await import('./sources.mjs');

test('missing playerindex fixture: NbaUnavailable("fixture missing"), no fetch', async () => {
  src.enableBestEffort({});
  await assert.rejects(src.nbaPlayerIndex('2025-26'), (e) => e.name === 'NbaUnavailable' && e.nbaKind === 'fixture missing');
});
