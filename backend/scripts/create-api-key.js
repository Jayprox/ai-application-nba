// node scripts/create-api-key.js <name>  — prints the key ONCE; only its hash is stored.
import { createPool } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
const name = process.argv[2];
if (!name) { console.error('usage: node scripts/create-api-key.js <name, e.g. ai-agents-nba>'); process.exit(1); }
const db = createPool();
console.log(await createApiKey(db, name));
await db.end();
