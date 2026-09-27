// Apply db/schema.sql to the chalk-that-nba Postgres, then run
// db/tests/schema_constraints.sql against it (the tests roll back).
//
//   npm run db:apply        # apply schema + run tests
//   npm run db:test         # tests only (schema already applied)
//
// Connection: DATABASE_PUBLIC_URL from .env (Railway -> Postgres service ->
// Variables -> DATABASE_PUBLIC_URL). Runs from JD's Mac, never Railway.
//
// Safety: refuses to apply if a `teams` table already exists (that would be
// an already-initialised DB — or the wrong one, e.g. chalk-that-nfl's).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { publicDbUrl, repoRoot } from './lib/env.mjs';

const root = repoRoot;
const testOnly = process.argv.includes('--test-only');
const { url, host, ssl } = publicDbUrl();

const client = new pg.Client({ connectionString: url, ssl });
const notices = [];
client.on('notice', (n) => notices.push(n.message));

// psql meta-commands (\set, \o) aren't SQL — strip them for node-postgres.
const readSql = (p) => readFileSync(new URL(p, root), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('\\')).join('\n');

try {
  await client.connect();
  const { rows: [info] } = await client.query('select current_database() db, version() v');
  console.log(`Connected: ${host} / ${info.db} (${info.v.split(' ').slice(0, 2).join(' ')})`);

  if (!testOnly) {
    const { rows: [{ exists }] } = await client.query("select to_regclass('public.teams') is not null as exists");
    if (exists) {
      console.error('Refusing to apply: a `teams` table already exists here. Wrong database, or schema already applied (use --test-only).');
      process.exit(1);
    }
    await client.query(readSql('db/schema.sql'));
    const { rows } = await client.query("select count(*)::int n from information_schema.tables where table_schema = 'public'");
    console.log(`Schema applied: ${rows[0].n} tables.`);
  }

  notices.length = 0;
  await client.query(readSql('db/tests/schema_constraints.sql'));
  for (const n of notices) console.log('  ' + n);
  const passed = notices.some((n) => n.includes('ALL SCHEMA CONSTRAINT TESTS PASSED'));
  console.log(passed ? 'Constraint tests: PASSED' : 'Constraint tests: did not report success');
  process.exitCode = passed ? 0 : 1;
} catch (e) {
  for (const n of notices) console.log('  ' + n);
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
