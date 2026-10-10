import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
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
 *   `Access-Control-Allow-Origin: null` only for a font file (by extension) requested with `Origin: null`; the preview's
 *   runtime page also gets the sandbox CSP. Never credentials or private-network
 *   CORS headers.
 * - the runtime page's `default-src 'self'` is also its `frame-src`, which keeps a layer from navigating its own frame off this
 *   origin: Chrome checks the embedder's frame-src on every child navigation (tested in real Chrome). Keep it.
 * - a layer (`layers/*.html`) is served only into an iframe (`Sec-Fetch-Dest: iframe`, which Chrome sends to 127.0.0.1),
 *   with the runtime's `layer.js` injected as its first script.
 * - **normalised media** (Task 5, README "normalised media"): a session may map video clip sources to the core's normalised
 *   files (`mintSession({ media })`, made by `media-normalize.ts` in `<project>/.studio/cache/media/`). The inlined
 *   composition then names them `media/<i>.mp4` (with the probed `sourceFps`, `sourceStart`, `sourceVideoEnd` and
 *   `sourceTrusted`), and exactly those files are served at `/<token>/<versionDir>/compositions/<format>/media/<i>.mp4`:
 *   under the composition base, because the runtime confines every asset URL to it, and never a composition path (those
 *   start with `assets/` or `layers/`). There is no general route into `.studio`. A media file gets the same checks as a
 *   composition file: the media folder must still be the real folder minted (dev, ino), and the file a regular,
 *   single-linked file directly in it, opened `O_NOFOLLOW`, with the same headers and byte ranges.
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
const MAX_CONNECTIONS = 64;

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
/** A normalised media file of the cache (`<sha256 of the source>-<fps>-<w>x<h>-n<recipe>.mp4`, media-normalize.ts). */
export const MEDIA_FILE_RE = /^[0-9a-f]{64}-\d{1,3}-\d{1,5}x\d{1,5}-n\d{1,4}\.mp4$/;
/** The served name of the i-th media file of a session. */
const MEDIA_SEGMENT_RE = /^(\d{1,4})\.mp4$/;

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
  /** Called after each response with its method, path (no query; the token included) and status: diagnostics and tests. */
  onResponse?: (e: { method: string; path: string; status: number }) => void;
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
  /**
   * The normalised media of the composition's video clips (render and preview alike; see the module comment). With it, a
   * video clip whose `src` is not in `clips` keeps its own file and loses any core-only source field it carries (the
   * lenient rule). Without it the composition is inlined as given (the agent's schema forbids those fields anyway).
   */
  media?: SessionMedia;
}

/** One normalised video file and the values ffprobe read from it (media-normalize.ts). */
export interface SessionMediaFile {
  /** Absolute path: a file directly in `SessionMedia.dir`, named like `MEDIA_FILE_RE`. */
  file: string;
  sourceFps: number;
  sourceStart: number;
  sourceVideoEnd: number;
  /**
   * Where the ORIGINAL source's first video frame sits on its media timeline: the preview plays the clip's sound from the
   * original asset (`audioSrc`) in an `<audio>` element started at that offset (the normalised file has no audio).
   */
  originalVideoStart?: number;
}

export interface SessionMedia {
  /** The media cache folder, `<project>/.studio/cache/media`: no link from the project folder down. */
  dir: string;
  /** Normalised file by video clip `src` (`assets/…`). */
  clips: ReadonlyMap<string, SessionMediaFile>;
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
  /** The listener's explicit limits (ms and connections). */
  limits: { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; maxConnections: number };
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
  /** Real path of the composition folder when minted; it must stay that, and the same directory (dev, ino). */
  compDir: string;
  compDev: number;
  compIno: number;
  composition: unknown;
  frameAncestors: string;
  /** Preview: the runtime page also gets the sandbox CSP, so it is opaque even when opened top-level. */
  sandboxed: boolean;
  /** The normalised media served to this session: the real media folder (and its identity) and the file names by index. */
  media: { dir: string; dev: number; ino: number; names: string[] } | null;
}

const VIDEO_SOURCE_FIELDS = ['sourceStart', 'sourceVideoEnd', 'sourceTrusted', 'audioSrc', 'audioStart'] as const;

/**
 * The composition the runtime page inlines: a copy whose video clips use the session's media (`media/<i>.mp4` and the
 * probed source fields, `sourceTrusted: true`), with their sound named separately: `audioSrc` (the original asset, still
 * served from `assets/`) and `audioStart` (the original's first video frame on its media timeline), which the preview plays
 * in an `<audio>` element because the normalised file has no audio. Any other video clip loses the core-only fields.
 */
