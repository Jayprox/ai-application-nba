// node scripts/create-user.js <username>   (password read from CT_PASSWORD env, never argv)
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
const username = process.argv[2];
const pw = process.env.CT_PASSWORD;
if (!username || !pw) { console.error('usage: CT_PASSWORD=<password> node scripts/create-user.js <username>'); process.exit(1); }
// Phase 6: the site is public, so refuse the passwords a guesser tries first.
const weak = pw.length < 12 ? 'use at least 12 characters'
  : /password|123456|qwerty/i.test(pw) ? 'avoid "password", "123456", "qwerty"'
  : pw.toLowerCase().includes(username.toLowerCase()) ? "don't include the username"
  : null;
if (weak) { console.error(`[create-user] password too weak: ${weak}`); process.exit(1); }
const db = createPool();
await db.query(`INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [username, await hashPassword(pw)]);
console.log(`user "${username}" created/updated`);
await db.end();
