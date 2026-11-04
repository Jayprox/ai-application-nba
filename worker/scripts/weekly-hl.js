// Weekly Highlightly step (M6, docs/plans/M6-highlightly-weekly.md §4.4). Run by scripts/weekly.mjs through the
// Railway tunnel, or by hand:
//   npm --prefix worker run weekly-hl -- schedule --season 2026-27 [--dry-run]
//   npm --prefix worker run weekly-hl -- backfill --season 2026-27 [--dry-run]
//
// DB: DATABASE_PUBLIC_URL only (process env wins over the repo .env). DATABASE_URL is never used, so a .env
// value can't redirect a tunnel run. Key: HIGHLIGHTLY_API_KEY from env, else the repo .env; never argv; not
// needed with HIGHLIGHTLY_FIXTURES. Everything this process prints has the key masked, and vendor strings are
// stripped of control characters. The LAST stdout line is the result line the runner parses:
//   @@WEEKLY {"v":1,"step":"schedule:hl","degraded":false,"nba":"n/a","skipped":[],"stop":null,"hl":{...},"reason":null}
// Exit 0 = done (degraded or not); 1 = Highlightly failure, database error or bad usage.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const started = Date.now();
const ENV_FILE = process.env.WEEKLY_HL_ENV_FILE || new URL('../../.env', import.meta.url).pathname;

// ---- 1. key + DB url (env first; the .env file is read only when something is still missing) --------
const fromFile = (names) => {
  const out = {};
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && names.includes(m[1])) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return out;
};
const fixtures = process.env.HIGHLIGHTLY_FIXTURES || '';
const need = ['DATABASE_PUBLIC_URL', ...(fixtures ? [] : ['HIGHLIGHTLY_API_KEY'])].filter((n) => !process.env[n]);
const file = need.length ? fromFile(need) : {};
const KEY = process.env.HIGHLIGHTLY_API_KEY || file.HIGHLIGHTLY_API_KEY || '';
const DB_URL = process.env.DATABASE_PUBLIC_URL || file.DATABASE_PUBLIC_URL || '';

// ---- 2. self-redaction, before anything can print --------------------------------------------------
for (const s of [process.stdout, process.stderr]) s._handle?.setBlocking?.(true);      // process.exit() must not lose the result line
const mask = (s) => (KEY.length >= 4 ? String(s).split(KEY).join('[redacted]') : String(s));
for (const stream of [process.stdout, process.stderr]) {
  const w = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => w(typeof chunk === 'string' ? mask(chunk) : mask(Buffer.from(chunk).toString('utf8')), ...rest);
}
const { clean } = await import('../src/weekly-util.js');

const STEP = process.argv[2] === 'backfill' ? 'backfill:hl' : 'schedule:hl';
let result = { v: 1, step: STEP, degraded: false, nba: 'n/a', skipped: [], stop: null, hl: { requests: 0, limit: null, remaining: null }, reason: null };
const emit = () => process.stdout.write(`@@WEEKLY ${JSON.stringify(result)}\n`);
function die(reason, code = 1) {
  result = { ...result, reason: clean(reason, 200) };
  console.error(`[hl ${STEP.split(':')[0]}] FAILED: ${result.reason}`);
  emit();
  process.exit(code);
}
const unexpected = (e) => die(`unexpected error (${clean(e?.name || 'Error', 40)})`);
process.on('uncaughtException', unexpected);
process.on('unhandledRejection', unexpected);

