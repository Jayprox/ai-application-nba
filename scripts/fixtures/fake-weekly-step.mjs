// Test fixture only (M5 weekly drill, scripts/weekly-drill.sh). Stands in for the schedule,
// positions and backfill steps when weekly.mjs runs with WEEKLY_STEP_FIXTURE=1 and the fake railway.
// It gets its connection exactly as the real steps do (publicDbUrl() from the process env), then
// records (step, args) in the drill table weekly_drill_marks. It never writes anything else.
//
//   node fake-weekly-step.mjs <name> [args...]
// Env: FAKE_STEP_FAIL=<name>        exit 3 before marking
//      FAKE_STEP_HANG=<name>        connect, then sleep (never marks)
//      FAKE_STEP_SLOW=<name>:<s>    sleep s seconds, then mark
//      FAKE_STEP_PRINT_URL=1        print the connection URL to stdout and stderr (redaction check)
import pg from 'pg';
import { publicDbUrl } from '../lib/env.mjs';

const [name, ...args] = process.argv.slice(2);
if (!name) process.exit(2);
const { url, ssl } = publicDbUrl();
if (process.env.FAKE_STEP_PRINT_URL === '1') { console.log(`[fake ${name}] url ${url}`); console.error(`[fake ${name}] url ${url}`); }
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[fake ${name}] cannot connect: ${e.message}`); process.exit(1); }
if (process.env.FAKE_STEP_FAIL === name) { console.error(`[fake ${name}] failing on purpose`); await db.end(); process.exit(3); }
if (process.env.FAKE_STEP_HANG === name) { console.log(`[fake ${name}] hanging`); await new Promise(() => setInterval(() => {}, 1000)); }
const slow = /^([a-z]+):(\d+)$/.exec(process.env.FAKE_STEP_SLOW || '');
if (slow && slow[1] === name) await new Promise((r) => setTimeout(r, Number(slow[2]) * 1000));
await db.query('INSERT INTO weekly_drill_marks (step, args) VALUES ($1, $2)', [name, args.join(' ')]);
console.log(`[fake ${name}] marked ${args.join(' ')}`);
await db.end();