export function withSessionMedia(composition: unknown, srcIndex: ReadonlyMap<string, { index: number; media: SessionMediaFile }>): unknown {
  const copy = structuredClone(composition) as { tracks?: unknown };
  if (!Array.isArray(copy.tracks)) return copy;
  for (const track of copy.tracks as unknown[]) {
    const clips = (track as { clips?: unknown } | null)?.clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips as Array<Record<string, unknown> | null>) {
      if (!clip || clip.type !== 'video') continue;
      for (const k of VIDEO_SOURCE_FIELDS) delete clip[k];
      const m = typeof clip.src === 'string' ? srcIndex.get(clip.src) : undefined;
      if (!m) continue;
      clip.audioSrc = clip.src;
      clip.audioStart = m.media.originalVideoStart ?? 0;
      clip.src = `media/${m.index}.mp4`;
      clip.sourceFps = m.media.sourceFps;
      clip.sourceStart = m.media.sourceStart;
      clip.sourceVideoEnd = m.media.sourceVideoEnd;
      clip.sourceTrusted = true;
    }
  }
  return copy;
}

const finitePositive = (n: unknown, max: number) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max;

/** Checks a session's media and indexes it: the real folder, each file's served index, the clip map. Throws when refused. */
async function checkedMedia(m: SessionMedia, realCreative: string): Promise<{ session: NonNullable<Session['media']>; bySrc: Map<string, { index: number; media: SessionMediaFile }> }> {
  if (typeof m !== 'object' || m === null || typeof m.dir !== 'string' || !(m.clips instanceof Map)) throw new Error('composition server: bad media');
  if (m.clips.size > 1000) throw new Error('composition server: too many media files');
  // Only the core's media cache, `<project>/.studio/cache/media`, with no link from the project folder down.
  const tail = ['.studio', 'cache', 'media'];
  if (!m.dir.endsWith(join('', ...tail)) || basename(dirname(dirname(m.dir))) !== '.studio') throw new Error('composition server: not a media cache folder');
  const real = await realpath(m.dir);
  if (real !== join(await realpath(join(m.dir, '..', '..', '..')), ...tail)) throw new Error('composition server: the media folder is reached through a link');
  // And it is the media cache of the creative's own project (`<project>/creatives/<slug>`).
  if (basename(dirname(realCreative)) !== 'creatives' || real !== join(dirname(dirname(realCreative)), ...tail)) {
    throw new Error('composition server: the media folder is not the creative project\'s');
  }
  const info = await lstat(real);
  if (!info.isDirectory()) throw new Error('composition server: the media folder is not a directory');
  const names: string[] = [];
  const bySrc = new Map<string, { index: number; media: SessionMediaFile }>();
  for (const [src, f] of m.clips) {
    if (typeof src !== 'string' || !isCompositionPath(src) || !src.startsWith('assets/')) throw new Error('composition server: bad media clip source');
    if (typeof f?.file !== 'string' || dirname(f.file) !== m.dir || !MEDIA_FILE_RE.test(basename(f.file))) throw new Error('composition server: bad media file');
    if (!finitePositive(f.sourceFps, 240) || !finitePositive(f.sourceVideoEnd, 36_000) || typeof f.sourceStart !== 'number' || !(f.sourceStart >= 0 && f.sourceStart <= 36_000)) {
      throw new Error('composition server: bad media source fields');
    }
    if (f.originalVideoStart !== undefined && !(typeof f.originalVideoStart === 'number' && f.originalVideoStart >= 0 && f.originalVideoStart <= 36_000)) {
      throw new Error('composition server: bad media source fields');
    }
    const st = await lstat(f.file);
    if (!st.isFile() || st.nlink !== 1) throw new Error('composition server: a media file is not a single-linked regular file');
    const name = basename(f.file);
    let index = names.indexOf(name);
    if (index < 0) { index = names.length; names.push(name); }
    bySrc.set(src, { index, media: f });
  }
  return { session: { dir: real, dev: info.dev, ino: info.ino, names }, bySrc };
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
        // One byte more than the fstat size: a file that grew since is refused, never cut.
        const buf = Buffer.alloc(Math.min(info.size, o.maxBytes) + 1);
        let n = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
          if (n > o.maxBytes || n > info.size) return { skipped: 'too-large' as const };
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

  /** A session's normalised media file `media/<i>.mp4` (see the module comment); 404 for anything else. */
  async function serveMedia(req: IncomingMessage, res: ServerResponse, session: Session, segment: string, headers: Record<string, string | string[]>): Promise<void> {
    const m = MEDIA_SEGMENT_RE.exec(segment);
    const name = m && session.media ? session.media.names[Number(m[1])] : undefined;
    if (!name || !session.media) return send(res, 404, headers);
    const media = session.media;
    const stillThere = async () => {
      if ((await realpath(media.dir).catch(() => null)) !== media.dir) return false;
      const st = await lstat(media.dir).catch(() => null);
      return st !== null && st.isDirectory() && st.dev === media.dev && st.ino === media.ino;
    };
    if (!(await stillThere())) return send(res, 404, headers);
    const ok = await serveFile(req, res, media.dir, name, {
      ...headers, 'content-security-policy': [COMPOSITION_CSP, SANDBOX_CSP], 'content-type': 'video/mp4',
    }, { maxBytes: maxFileBytes, ranges: true, check: stillThere });
    if (!ok) send(res, 404, headers);
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
        const pageHeaders: Record<string, string | string[]> = {
          ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length),
          'content-security-policy': [`${COMPOSITION_CSP}; frame-ancestors ${session.frameAncestors}`, ...(session.sandboxed ? [SANDBOX_CSP] : [])],
        };
        res.writeHead(200, pageHeaders);
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
    if (rest.length === prefix.length + 2 && rest[prefix.length] === 'media') return serveMedia(req, res, session, rest[prefix.length + 1]!, headers);
    if (!isCompositionPath(rel)) return notFound();
    const ext = posix.extname(rel).toLowerCase();
    const fileHeaders: Record<string, string | string[]> = {
      ...headers,
      'content-security-policy': [COMPOSITION_CSP, SANDBOX_CSP],
      'content-type': TYPES.get(ext) ?? 'application/octet-stream',
    };
    const dest = req.headers['sec-fetch-dest'];
    // Fonts are always fetched in CORS mode, and the preview document and every layer have opaque origins (README).
    if (req.headers.origin === 'null' && FONT_EXT.has(ext)) fileHeaders['access-control-allow-origin'] = 'null';
    const layer = rel.startsWith('layers/') && ext === '.html';
    if (layer && dest !== 'iframe') return notFound();
    // Still the very directory minted: same real path, same device and inode (a swapped-in real folder is refused too).
    const stillThere = async () => {
      if ((await realpath(session.compDir).catch(() => null)) !== session.compDir) return false;
      const st = await lstat(session.compDir).catch(() => null);
      return st !== null && st.isDirectory() && st.dev === session.compDev && st.ino === session.compIno;
    };
    if (!(await stillThere())) return notFound();
    const ok = await serveFile(req, res, session.compDir, rel, fileHeaders, layer
      ? { maxBytes: maxLayerBytes, ranges: false, check: stillThere, transform: (html) => injectLayerBootstrap(html, `/${target.token}/runtime/layer.js`) }
      : { maxBytes: maxFileBytes, ranges: true, check: stillThere });
    return ok ? undefined : notFound();
  }

  const server = createServer((req, res) => {
    if (opts.onResponse) {
      const log = opts.onResponse;
      res.once('finish', () => log({ method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, status: res.statusCode }));
    }
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 404, baseHeaders());
      else res.destroy();
    });
  });
  // Explicit limits: slow or idle clients cannot hold the listener (the browser opens a handful of connections).
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  expectedHost = `127.0.0.1:${port}`;
  const origin = `http://${expectedHost}`;

  return {
    origin, port,
    limits: { headersTimeout: server.headersTimeout, requestTimeout: server.requestTimeout, keepAliveTimeout: server.keepAliveTimeout, maxConnections: server.maxConnections },
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
      const dirInfo = await lstat(compDir);
      if (!dirInfo.isDirectory()) throw new Error('composition server: the composition folder is not a directory');
      const media = o.media === undefined ? null : await checkedMedia(o.media, realCreative);
      if (closed) throw new Error('composition server: closed');
      const { token, expiresAt } = tokens.mint({
        versionSegments: segs, versionDir: segs.join('/'), format: o.format, compDir, compDev: dirInfo.dev, compIno: dirInfo.ino,
        composition: media ? withSessionMedia(o.composition, media.bySrc) : o.composition, frameAncestors, sandboxed: o.mode === 'preview',
        media: media?.session ?? null,
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
