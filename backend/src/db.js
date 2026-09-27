// Postgres pool. On Railway, DATABASE_URL is the private-network URL (no TLS);
// from a laptop it's the public proxy URL (TLS).
import pg from 'pg';

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  const ssl = /localhost|127\.0\.0\.1|\.railway\.internal$/.test(host) ? false : { rejectUnauthorized: false };
  return new pg.Pool({ connectionString: url, ssl, max: 10 });
}
