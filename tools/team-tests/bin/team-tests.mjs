#!/usr/bin/env node
// team-tests CLI entry point. B1 scaffold only: commands arrive in later tasks (B5-B7).
const [cmd = 'dry-run'] = process.argv.slice(2);
process.stderr.write(`team-tests: command "${cmd}" is not implemented yet (scaffold)\n`);
process.exit(2);
