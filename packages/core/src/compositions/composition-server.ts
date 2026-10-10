import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { COMPOSITION_MAX_BYTES, isCompositionPath } from '@motion-studio/shared';
import { injectLayerBootstrap, renderRuntimePage, RUNTIME_FILES } from '@motion-studio/composition-runtime/page';
import { RUNTIME_DIST_DIR } from '@motion-studio/composition-runtime/dist';
import { withConfinedFile } from '../brand/agent-guard.ts';
import { readRegularFile } from '../safe-read.ts';
import { SessionTokens } from './serve-token.ts';

/**
 * The isolated composition server (spec §5.2, layer 1; contracts in packages/composition-runtime/README.md).
 *
 * A composition is agent-written code that runs outside the agent sandbox, in Chrome (render) or in a sandboxed iframe of
 * the UI (preview). This server is the only way it reaches files:
 * - its **own listener** on 127.0.0.1 with a random port, never the UI/API port; it serves no core API at all;
 * - every path sits under a **session token** (serve-token.ts) scoped to exactly one composition folder plus the runtime:
 *   `/<token>/runtime/{index.html,runtime.js,layer.js,clock.js}` and `/<token>/<versionDir>/compositions/<format>/{assets,layers}/…`.
 *   `composition.json` is never served (the runtime page has it inlined); everything else is 404;
 * - the `Host` must be exactly `127.0.0.1:<port>` (DNS rebinding: 421), and only GET and HEAD are allowed (405);
 * - the URL is decoded once; encoded separators (`%2f`, `%5c`, `%00`), a `%` left after decoding (double encoding), a
 *   backslash and NUL are refused; the path is NFC-normalised and must pass `isCompositionPath`;
 * - files are read with the confined-read checks (`withConfinedFile`, exact real path): `O_NOFOLLOW | O_NONBLOCK`, a regular
 *   file with `nlink === 1`, the opened inode equal to the `lstat`/realpath one, no symlink anywhere below the composition
 *   folder; the composition folder itself must still be the real path recorded when the session was minted. Size-limited and
 *   streamed (with single byte ranges, which video seeking needs);
 * - the headers (orchestrator-approved set): CSP with `connect-src 'none'` on everything; `frame-ancestors` only on the runtime
 *   page; an extra `Content-Security-Policy: sandbox allow-scripts` on every composition file, so a layer (or any html/svg
 *   file of the folder) stays opaque even when opened top-level; `Cross-Origin-Resource-Policy: cross-origin` (the frames
 *   are opaque, so same-origin would block them; the token guards the files); `nosniff`; `no-referrer`; `no-store`; and
 *   `Access-Control-Allow-Origin: null` only for a font requested with `Origin: null`. Never credentials or private-network
 *   CORS headers.
 * - a layer (`layers/*.html`) is served only into an iframe (`Sec-Fetch-Dest: iframe`, which Chrome sends to 127.0.0.1),
 *   with the runtime's `layer.js` injected as its first script.
 */

/** The CSP of every response (spec §5.2). `frame-ancestors` is appended on the runtime page only (README "Headers"). */
export const COMPOSITION_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; "
  + "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";
/** Second CSP on every composition file: the document is a unique opaque origin, scripts only. */
export const SANDBOX_CSP = 'sandbox allow-scripts';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LAYER_BYTES = 5 * 1024 * 1024;
const MAX_RUNTIME_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_RUNTIME_SCRIPT_BYTES = 20 * 1024 * 1024;

const TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json'], ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'], ['.opus', 'audio/ogg'], ['.flac', 'audio/flac'],
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);
const FONT_EXT = new Set(['.woff2', '.woff', '.ttf', '.otf']);
/** A segment of `versionDir` (`outputs/v3`): no dot first, so never `.` or `..`. */
const VERSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A format id (shared formats `ID_RE`). */
const FORMAT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENCODED_SEPARATOR_RE = /%(?:2f|5c|00)/i;
const RANGE_RE = /^bytes=(\d{0,15})-(\d{0,15})$/;

export type CompositionMode = 'render' | 'preview';

