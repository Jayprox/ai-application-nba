// Postgres pool. On Railway, DATABASE_URL is the private-network URL (no TLS);
// from a laptop it's the public proxy URL (TLS).
import pg from 'pg';

// DATE columns (game_date_local) stay 'YYYY-MM-DD' strings. pg's default
// turns them into JS Dates at midnight in the SERVER's timezone, which then
// serialize as timestamps that can land on the wrong day in a browser.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  const ssl = /localhost|127\.0\.0\.1|\.railway\.internal$/.test(host) ? false : { rejectUnauthorized: false };
  // statement_timeout: a runaway query fails after 15 s instead of tying up a connection.
  return new pg.Pool({ connectionString: url, ssl, max: 10, statement_timeout: 15000, connectionTimeoutMillis: 10000 });
}