// ---- 3. arguments and configuration -----------------------------------------------------------------
const argv = process.argv.slice(2);
const mode = argv[0];
if (!['schedule', 'backfill'].includes(mode)) die('usage: weekly-hl.js schedule|backfill --season YYYY-YY [--dry-run]');
const si = argv.indexOf('--season');
const season = si > 0 ? argv[si + 1] : '';
if (!/^\d{4}-\d{2}$/.test(season ?? '')) die('bad --season');
const unknownArg = argv.slice(1).find((a, i, arr) => !['--season', '--dry-run'].includes(a) && arr[i - 1] !== '--season');
if (unknownArg) die('unknown argument');
const intEnv = (name, dflt, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) < min || Number(raw) > max) die(`bad configuration: ${name} must be ${min}..${max}`);
  return Number(raw);
};
const cap = intEnv('WEEKLY_HL_CAP', 600, 1, 600);
const reserve = intEnv('WEEKLY_HL_RESERVE', 1000, 1000, 100000);
const rps = intEnv('WEEKLY_HL_RPS', 4, 1, 10);
const daysBack = intEnv('WEEKLY_HL_DAYS_BACK', 7, 1, 30);
const daysAhead = intEnv('WEEKLY_HL_DAYS_AHEAD', 60, 0, 120);
const budget = intEnv('WEEKLY_HL_BUDGET', cap, 0, 600);
const lastRemaining = process.env.WEEKLY_HL_LAST_REMAINING && /^\d{1,7}$/.test(process.env.WEEKLY_HL_LAST_REMAINING) ? Number(process.env.WEEKLY_HL_LAST_REMAINING) : null;
const dryRun = argv.includes('--dry-run') || process.env.WEEKLY_DRY_RUN === '1';
const sweep = { enabled: process.env.WEEKLY_HL_FULL_SEASON === '1', threshold: 3000 };
const tipoffAuthority = process.env.WEEKLY_HL_TIPOFF === '1';           // set by the runner only when NBA.com did not load
const nbaState = ['ok', 'down', 'disabled', 'skipped'].includes(process.env.WEEKLY_NBA_STATE) ? process.env.WEEKLY_NBA_STATE : null;
const runId = /^[A-Za-z0-9:_-]{1,64}$/.test(process.env.WEEKLY_RUN_ID ?? '') ? process.env.WEEKLY_RUN_ID : null;

if (!DB_URL) die('DATABASE_PUBLIC_URL is not set');
let host;
try { host = new URL(DB_URL).hostname; } catch { die('DATABASE_PUBLIC_URL is not a valid URL'); }
if (host.endsWith('.railway.internal')) die('DATABASE_PUBLIC_URL is the private Railway host');
if (!fixtures && !KEY) die('HIGHLIGHTLY_API_KEY is not set');

// ---- 4. run ------------------------------------------------------------------------------------------
const log = (...a) => console.log(`[hl ${mode}]`, ...a.map((x) => (typeof x === 'string' ? clean(x, 300) : x)));
pg.types.setTypeParser(1082, (v) => v);
const { createWeeklyHighlightly, BudgetStop } = await import('../src/hl-weekly-client.js');
const db = new pg.Client({ connectionString: DB_URL, ssl: /^(localhost|127\.0\.0\.1)$/.test(host) ? false : { rejectUnauthorized: false }, statement_timeout: 60000, connectionTimeoutMillis: 15000 });
try { await db.connect(); } catch { die('database error (connect)'); }
log(`connected: ${clean(host)} season=${season}${dryRun ? ' DRY RUN (rolled back)' : ''} budget=${budget} reserve=${reserve}${runId ? ` run=${runId}` : ''}`);

const hl = createWeeklyHighlightly({ key: KEY, fixtures, budget, reserve, rps, lastRemaining, log: (m) => log(m) });
let runRow = null;
if (!dryRun) {
  try {
    const { rows: [r] } = await db.query(
      `INSERT INTO ingestion_runs (job_type, source, triggered_by, details) VALUES ($1, 'highlightly', $2, $3) RETURNING id`,
      [`weekly_hl_${mode}`, runId ? 'schedule' : 'manual', { season, weekly_run_id: runId }]);
    runRow = r.id;
  } catch { await db.end().catch(() => {}); die('database error (ingestion_runs)'); }
}

