/**
 * A tiny confined static server for the integration tests, shaped like the core's composition server (Task 3):
 * - `/<token>/runtime/index.html`: dist/index.html with the composition inlined (`renderRuntimePage`);
 * - `/<token>/runtime/<file>`: the other dist files;
 * - `/<token>/<versionDir>/compositions/<format>/…`: the composition folder; `layers/*.html` get the bootstrap injected;
 * - the CSP of Task 3 on every response, `nosniff`, and the CORS/CORP headers the opaque-origin frames need.
 * 127.0.0.1 only, random port. Test code: the real server (realpath, O_NOFOLLOW, tokens that expire) is Task 3.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { injectLayerBootstrap, renderRuntimePage, type CompositionData } from '../../src/page.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wav': 'audio/wav',
};

/**
 * Task 3's CSP. `frame-ancestors` goes on the runtime page only: a layer is framed by the runtime page, whose origin is
 * opaque in the preview, and Chrome matches no frame-ancestors source against an opaque ancestor (not 'self', not the
 * server's origin, not even `*`), so any frame-ancestors on a layer response blocks the layer.
 */
export function compositionCsp(frameAncestors: string | null): string {
  return "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; "
    + `script-src 'self' 'unsafe-inline'; connect-src 'none'; ${frameAncestors ? `frame-ancestors ${frameAncestors}; ` : ''}base-uri 'none'; form-action 'none'`;
}

export interface TestServer { origin: string; token: string; pageUrl(query: string): string; requests: string[]; close(): Promise<void> }

/** `data`: what the core inlines next to the composition (safe zone, subtitles), when the test needs it. */
export function startCompositionServer(o: { distDir: string; root: string; compPath: string; frameAncestors?: string; data?: Pick<CompositionData, 'safeZone' | 'subtitles'> }): Promise<TestServer> {
  const token = `t${Math.random().toString(36).slice(2, 10)}`;
  const requests: string[] = [];
  const compDir = resolve(o.root, o.compPath);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(url.pathname);
    const rest0 = url.pathname.slice(token.length + 2);
    const headers: Record<string, string> = {
      'content-security-policy': compositionCsp(rest0 === 'runtime/index.html' ? (o.frameAncestors ?? "'self'") : null),
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
      // Frames of the preview and every layer have opaque origins: fonts are fetched in CORS mode with `Origin: null`.
      ...(req.headers.origin === 'null' ? { 'access-control-allow-origin': 'null' } : {}),
      'cross-origin-resource-policy': 'cross-origin',
    };
    const deny = (code: number) => { res.writeHead(code, headers); res.end(); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
    if (!url.pathname.startsWith(`/${token}/`)) return deny(403);
    const rest = decodeURIComponent(url.pathname.slice(token.length + 2));
    let file: string; let rootDir: string;
    if (rest.startsWith('runtime/')) { rootDir = resolve(o.distDir); file = resolve(rootDir, rest.slice('runtime/'.length)); }
    else { rootDir = resolve(o.root); file = resolve(rootDir, rest); }
    if (!file.startsWith(rootDir + sep)) return deny(403);
    let size: number;
    try { const st = statSync(file); if (!st.isFile()) return deny(404); size = st.size; } catch { return deny(404); }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (rest === 'runtime/index.html') {
      const composition = JSON.parse(readFileSync(join(compDir, 'composition.json'), 'utf8')) as unknown;
      const body = renderRuntimePage(readFileSync(file, 'utf8'), { ...o.data, base: `../${o.compPath}/`, composition });
      res.writeHead(200, { ...headers, 'content-type': type }); return res.end(body);
    }
    if (file.startsWith(join(compDir, 'layers') + sep) && extname(file) === '.html') {
      const body = injectLayerBootstrap(readFileSync(file, 'utf8'), `/${token}/runtime/layer.js`);
      res.writeHead(200, { ...headers, 'content-type': type }); return res.end(body);
    }
    const data = readFileSync(file);
    const range = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
    if (range) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
      return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size) });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    r({
      origin, token, requests,
      pageUrl: (query) => `${origin}/${token}/runtime/index.html${query ? `?${query}` : ''}`,
      close: () => new Promise<void>((c) => { server.closeAllConnections(); server.close(() => c()); }),
    });
  }));
}

/** A second origin that plays the UI: one page embedding the preview iframe, recording the messages it gets. */
export function startUiServer(html: (origin: string) => string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html(`http://${req.headers.host ?? ''}`));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    r({ origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((c) => { server.closeAllConnections(); server.close(() => c()); }) });
  }));
}
