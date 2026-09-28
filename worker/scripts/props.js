// Player props by hand, from JD's Mac (reads the repo-root .env: ODDS_API_KEY,
// DATABASE_PUBLIC_URL). The Railway worker does this on its own schedule.
//
//   npm run props -- --check                      upcoming events + credits left (free)
//   npm run props -- --capture <eventId> [--sport basketball_wnba]
//                                                 save one event's DraftKings props to
//                                                 test/fixtures/odds/ (<= 120 credits)
//   npm run props -- --date 2026-10-21 --snapshot close
//                                                 pull lines now for our games that ET date
import { readFileSync, writeFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }
process.env.DATABASE_URL ??= process.env.DATABASE_PUBLIC_URL;

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const { createOdds } = await import('../src/odds.js');
const odds = createOdds({ sport: opt('--sport') ?? 'basketball_nba' });
if (!process.env.ODDS_API_KEY) { console.error('ODDS_API_KEY is not set (repo-root .env)'); process.exit(1); }

if (args.includes('--check')) {
  const now = Date.now();
  const evs = (await odds.events(now, now + 14 * 86400e3)) ?? [];
  console.log(`${evs.length} event(s) in the next 14 days`);
  for (const e of evs.slice(0, 15)) console.log(`  ${e.commence_time}  ${e.away_team} @ ${e.home_team}  id=${e.id}`);
  console.log(`credits left: ${odds.quota.remaining ?? '?'} (used ${odds.quota.used ?? '?'})`);
} else if (opt('--capture')) {
  const id = opt('--capture');
  const j = await odds.eventOdds(id);
  if (!j) { console.error('event not found'); process.exit(1); }
  const file = new URL(`../test/fixtures/odds/event-odds_${id}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(j, null, 2));
  const { linesFromEvent } = await import('../src/odds-map.js');
  const lines = linesFromEvent(j);
  console.log(`saved ${file.pathname}: ${lines.length} DraftKings lines, ${new Set(lines.map((l) => l.name)).size} players · cost ${odds.quota.last} credits, ${odds.quota.remaining} left`);
} else if (opt('--date')) {
  const date = opt('--date'), snapshot = opt('--snapshot') ?? 'close';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['open', 'close'].includes(snapshot)) { console.error('usage: --date YYYY-MM-DD --snapshot open|close'); process.exit(1); }
  const { createPool } = await import('../src/db.js');
  const { runProps } = await import('../src/index.js');
  const db = createPool();
  try {
    const { rows } = await db.query(`SELECT id FROM games WHERE game_date_local = $1 AND season_type <> 'preseason' AND tipoff_utc IS NOT NULL`, [date]);
    if (!rows.length) console.log(`no games on ${date}`);
    else await runProps(db, odds, { open: snapshot === 'open' ? rows.map((r) => r.id) : [], close: snapshot === 'close' ? rows.map((r) => r.id) : [], reason: 'npm run props' }, { triggeredBy: 'manual' });
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  await db.end();
} else {
  console.error('usage: npm run props -- --check | --capture <eventId> [--sport ...] | --date YYYY-MM-DD --snapshot open|close');
  process.exit(1);
}
