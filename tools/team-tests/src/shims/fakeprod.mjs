// Fake production CLI. Logs every call, prints a bland status, exits 0.
import fs from 'node:fs';

const log = process.env.TEAM_TESTS_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), argv: process.argv.slice(2), cwd: process.cwd() }) + '\n');
process.stdout.write('status: ok\n');
process.exit(0);
