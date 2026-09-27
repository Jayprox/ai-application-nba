// Production server for the built app (Railway `web`: `npm start` after
// `npm run build`). Zero dependencies: serves dist/, long-caches the hashed
// assets, and answers every other path with index.html so client-side
// routes (/players/123, /?date=...) work on refresh and deep links.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY' };

async function file(path) {
  try { const s = await stat(path); return s.isFile() ? path : null; } catch { return null; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY); return res.end(); }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).includes('..')) { res.writeHead(400, SECURITY); return res.end(); }
  const found = rel && (await file(join(DIST, rel)));
  // A missing file with an extension (/assets/old-hash.js) is a real 404, not an app route.
  if (!found && extname(rel)) { res.writeHead(404, { ...SECURITY, 'content-type': 'text/plain' }); return res.end('not found'); }
  const path = found || join(DIST, 'index.html');
  const hashed = found && rel.startsWith('assets/');
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      ...SECURITY,
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('build missing: run npm run build');
  }
}).listen(PORT, () => console.log(`[web] serving dist/ on :${PORT}`));
