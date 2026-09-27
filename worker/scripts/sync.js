// From JD's Mac: `npm run sync -- --date 2026-10-06` — same code path as the
// Railway loop, run once for the given ET date(s). Reads the repo-root .env
// (DATABASE_PUBLIC_URL, HIGHLIGHTLY_API_KEY).
import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }
process.env.DATABASE_URL ??= process.env.DATABASE_PUBLIC_URL;

const args = process.argv.slice(2);
const dates = args.flatMap((a, i) => (a === '--date' ? [args[i + 1]] : []));
if (!dates.length || !dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''))) {
  console.error('usage: npm run sync -- --date YYYY-MM-DD [--date YYYY-MM-DD ...]');
  process.exit(1);
}
const { createPool } = await import('../src/db.js');
const { createHighlightly } = await import('../src/highlightly.js');
const { runDates } = await import('../src/index.js');
const db = createPool();
try { await runDates(db, createHighlightly(), dates, { triggeredBy: 'manual', reason: 'npm run sync' }); }
catch (e) { console.error(e.message); process.exitCode = 1; }
await db.end();