export interface CompositionServerOptions {
  /**
   * The exact serialized origins the UI may run on; a preview session's `parentOrigin` must be one of them. A function is
   * read at every mint, for origins known only later. Today: the core's own origin `http://127.0.0.1:<port>` (the packaged
   * web UI and the desktop app, which loads the UI from the core) and, in development, Vite's `http://localhost:5173`.
   */
  uiOrigins: readonly string[] | (() => readonly string[]);
  /** The built runtime (`index.html`, `runtime.js`, `layer.js`, `clock.js`); default `RUNTIME_DIST_DIR`. */
  distDir?: string;
  /** Default session lifetime in ms (30 min); `mintSession` may pass its own. */
  ttlMs?: number;
  /** Largest file served from a composition folder; default `COMPOSITION_MAX_BYTES` (500 MB). */
  maxFileBytes?: number;
  /** Largest layer html (read whole to inject the bootstrap); default 5 MB. */
  maxLayerBytes?: number;
  /** Clock for token expiry (tests). */
  now?: () => number;
}

export interface MintSessionOptions {
  /** The creative folder. */
  creativeDir: string;
  /** The version folder relative to `creativeDir`, `/`-separated (`outputs/v3`). */
  versionDir: string;
  /** The format id: the composition folder is `<creativeDir>/<versionDir>/compositions/<format>`. */
  format: string;
  /** The parsed, normalised and validated `composition.json` (inlined into the runtime page, never read by the server). */
  composition: unknown;
  /** `render` (top-level page driven over CDP, `frame-ancestors 'none'`) or `preview` (sandboxed iframe of the UI). */
  mode: CompositionMode;
  /** Preview only, required: the UI origin embedding the iframe; one of `uiOrigins`. It becomes `frame-ancestors`. */
  parentOrigin?: string;
  /** This session's lifetime in ms (default: the server's). */
  ttlMs?: number;
}

export interface CompositionSession {
  /** The session token (256 random bits, base64url). */
  token: string;
  /** The runtime page: `<origin>/<token>/runtime/index.html?mode=render` or `?mode=preview&parentOrigin=<encoded>`. */
  url: string;
  /** The server origin (`http://127.0.0.1:<port>`), e.g. for Task 4's request allowlist. */
  origin: string;
  /** When the token expires (ms, the server clock), as minted. */
  expiresAt: number;
  /** Ends the session now: every later request with its token is 404. */
  revoke(): void;
  /** Restarts the TTL of a live session; the new expiry, or null when it already ended. */
  renew(): number | null;
}

export interface CompositionServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  /**
   * Opens a read-only session on one composition folder. Throws when the arguments are invalid, when the folder is missing,
   * is not a directory, or is reached through a symlink (its real path must be exactly `<real creativeDir>/<versionDir>/
   * compositions/<format>`), or when the server is closed.
   */
  mintSession(o: MintSessionOptions): Promise<CompositionSession>;
  /** Ends every session, drops open connections and stops listening. */
  close(): Promise<void>;
}

interface Session {
  versionSegments: string[];
  versionDir: string;
  format: string;
  /** Real path of the composition folder when minted; it must stay that. */
  compDir: string;
  composition: unknown;
  frameAncestors: string;
}

/** An exact serialized http(s) origin (`http://127.0.0.1:4318`), nothing more. */
function isExactOrigin(o: unknown): o is string {
  if (typeof o !== 'string' || o.length > 2048) return false;
  try {
    const u = new URL(o);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o;
  } catch { return false; }
}

function checkedOrigins(list: readonly string[]): readonly string[] {
  if (!Array.isArray(list)) throw new Error('composition server: uiOrigins must be a list of origins');
  for (const o of list) if (!isExactOrigin(o)) throw new Error(`composition server: not an exact http(s) origin: ${JSON.stringify(o)}`);
  return list;
}

/** `/`-separated segments of a safe `versionDir`, or null. */
function versionSegments(v: unknown): string[] | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 256) return null;
  const segs = v.split('/');
  return segs.length <= 8 && segs.every((s) => VERSION_SEGMENT_RE.test(s)) ? segs : null;
}

/**
 * The token and the remaining path segments of a request target, or null when it is refused: not origin-form, an encoded
 * separator or NUL, a backslash, malformed percent-encoding, or anything left percent-encoded after one decode.
 */
export function parseTarget(rawUrl: string | undefined): { token: string; rest: string[] } | null {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.length > 4096) return null;
  const q = rawUrl.indexOf('?');
  const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (rawPath.includes('#') || rawPath.includes('\\') || ENCODED_SEPARATOR_RE.test(rawPath)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segs = decoded.normalize('NFC').split('/');
  if (segs.length < 3 || segs[0] !== '') return null;
  return { token: segs[1]!, rest: segs.slice(2) };
}

