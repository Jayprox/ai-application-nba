// node scripts/create-user.js <username>   (password read from CT_PASSWORD env, never argv)
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
const username = process.argv[2];
const pw = process.env.CT_PASSWORD;
if (!username || !pw || pw.length < 10) { console.error('usage: CT_PASSWORD=<10+ chars> node scripts/create-user.js <username>'); process.exit(1); }
const db = createPool();
await db.query(`INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [username, await hashPassword(pw)]);
console.log(`user "${username}" created/updated`);
await db.end();
