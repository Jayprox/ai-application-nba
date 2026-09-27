// Two-tier auth (PLATFORM.md §2): humans get a short-lived JWT + a rotating,
// revocable refresh token; agents/services get a long-lived API key. Same
// middleware, same API surface.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const ACCESS_TTL = '15m';
const REFRESH_DAYS = 30;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (32+ chars) — refusing to sign tokens without it');
  return s;
}

export async function hashPassword(pw) { return bcrypt.hash(pw, 12); }

export async function login(db, username, password) {
  const { rows: [u] } = await db.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
  // Compare against a dummy hash when the user doesn't exist, so timing doesn't reveal usernames.
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) return null;
  return issueTokens(db, u.id, u.username);
}

async function issueTokens(db, userId, username) {
  const access = jwt.sign({ sub: userId, name: username, kind: 'user' }, jwtSecret(), { expiresIn: ACCESS_TTL });
  const refresh = crypto.randomBytes(48).toString('base64url');
  const { rows: [r] } = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '${REFRESH_DAYS} days') RETURNING id`,
    [userId, sha256(refresh)]);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, refresh_id: r.id };
}

/**
 * Rotate a refresh token. Presenting one that was already rotated or revoked
 * is a theft signal (a leaked copy and the real client both used it) — revoke
 * EVERY active session for that user, not just this request.
 */
export async function refresh(db, token) {
  const { rows: [t] } = await db.query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.replaced_by, u.username
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1`, [sha256(token)]);
  if (!t) return { error: 'invalid_refresh_token' };
  if (t.revoked_at || t.replaced_by) {
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id]);
    return { error: 'refresh_token_reused', replay: true };
  }
  if (new Date(t.expires_at) < new Date()) return { error: 'refresh_token_expired' };
  const tokens = await issueTokens(db, t.user_id, t.username);
  await db.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [t.id, tokens.refresh_id]);
  return tokens;
}

export async function logout(db, token) {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
}

/** Express middleware: Bearer JWT (humans) or X-API-Key (agents). */
export function authenticate(db) {
  return async (req, res, next) => {
    const h = req.get('authorization') ?? '';
    if (h.startsWith('Bearer ')) {
      try {
        const p = jwt.verify(h.slice(7), jwtSecret(), { algorithms: ['HS256'] });
        req.principal = { kind: 'user', id: p.sub, name: p.name };
        return next();
      } catch (e) {
        return res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'access_token_expired' : 'invalid_access_token' });
      }
    }
    const key = req.get('x-api-key');
    if (key) {
      try {
        const { rows: [k] } = await db.query('SELECT id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [sha256(key)]);
        if (!k) return res.status(401).json({ error: 'invalid_api_key' });
        db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]).catch(() => {});
        req.principal = { kind: 'agent', id: k.id, name: k.name };
        return next();
      } catch (e) { return next(e); }   // a DB hiccup is a 500, never an unhandled rejection
    }
    return res.status(401).json({ error: 'authentication_required' });
  };
}

/** Create an API key; the plaintext is returned exactly once. */
export async function createApiKey(db, name) {
  const key = 'ctnba_' + crypto.randomBytes(32).toString('base64url');
  await db.query('INSERT INTO api_keys (name, key_prefix, key_hash) VALUES ($1, $2, $3)', [name, key.slice(0, 12), sha256(key)]);
  return key;
}
