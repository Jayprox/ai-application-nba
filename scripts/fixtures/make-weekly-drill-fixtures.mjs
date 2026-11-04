// Weekly drill helper (M6, scripts/weekly-drill.sh cases W26-W32). Writes Highlightly fixture directories whose
// dates are relative to today (the weekly job's window is today-7 .. today+60), and prints the dates the seed
// SQL (db/tests/weekly_drill_seed.sql) needs as one JSON line. Local files only; no network.
//   node scripts/fixtures/make-weekly-drill-fixtures.mjs <outdir> [fake-key-for-the-redaction-case]
// All of it is SYNTHETIC (edited copies of the recorded Highlightly files under worker/test/fixtures/weekly/recorded).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir, fakeKey] = process.argv.slice(2);
if (!outDir) { console.error('usage: make-weekly-drill-fixtures.mjs <outdir> [key]'); process.exit(2); }
const REC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker/test/fixtures/weekly/recorded');
const rec = (n) => JSON.parse(readFileSync(path.join(REC, `${n}.json`), 'utf8'));
const et = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const DAY = 86400e3;
const now = new Date();
const today = et(now);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// G1: LAL @ GSW tomorrow (ET) at 17:00Z, scheduled; Highlightly says one hour later.  FIN: MEM @ HOU two days ago, final 132-101.
const g1Local = addDays(today, 1), finLocal = addDays(today, -2);
const g1Tip = `${g1Local}T17:00:00.000Z`, finTip = `${finLocal}T23:00:00.000Z`;
const g1Match = { ...rec('matches_2026-10-06').data.find((m) => m.id === 1545655), season: 2027, date: new Date(Date.parse(g1Tip) + 3600e3).toISOString() };
const finMatch = { ...rec('matches_2026-04-12').data.find((m) => m.id === 1439038), season: 2027, date: finTip };

function dir(name, { keyName } = {}) {
  const d = path.join(outDir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, `matches_${g1Local}.json`), JSON.stringify({ data: [g1Match], pagination: { totalCount: 1, offset: 0, limit: 100 } }));
  writeFileSync(path.join(d, `matches_${finLocal}.json`), JSON.stringify({ data: [finMatch], pagination: { totalCount: 1, offset: 0, limit: 100 } }));
  const box = rec('box-score_1439038');
  if (keyName) box[0].boxScores.at(-1).player.name = keyName;          // a player named exactly like the fake key
  writeFileSync(path.join(d, 'box-score_1439038.json'), JSON.stringify(box));
  cpSync(path.join(REC, 'lineups_1439038.json'), path.join(d, 'lineups_1439038.json'));
  return d;
}
dir('hl_ok');
writeFileSync(path.join(dir('hl_500'), `matches_${today}.meta.json`), JSON.stringify({ status: 500 }));
writeFileSync(path.join(dir('hl_reserve'), '_quota.json'), JSON.stringify({ limit: 7500, remaining: 1002 }));
writeFileSync(path.join(dir('hl_quota_ok'), '_quota.json'), JSON.stringify({ limit: 7500, remaining: 7400 }));
if (fakeKey) dir('hl_keyname', { keyName: fakeKey });
console.log(JSON.stringify({ today, g1_local: g1Local, g1_tip: g1Tip, fin_local: finLocal, fin_tip: finTip }));
