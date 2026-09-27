// .env loading + the public-DB-URL guard shared by every script run from JD's Mac.
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

export function loadEnv() {
  let fileVars = {};
  try {
    fileVars = Object.fromEntries(
      readFileSync(new URL('.env', root), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
    );
  } catch { /* no .env: fall back to process.env only */ }
  return { ...fileVars, ...process.env };
}

/** DATABASE_PUBLIC_URL, refusing Railway's private hostname with a useful message. */
export function publicDbUrl(env = loadEnv()) {
  const url = env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error('DATABASE_PUBLIC_URL not set (add it to .env from Railway -> Postgres -> Variables).');
    process.exit(1);
  }
  const host = new URL(url).host;
  if (host.includes('.railway.internal')) {
    console.error(`${host} is Railway's PRIVATE hostname — it only resolves inside Railway.\n` +
      'Use DATABASE_PUBLIC_URL instead (Railway -> Postgres -> Variables; host looks like *.proxy.rlwy.net:PORT).');
    process.exit(1);
  }
  return { url, host, ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: false } };
}

export const repoRoot = root;