type Range = { start: number; end: number } | 'unsatisfiable' | null;
/** One `bytes=` range of a `size`-byte file; null for none, several or a malformed one (the whole file is sent then). */
function parseRange(h: string | undefined, size: number): Range {
  if (typeof h !== 'string') return null;
  const m = RANGE_RE.exec(h.trim());
  if (!m) return null;
  const [a, b] = [m[1]!, m[2]!];
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: b === '' ? size - 1 : Math.min(Number(b), size - 1) };
}

/** Starts the composition server on 127.0.0.1 with a random port. See the module comment. */
export async function startCompositionServer(opts: CompositionServerOptions): Promise<CompositionServer> {
  const uiOrigins = typeof opts.uiOrigins === 'function' ? opts.uiOrigins : (() => { const l = checkedOrigins(opts.uiOrigins as readonly string[]); return () => l; })();
  const distDir = opts.distDir ?? RUNTIME_DIST_DIR;
  const defaultTtl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxFileBytes = opts.maxFileBytes ?? COMPOSITION_MAX_BYTES;
  const maxLayerBytes = opts.maxLayerBytes ?? DEFAULT_MAX_LAYER_BYTES;
  const tokens = new SessionTokens<Session>(opts.now);
  let closed = false;
  let expectedHost = '';

  const send = (res: ServerResponse, status: number, headers: Record<string, string | string[]>, body?: Buffer | string) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    res.writeHead(status, { ...headers, 'content-length': String(data?.length ?? 0) });
    res.end(data);
  };

  const baseHeaders = (): Record<string, string | string[]> => ({
    'content-security-policy': COMPOSITION_CSP,
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    vary: 'Origin',
  });

  /**
   * Serves `rel` under `base` through the confined-read checks. `check` runs once the file is open and verified (e.g. the
   * composition folder is still where it was). Returns false when the file is refused or missing (nothing was sent).
   */
  async function serveFile(req: IncomingMessage, res: ServerResponse, base: string, rel: string, headers: Record<string, string | string[]>,
    o: { maxBytes: number; transform?: (text: string) => string; ranges: boolean; check?: () => Promise<boolean> }): Promise<boolean> {
    const r = await withConfinedFile(base, rel, true, async (fh: FileHandle, info: Stats) => {
      const l = await lstat(join(base, ...rel.split('/'))).catch(() => null);
      if (!l || !l.isFile() || l.ino !== info.ino || l.dev !== info.dev) return { skipped: 'outside' as const };
      if (info.size > o.maxBytes) return { skipped: 'too-large' as const };
      if (o.check && !(await o.check())) return { skipped: 'outside' as const };
      const head = req.method === 'HEAD';
      if (o.transform) {
        const buf = Buffer.alloc(o.maxBytes + 1);
        let n = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
          if (n > o.maxBytes) return { skipped: 'too-large' as const };
        }
        const body = Buffer.from(o.transform(buf.subarray(0, n).toString('utf8')), 'utf8');
        res.writeHead(200, { ...headers, 'content-length': String(body.length) });
        res.end(head ? undefined : body);
        return true as const;
      }
      const size = info.size;
      const range = o.ranges ? parseRange(req.headers.range, size) : null;
      if (range === 'unsatisfiable') {
        send(res, 416, { ...headers, 'content-range': `bytes */${size}` });
        return true as const;
      }
      const { start, end } = range ?? { start: 0, end: size - 1 };
      const length = size === 0 ? 0 : end - start + 1;
      res.writeHead(range ? 206 : 200, {
        ...headers, 'accept-ranges': o.ranges ? 'bytes' : 'none', 'content-length': String(length),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      });
      if (head || length === 0) { res.end(); return true as const; }
      // Bounded by the fstat size even if the file grows meanwhile; the handle is closed by withConfinedFile.
      await pipeline(fh.createReadStream({ start, end, autoClose: false }), res);
      return true as const;
    });
    return r === true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = baseHeaders();
    if (req.headers.host !== expectedHost) return send(res, 421, headers);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ...headers, allow: 'GET, HEAD' });
    const notFound = () => send(res, 404, headers);
    const target = parseTarget(req.url);
    if (!target) return notFound();
    const session = tokens.get(target.token);
    if (!session) return notFound();
    const { rest } = target;

    if (rest.length === 2 && rest[0] === 'runtime' && (RUNTIME_FILES as readonly string[]).includes(rest[1]!)) {
      const name = rest[1]!;
      if (name === 'index.html') {
        const page = await readRegularFile(join(distDir, 'index.html'), MAX_RUNTIME_PAGE_BYTES);
        if (page.kind !== 'file') return notFound();
        const html = renderRuntimePage(page.data.toString('utf8'), {
          base: `../${session.versionDir}/compositions/${session.format}/`, composition: session.composition,
        });
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length),
          'content-security-policy': `${COMPOSITION_CSP}; frame-ancestors ${session.frameAncestors}`,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const ok = await serveFile(req, res, distDir, name, { ...headers, 'content-type': 'text/javascript; charset=utf-8' },
        { maxBytes: MAX_RUNTIME_SCRIPT_BYTES, ranges: false });
      return ok ? undefined : notFound();
    }

    const prefix = [...session.versionSegments, 'compositions', session.format];
    if (rest.length <= prefix.length || prefix.some((s, i) => rest[i] !== s)) return notFound();
    const rel = rest.slice(prefix.length).join('/');
    if (!isCompositionPath(rel)) return notFound();
    const ext = posix.extname(rel).toLowerCase();
    const fileHeaders: Record<string, string | string[]> = {
      ...headers,
      'content-security-policy': [COMPOSITION_CSP, SANDBOX_CSP],
      'content-type': TYPES.get(ext) ?? 'application/octet-stream',
    };
    const dest = req.headers['sec-fetch-dest'];
    // Fonts are always fetched in CORS mode, and the preview document and every layer have opaque origins (README).
    if (req.headers.origin === 'null' && (dest === 'font' || FONT_EXT.has(ext))) fileHeaders['access-control-allow-origin'] = 'null';
    const layer = rel.startsWith('layers/') && ext === '.html';
    if (layer && dest !== 'iframe') return notFound();
    const stillThere = async () => (await realpath(session.compDir).catch(() => null)) === session.compDir;
    if (!(await stillThere())) return notFound();
    const ok = await serveFile(req, res, session.compDir, rel, fileHeaders, layer
      ? { maxBytes: maxLayerBytes, ranges: false, check: stillThere, transform: (html) => injectLayerBootstrap(html, `/${target.token}/runtime/layer.js`) }
      : { maxBytes: maxFileBytes, ranges: true, check: stillThere });
    return ok ? undefined : notFound();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 404, baseHeaders());
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  expectedHost = `127.0.0.1:${port}`;
  const origin = `http://${expectedHost}`;

  return {
    origin, port,
    async mintSession(o) {
      if (closed) throw new Error('composition server: closed');
      if (o.mode !== 'render' && o.mode !== 'preview') throw new Error('composition server: mode must be render or preview');
      const segs = versionSegments(o.versionDir);
      if (!segs) throw new Error('composition server: bad versionDir');
      if (typeof o.format !== 'string' || !FORMAT_RE.test(o.format)) throw new Error('composition server: bad format');
      if (typeof o.composition !== 'object' || o.composition === null) throw new Error('composition server: composition must be an object');
      let frameAncestors: string;
      if (o.mode === 'preview') {
        if (!isExactOrigin(o.parentOrigin) || !checkedOrigins(uiOrigins()).includes(o.parentOrigin)) {
          throw new Error('composition server: a preview needs a parentOrigin among the UI origins');
        }
        frameAncestors = o.parentOrigin;
      } else {
        if (o.parentOrigin !== undefined) throw new Error('composition server: a render session has no parentOrigin');
        frameAncestors = "'none'";
      }
      const ttl = o.ttlMs ?? defaultTtl;
      const realCreative = await realpath(o.creativeDir);
      const compDir = await realpath(join(o.creativeDir, ...segs, 'compositions', o.format));
      if (compDir !== join(realCreative, ...segs, 'compositions', o.format)) throw new Error('composition server: the composition folder is reached through a link');
      if (!(await lstat(compDir)).isDirectory()) throw new Error('composition server: the composition folder is not a directory');
      if (closed) throw new Error('composition server: closed');
      const { token, expiresAt } = tokens.mint({
        versionSegments: segs, versionDir: segs.join('/'), format: o.format, compDir, composition: o.composition, frameAncestors,
      }, ttl);
      const query = o.mode === 'preview' ? `mode=preview&parentOrigin=${encodeURIComponent(frameAncestors)}` : 'mode=render';
      return {
        token, origin, expiresAt,
        url: `${origin}/${token}/runtime/index.html?${query}`,
        revoke: () => tokens.revoke(token),
        renew: () => tokens.renew(token),
      };
    },
    async close() {
      closed = true;
      tokens.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
