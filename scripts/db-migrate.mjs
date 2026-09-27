// Apply pending db/migrations/*.sql in filename order, each in its own
// transaction, recording them in schema_migrations.
//   npm run db:migrate           (from JD's Mac, DATABASE_PUBLIC_URL)
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { publicDbUrl, repoRoot } from './lib/env.mjs';

const { url, host, ssl } = publicDbUrl();
const db = new pg.Client({ connectionString: url, ssl });
try { await db.connect(); } catch (e) { console.error(`[migrate] cannot reach ${host}: ${e.message}`); process.exit(1); }
console.log(`[migrate] connected: ${host}`);
try {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
  const dir = new URL('db/migrations/', repoRoot);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    const id = f.replace(/\.sql$/, '');
    if (done.has(id)) continue;
    await db.query('BEGIN');
    try {
      await db.query(readFileSync(new URL(f, dir), 'utf8'));
      await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await db.query('COMMIT');
      console.log(`[migrate] applied ${id}`);
      applied++;
    } catch (e) {
      await db.query('ROLLBACK');
      throw new Error(`${id}: ${e.message}`);
    }
  }
  console.log(applied ? `[migrate] ${applied} migration(s) applied` : '[migrate] already up to date');
} catch (e) {
  console.error('[migrate] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
