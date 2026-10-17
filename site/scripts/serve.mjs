// A small static server of site/_site under a path prefix (GitHub Pages serves the site at /motion-studio/), with Range
// support for media. For local checks only.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4',
};

export function serve({ dir = join(HERE, '..', '_site'), prefix = '/motion-studio/', port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end('not found'); return; }
    let rel = decodeURIComponent(url.pathname.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(normalize(dir))) { res.writeHead(403).end(); return; }
    let info;
    try { info = await stat(file); } catch { res.writeHead(404).end('not found'); return; }
    if (!info.isFile()) { res.writeHead(404).end('not found'); return; }
    // GitHub Pages sends ACAO: * on every file; the runtime's fonts load in CORS mode.
    const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': info.size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: p } = server.address();
      resolve({ url: `http://${host}:${p}${prefix}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 4400);
  serve({ port }).then(({ url }) => console.log(url));
}
