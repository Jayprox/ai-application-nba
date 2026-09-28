// Does Highlightly have NBA injuries? (architecture.md §3.2 — open question,
// to re-test once preseason games exist.) From JD's Mac:
//   npm run injuries-probe -- --date 2026-10-03
// Looks at every NBA match that ET date: the match detail, box score and
// lineups, and reports any field whose name mentions injury/status/absence,
// with a sample. Costs ~3 requests per match. Changes nothing.
import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const args = process.argv.slice(2);
const date = args[args.indexOf('--date') + 1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) { console.error('usage: npm run injuries-probe -- --date YYYY-MM-DD'); process.exit(1); }
const { createHighlightly } = await import('../src/highlightly.js');
const hl = createHighlightly();

const PATTERN = /injur|absen|inactive|out_?reason|missing|unavailable|health/i;
/** Every path in a JSON value whose key matches PATTERN, with a short sample. */
function find(v, path = '$', out = []) {
  if (Array.isArray(v)) { v.slice(0, 50).forEach((x, i) => find(x, `${path}[${i}]`, out)); return out; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = `${path}.${k}`;
      if (PATTERN.test(k)) out.push(`${p} = ${JSON.stringify(x)?.slice(0, 200)}`);
      find(x, p, out);
    }
  }
  return out;
}

const matches = await hl.matches(date);
console.log(`${date}: ${matches.length} NBA match(es) on Highlightly`);
let any = 0;
for (const m of matches) {
  const label = `${m.awayTeam?.abbreviation}@${m.homeTeam?.abbreviation} (${m.id}, ${m.state?.description ?? '?'})`;
  const hits = [];
  for (const [what, fn] of [['match', () => hl.match(m.id)], ['box-score', () => hl.boxScore(m.id)], ['lineups', () => hl.lineups(m.id)]]) {
    try { hits.push(...find(await fn()).map((h) => `${what}: ${h}`)); } catch (e) { hits.push(`${what}: request failed (${e.message.slice(0, 80)})`); }
  }
  const real = hits.filter((h) => !h.includes('request failed'));
  any += real.length;
  console.log(`\n${label}: ${real.length ? `${real.length} injury-looking field(s)` : 'nothing injury-looking'}`);
  for (const h of hits.slice(0, 8)) console.log(`  ${h}`);
}
console.log(`\n${any ? 'Highlightly returned injury-looking data — paste this output to Claude.' : 'No injury data found for this date.'} Quota left: ${hl.quota.remaining ?? '?'}`);