let rep, failure = null;
try {
  if (mode === 'schedule') {
    const { runSchedulePass } = await import('../src/weekly-schedule.js');
    rep = await runSchedulePass(db, hl, { season, daysBack, daysAhead, tipoffAuthority, dryRun, sweep, log });
  } else {
    const { runBackfillPass } = await import('../src/weekly-backfill.js');
    rep = await runBackfillPass(db, hl, { season, daysBack, dryRun, sweep, log });
  }
} catch (e) {
  failure = typeof e?.reason === 'string' ? e.reason : /^[0-9A-Z]{5}$/.test(e?.code ?? '') ? `database error (${e.code})` : `unexpected error (${clean(e?.name || 'Error', 40)})`;
}

const q = hl.stats;
result.hl = { requests: q.total, limit: q.limit, remaining: q.remaining };
result.stop = rep?.stop ?? q.stop ?? null;
const stopText = { cap: 'request cap reached', reserve: 'quota reserve reached', rate_limited: 'rate limited by Highlightly' };
const warnings = rep?.warnings ?? [];
if (!failure) {
  result.degraded = Boolean(result.stop) || warnings.length > 0;
  if (result.stop) result.reason = stopText[result.stop];
  else if (warnings.length) result.reason = warnings.join('; ');
}
const lists = rep?.lists ?? {};
for (const [k, v] of Object.entries(lists)) if (v.length) log(`${k}: ${v.join(' | ')}`);
if (rep?.sweep) log(`full-season sweep: ${rep.sweep}`);
if (result.stop) log(stopText[result.stop]);
const c = rep?.counts ?? {};
const summary = mode === 'schedule'
  ? `dates=${c.dates_done}/${c.dates_planned} matches=${c.matches} updated=${c.updated} tip_changes=${c.tip_changes} unmatched=${c.unmatched} skipped=${(c.skipped_exhibition ?? 0) + (c.skipped_worker ?? 0) + (c.skipped_changed ?? 0) + (c.skipped_final ?? 0)} needs_nba=${c.needs_nba} needs_review=${c.needs_review} bad=${c.bad_matches}`
  : `candidates=${c.candidates} loaded=${c.games_loaded} rows=${c.rows} not_ready=${c.not_ready} no_match=${c.no_match} skipped=${(c.skipped_changed ?? 0) + (c.skipped_nba ?? 0)} held=${c.held} created=${c.created}`;
const quotaText = q.remaining === null ? 'unknown' : `${q.remaining}/${q.limit ?? '?'}`;
log(`source=highlightly ${failure ? 'FAILED ' : ''}${summary} requests=${q.total} quota=${quotaText} stop=${result.stop ?? 'none'} duration=${Math.round((Date.now() - started) / 1000)}s${dryRun ? ' (dry run, nothing written)' : ''}`);

if (runRow !== null) {
  const details0 = { season, weekly_run_id: runId, window: { days_back: daysBack, days_ahead: mode === 'schedule' ? daysAhead : 0 }, counts: c, lists,
    requests: { total: q.total, byEndpoint: q.byEndpoint }, quota: { limit: q.limit, remaining: q.remaining }, stop: result.stop, sweep: rep?.sweep ?? null,
    nba_state: nbaState, tipoff_authority: tipoffAuthority, dry_run: false };
  const details = JSON.parse(mask(JSON.stringify(details0)));                            // belt and braces: never the key in the database
  await db.query(`UPDATE ingestion_runs SET status = $2, finished_at = now(), records_written = $3, details = $4, error = $5 WHERE id = $1`,
    [runRow, failure ? 'failed' : 'success', failure ? null : (mode === 'schedule' ? (c.updated ?? 0) + (c.rest_rows ?? 0) : (c.rows ?? 0)), details, failure ? clean(failure, 200) : null]).catch(() => {});
}
await db.end().catch(() => {});
if (failure) die(failure);
emit();
process.exitCode = 0;
