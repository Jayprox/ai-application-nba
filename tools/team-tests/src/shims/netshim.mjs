// Logging, failing stand-in for network and credential tools.
import fs from 'node:fs';

const log = process.env.TEAM_TESTS_LOG;
const tool = process.env.TEAM_TESTS_TOOL ?? 'unknown';
if (log) fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), tool, argv: process.argv.slice(2) }) + '\n');
process.stderr.write(`${tool}: command not available\n`);
process.exit(1);
