// Minimal development server: static dist/ with SPA fallback, permissive CORS,
// and optional reverse proxy for /api and /ws to the WrexrOS daemon.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5173);
const API = process.env.WREXR_API || 'http://127.0.0.1:8443';

let apiUrl;
try { apiUrl = new URL(API); } catch { apiUrl = new URL('http://127.0.0.1:8443'); }
const useTls = apiUrl.protocol === 'https:';
const requester = useTls ? httpsRequest : httpRequest;
const proxyOpts = {
  hostname: apiUrl.hostname,
  port: apiUrl.port || (useTls ? 443 : 80),
  ...(useTls ? { rejectUnauthorized: false } : {})
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function isProxyPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') ||
    pathname === '/ws' || pathname.startsWith('/ws/');
}

function proxy(req, res) {
  const headers = { ...req.headers, host: apiUrl.host };
  delete headers['access-control-allow-origin'];
  const upstream = requester({ ...proxyOpts, path: req.url, method: req.method, headers }, (up) => {
    cors(res);
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      cors(res);
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ ok: false, error: { code: 'PROXY_ERROR', message: err.message } }));
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { pathname = '/'; }
  if (pathname.includes('\0')) { res.writeHead(400).end(); return; }

  let file = path.resolve(DIST, '.' + pathname);
  if (!file.startsWith(DIST) && file !== DIST) { res.writeHead(403).end(); return; }

  try {
    let info = await stat(file).catch(() => null);
    if (info && info.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file).catch(() => null); }
    if (!info || !info.isFile()) { file = path.join(DIST, 'index.html'); info = await stat(file).catch(() => null); }
    if (!info || !info.isFile()) throw new Error('dist not built — run `npm run build` first');
    cors(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    cors(res);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.message);
  }
}

const server = createServer((req, res) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* ignored */ }
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204).end(); return; }
  if (isProxyPath(pathname)) { proxy(req, res); return; }
  serveStatic(req, res);
});

// WebSocket upgrade proxying (best effort — never crashes the dev server).
server.on('upgrade', (req, socket, head) => {
  try {
    const upstream = requester({
      ...proxyOpts,
      path: req.url,
      method: 'GET',
      headers: { ...req.headers, host: apiUrl.host }
    });
    upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(res.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      if (upstreamHead && upstreamHead.length) upstreamSocket.write(upstreamHead);
      if (head && head.length) upstreamSocket.write(head);
    });
    upstream.on('error', () => { socket.destroy(); });
    upstream.end();
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[wrexros] dev server: http://localhost:${PORT}`);
  console.log(`[wrexros] proxying /api and /ws -> ${API}`);
});
