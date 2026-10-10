// @vitest-environment node
/**
 * The isolated composition server (spec §5.2, layer 1): its own 127.0.0.1 listener, per-session tokens scoped to one
 * composition folder, confined reads, and the exact header set the sandboxed preview and the renderer need.
 * Requests go out over raw `node:http` so the paths reach the server exactly as written (fetch would normalise `..`).
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSITION_PLACEHOLDER } from '@motion-studio/composition-runtime/page';
import { parseTarget, startCompositionServer, type CompositionServer, type CompositionSession } from '../src/compositions/composition-server.ts';
import { mintToken, SessionTokens } from '../src/compositions/serve-token.ts';

const UI = 'http://127.0.0.1:4318';
const DEV_UI = 'http://localhost:5173';
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "script-src 'self' 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const SECRET = 'TOP-SECRET-OUTSIDE-THE-COMPOSITION';
const COMPOSITION = { $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 4, title: '</script><b>x' };

interface Res { status: number; headers: Record<string, string | string[] | undefined>; raw: string[]; body: Buffer }
function all(res: Res, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < res.raw.length; i += 2) if (res.raw[i]!.toLowerCase() === name) out.push(res.raw[i + 1]!);
  return out;
}

let work: string;
let creative: string;
let dist: string;
let server: CompositionServer;
let host: string;
let clock = 1_000_000;

/** A GET (or `method`) with the path sent verbatim and the right Host unless overridden. */
function send(path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: o.method ?? 'GET', headers: { host, ...o.headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}
const iframe = { 'sec-fetch-dest': 'iframe' };

function writeComposition(dir: string, extra: (d: string) => void = () => {}) {
  mkdirSync(join(dir, 'assets', 'sub'), { recursive: true });
  mkdirSync(join(dir, 'layers'), { recursive: true });
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(COMPOSITION));
  writeFileSync(join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'assets', 'mono.woff2'), Buffer.from('wOF2-fake-font'));
  writeFileSync(join(dir, 'assets', 'data.bin'), Buffer.alloc(100, 7));
  writeFileSync(join(dir, 'assets', 'clip.mp4'), Buffer.from('0123456789abcdefghij'));
  writeFileSync(join(dir, 'assets', 'big.png'), Buffer.alloc(4096, 1));
  writeFileSync(join(dir, 'assets', 'sub', 'deep.png'), Buffer.from('deep'));
  writeFileSync(join(dir, 'assets', 'page.html'), '<p>asset html</p>');
  writeFileSync(join(dir, 'layers', 'probe.html'), '<!doctype html><html><body><script>window.x=1</script></body></html>');
  writeFileSync(join(dir, 'layers', 'helper.js'), 'window.y = 2;');
  extra(dir);
}

const comp = (version: string, format: string) => join(creative, 'outputs', version, 'compositions', format);

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ms-comp-server-'));
  creative = join(work, 'project', 'creatives', 'creative');
  dist = join(work, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), `<!doctype html><html><head>${COMPOSITION_PLACEHOLDER}<script src="runtime.js"></script></head><body></body></html>`);
  writeFileSync(join(dist, 'runtime.js'), '/* runtime */');
  writeFileSync(join(dist, 'layer.js'), '/* layer */');
  writeFileSync(join(dist, 'clock.js'), '/* clock */');
  writeFileSync(join(dist, 'secret.js'), '/* not a runtime file */');
  const outside = join(work, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), SECRET);
  writeFileSync(join(outside, 'secret.png'), SECRET);
  mkdirSync(creative, { recursive: true });
  writeFileSync(join(creative, '..', 'creative-secret.txt'), SECRET);
  writeFileSync(join(work, 'hard-target.png'), SECRET);

  writeComposition(comp('v1', 'story'), (d) => {
    symlinkSync(join(outside, 'secret.png'), join(d, 'assets', 'link.png'));
    symlinkSync(outside, join(d, 'assets', 'outdir'));
    linkSync(join(work, 'hard-target.png'), join(d, 'assets', 'hard.png'));
    execFileSync('mkfifo', [join(d, 'assets', 'pipe.png')]);
    writeFileSync(join(d, 'secret.txt'), SECRET);
  });
  writeComposition(comp('v1', 'square'));
  writeComposition(comp('v2', 'story'));
  // A composition whose whole assets/ folder is a symlink to another folder.
  mkdirSync(join(comp('v1', 'linked'), 'layers'), { recursive: true });
  symlinkSync(outside, join(comp('v1', 'linked'), 'assets'));
  // A composition folder that is itself a symlink.
  symlinkSync(comp('v2', 'story'), comp('v1', 'aliased'));

  server = await startCompositionServer({ uiOrigins: [UI, DEV_UI], distDir: dist, maxFileBytes: 2048, now: () => clock, ttlMs: 60_000 });
  host = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

const mint = (o: Partial<Parameters<CompositionServer['mintSession']>[0]> = {}): Promise<CompositionSession> => server.mintSession({
  creativeDir: creative, versionDir: 'outputs/v1', format: 'story', composition: COMPOSITION, mode: 'preview', parentOrigin: UI, ...o,
});
const prefix = (s: CompositionSession, version = 'outputs/v1', format = 'story') => `/${s.token}/${version}/compositions/${format}`;

describe('tokens', () => {
  it('mints at least 128 random bits, url-safe, never twice the same', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
  });

  it('a store finds a live token, forgets an expired or revoked one, and refuses malformed ones', () => {
    let now = 0;
    const store = new SessionTokens<string>(() => now);
    const s = store.mint('a', 1000);
    expect(store.get(s.token)).toBe('a');
    expect(store.get(s.token.slice(0, -1) + (s.token.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(store.get('')).toBeNull();
    expect(store.get('../../etc')).toBeNull();
    now = 999;
    store.renew(s.token);
    now = 1500;
    expect(store.get(s.token)).toBe('a');
    now = 2000;
    expect(store.get(s.token)).toBeNull();
    const t = store.mint('b', 1000);
    store.revoke(t.token);
    expect(store.get(t.token)).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('request targets', () => {
  it('decodes once, NFC-normalises, and refuses encoded separators, double encoding, backslashes and absolute-form', () => {
    expect(parseTarget('/tok/runtime/index.html?mode=render')).toEqual({ token: 'tok', rest: ['runtime', 'index.html'] });
    expect(parseTarget('/tok/a/caf%C3%A9.png')).toEqual({ token: 'tok', rest: ['a', 'caf\u00e9.png'] });
    expect(parseTarget('/tok/a/cafe%CC%81.png')).toEqual({ token: 'tok', rest: ['a', 'caf\u00e9.png'] });
    for (const u of ['/tok/a%2fb', '/tok/a%2Fb', '/tok/a%5cb', '/tok/a%00b', '/tok/a\\b', '/tok/%252e%252e/x', '/tok/a%25', '/tok/%zz',
      'http://evil.example/tok/a', '*', '', 'tok/a', '/tok', '/tok/a#b']) expect(parseTarget(u), u).toBeNull();
  });
});

describe('the listener', () => {
  it('has explicit timeouts and a connection cap', () => {
    expect(server.limits).toEqual({ headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, maxConnections: 64 });
  });

  it('listens on 127.0.0.1 on its own random port', () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(4318);
  });

  it('refuses a Host other than exactly 127.0.0.1:<port> (DNS rebinding)', async () => {
    const s = await mint();
    for (const h of [`localhost:${server.port}`, 'evil.example', `evil.example:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port}.evil.example`, `[::1]:${server.port}`]) {
      const r = await send(`/${s.token}/runtime/index.html`, { headers: { host: h } });
      expect(r.status, h).toBe(421);
      expect(r.body.length).toBe(0);
    }
  });

  it('answers any method but GET and HEAD with 405', async () => {
    const s = await mint();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await send(`${prefix(s)}/assets/logo.svg`, { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
  });

  it('never exposes the core API: those paths are 404, with or without a token', async () => {
    const s = await mint();
    for (const p of ['/', '/api/health', '/api/projects', '/api/settings/language', '/api/bridge/x', `/${s.token}/api/health`, `/${s.token}/`, `/${s.token}`, '/index.html', '/runtime/runtime.js']) {
      expect((await send(p)).status, p).toBe(404);
    }
  });
});

describe('the runtime', () => {
  it('serves runtime/index.html with the composition inlined and the exact headers (frame-ancestors = the session parent)', async () => {
    const s = await mint();
    expect(s.url).toBe(`${server.origin}/${s.token}/runtime/index.html?mode=preview&parentOrigin=${encodeURIComponent(UI)}`);
    const r = await send(new URL(s.url).pathname + new URL(s.url).search);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(all(r, 'content-security-policy')).toEqual([`${CSP}; frame-ancestors ${UI}`, 'sandbox allow-scripts']);
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers['access-control-allow-private-network']).toBeUndefined();
    const html = r.body.toString('utf8');
    expect(html).toContain('<script type="application/json" id="ms-composition">');
    expect(html).toContain('"base":"../outputs/v1/compositions/story/"');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).not.toContain('</script><b>');
  });

  it('a session from the dev UI origin gets that origin; a render session gets frame-ancestors none', async () => {
    const dev = await mint({ parentOrigin: DEV_UI });
    expect(all(await send(`/${dev.token}/runtime/index.html`), 'content-security-policy')).toEqual([`${CSP}; frame-ancestors ${DEV_UI}`, 'sandbox allow-scripts']);
    const render = await mint({ mode: 'render', parentOrigin: undefined });
    expect(render.url).toBe(`${server.origin}/${render.token}/runtime/index.html?mode=render`);
    expect(all(await send(`/${render.token}/runtime/index.html`), 'content-security-policy')).toEqual([`${CSP}; frame-ancestors 'none'`]);
  });

  it('serves the three scripts as JavaScript, nothing else from dist', async () => {
    const s = await mint();
    for (const f of ['runtime.js', 'layer.js', 'clock.js']) {
      const r = await send(`/${s.token}/runtime/${f}`);
      expect(r.status, f).toBe(200);
      expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(all(r, 'content-security-policy')).toEqual([CSP]);
      expect(r.body.toString()).toContain(f.replace('.js', ''));
    }
    for (const f of ['secret.js', '', 'index.htm', '../runtime/runtime.js', 'RUNTIME.JS']) expect((await send(`/${s.token}/runtime/${f}`)).status, f).toBe(404);
  });
});

describe('composition files', () => {
  it('a layer gets the bootstrap first, the regular CSP without frame-ancestors, and a sandbox CSP', async () => {
    const s = await mint();
    const r = await send(`${prefix(s)}/layers/probe.html`, { headers: iframe });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(all(r, 'content-security-policy')).toEqual([CSP, 'sandbox allow-scripts']);
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.toString()).toBe(`<!doctype html><script src="/${s.token}/runtime/layer.js" data-ms-layer-bootstrap></script><html><body><script>window.x=1</script></body></html>`);
  });

  it('a layer is only served into an iframe (Sec-Fetch-Dest), never as a top-level document', async () => {
    const s = await mint();
    expect((await send(`${prefix(s)}/layers/probe.html`)).status).toBe(404);
    expect((await send(`${prefix(s)}/layers/probe.html`, { headers: { 'sec-fetch-dest': 'document' } })).status).toBe(404);
    const head = await send(`${prefix(s)}/layers/probe.html`, { method: 'HEAD', headers: iframe });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });

  it('an asset gets the regular CSP (no frame-ancestors) and its allowlisted type', async () => {
    const s = await mint();
    const r = await send(`${prefix(s)}/assets/logo.svg`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/svg+xml');
    expect(all(r, 'content-security-policy')).toEqual([CSP, 'sandbox allow-scripts']);
    expect(all(r, 'content-security-policy').join(' ')).not.toContain('frame-ancestors');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.body.toString()).toContain('<svg');
    expect((await send(`${prefix(s)}/assets/sub/deep.png`)).body.toString()).toBe('deep');
    expect((await send(`${prefix(s)}/layers/helper.js`)).headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('html outside layers/ is served sandboxed and without the bootstrap', async () => {
    const s = await mint();
    const r = await send(`${prefix(s)}/assets/page.html`);
    expect(r.status).toBe(200);
    expect(all(r, 'content-security-policy')).toEqual([CSP, 'sandbox allow-scripts']);
    expect(r.body.toString()).toBe('<p>asset html</p>');
  });

  it('an unknown extension is application/octet-stream, never sniffed', async () => {
    const s = await mint();
    const r = await send(`${prefix(s)}/assets/data.bin`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a font fetched with Origin: null gets ACAO null and Vary: Origin; without it, or for a non-font, no ACAO', async () => {
    const s = await mint();
    const font = await send(`${prefix(s)}/assets/mono.woff2`, { headers: { origin: 'null', 'sec-fetch-dest': 'font' } });
    expect(font.status).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.headers['access-control-allow-origin']).toBe('null');
    expect(font.headers.vary).toBe('Origin');
    expect(font.headers['access-control-allow-credentials']).toBeUndefined();
    expect(font.headers['access-control-allow-private-network']).toBeUndefined();
    // A font extension is enough (Sec-Fetch-Dest is not sent by every client).
    expect((await send(`${prefix(s)}/assets/mono.woff2`, { headers: { origin: 'null' } })).headers['access-control-allow-origin']).toBe('null');

    const plain = await send(`${prefix(s)}/assets/mono.woff2`);
    expect(plain.status).toBe(200);
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();
    expect(plain.headers.vary).toBe('Origin');
    const other = await send(`${prefix(s)}/assets/mono.woff2`, { headers: { origin: 'http://evil.example', 'sec-fetch-dest': 'font' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    // Sec-Fetch-Dest: font alone is not enough: the file must be a font.
    const notFont = await send(`${prefix(s)}/assets/data.bin`, { headers: { origin: 'null', 'sec-fetch-dest': 'font' } });
    expect(notFont.status).toBe(200);
    expect(notFont.headers['access-control-allow-origin']).toBeUndefined();
    for (const p of ['assets/logo.svg', 'assets/data.bin', 'layers/helper.js']) {
      const r = await send(`${prefix(s)}/${p}`, { headers: { origin: 'null' } });
      expect(r.status, p).toBe(200);
      expect(r.headers['access-control-allow-origin'], p).toBeUndefined();
    }
    const idx = await send(`/${s.token}/runtime/index.html`, { headers: { origin: 'null' } });
    expect(idx.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves byte ranges for media (206), and 416 for an unsatisfiable range', async () => {
    const s = await mint();
    const a = await send(`${prefix(s)}/assets/clip.mp4`, { headers: { range: 'bytes=2-5' } });
    expect(a.status).toBe(206);
    expect(a.body.toString()).toBe('2345');
    expect(a.headers['content-range']).toBe('bytes 2-5/20');
    expect(a.headers['content-type']).toBe('video/mp4');
    expect((await send(`${prefix(s)}/assets/clip.mp4`, { headers: { range: 'bytes=15-' } })).body.toString()).toBe('fghij');
    expect((await send(`${prefix(s)}/assets/clip.mp4`, { headers: { range: 'bytes=-3' } })).body.toString()).toBe('hij');
    expect((await send(`${prefix(s)}/assets/clip.mp4`, { headers: { range: 'bytes=10-999' } })).body.toString()).toBe('abcdefghij');
    const bad = await send(`${prefix(s)}/assets/clip.mp4`, { headers: { range: 'bytes=50-60' } });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */20');
    // Several ranges or a malformed header: the whole file.
    const multi = await send(`${prefix(s)}/assets/clip.mp4`, { headers: { range: 'bytes=0-1,4-5' } });
    expect(multi.status).toBe(200);
    expect(multi.body.length).toBe(20);
    const full = await send(`${prefix(s)}/assets/clip.mp4`);
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-length']).toBe('20');
  });

  it('composition.json is never served: it is inlined', async () => {
    const s = await mint();
    expect((await send(`${prefix(s)}/composition.json`)).status).toBe(404);
    expect((await send(`${prefix(s)}/assets/../composition.json`)).status).toBe(404);
  });

  it('only assets/ and layers/ are served; folders and other files are 404', async () => {
    const s = await mint();
    for (const p of ['secret.txt', 'assets', 'assets/', 'assets/sub', 'assets/sub/', 'layers/', 'assets//logo.svg', 'assets/./logo.svg', 'other/x.png', '']) {
      expect((await send(`${prefix(s)}/${p}`)).status, p).toBe(404);
    }
  });
});

describe('confinement', () => {
  const noSecret = (r: Res) => { expect(r.status).toBe(404); expect(r.body.toString()).not.toContain(SECRET); };

  it('refuses path traversal, plain and encoded', async () => {
    const s = await mint();
    const base = prefix(s);
    for (const p of [
      'assets/../secret.txt', 'assets/../../../../creative-secret.txt', 'assets/../../../../../../outside/secret.txt',
      'assets/..%2fsecret.txt', 'assets/..%2Fsecret.txt', 'assets%2f..%2fsecret.txt', 'assets/%2e%2e/secret.txt', 'assets/%2E%2E/secret.txt',
      'assets/.%2e/secret.txt', 'assets/..%5csecret.txt', 'assets/..%5Csecret.txt', 'assets\\..\\secret.txt', 'assets/..\\secret.txt',
      'assets/%252e%252e/secret.txt', 'assets/%25252e%25252e/secret.txt', 'assets/..%252fsecret.txt', 'assets/logo.svg%00.png',
      'assets/logo.svg%00', 'assets/%c0%ae%c0%ae/secret.txt', 'assets/%e0%80%ae%e0%80%ae/secret.txt', 'assets/%zz', 'assets/%',
      'assets/%u002e%u002e/secret.txt',
    ]) noSecret(await send(`${base}/${p}`));
    noSecret(await send(`/${s.token}/outputs/v1/compositions/story/../../../../outside/secret.txt`));
    noSecret(await send(`/${s.token}/runtime/../outputs/v1/compositions/story/secret.txt`));
    noSecret(await send(`/${s.token}/runtime/..%2f..%2fsecret.txt`));
    noSecret(await send(`/${s.token}%2fruntime%2findex.html`));
  });

  it('refuses a symlink out, a symlinked folder and a symlinked assets/', async () => {
    const s = await mint();
    noSecret(await send(`${prefix(s)}/assets/link.png`));
    noSecret(await send(`${prefix(s)}/assets/outdir/secret.png`));
    const linked = await mint({ format: 'linked' });
    noSecret(await send(`${prefix(linked, 'outputs/v1', 'linked')}/assets/secret.png`));
  });

  it('refuses a hard link (nlink > 1), a FIFO (without hanging) and an oversized file', async () => {
    const s = await mint();
    noSecret(await send(`${prefix(s)}/assets/hard.png`));
    expect((await send(`${prefix(s)}/assets/pipe.png`)).status).toBe(404);
    expect((await send(`${prefix(s)}/assets/big.png`)).status).toBe(404);
  });

  it('a composition folder that is itself a symlink, or reached through one, cannot get a session', async () => {
    await expect(mint({ format: 'aliased' })).rejects.toThrow();
    await expect(mint({ versionDir: 'outputs/v9' })).rejects.toThrow();
  });

  it('a folder swapped for a symlink after the session started is refused', async () => {
    writeComposition(comp('v3', 'story'));
    const s = await mint({ versionDir: 'outputs/v3' });
    expect((await send(`${prefix(s, 'outputs/v3')}/assets/logo.svg`)).status).toBe(200);
    renameSync(join(creative, 'outputs', 'v3'), join(creative, 'outputs', 'v3-moved'));
    mkdirSync(join(creative, 'outputs', 'v3', 'compositions'), { recursive: true });
    symlinkSync(join(work, 'outside'), join(creative, 'outputs', 'v3', 'compositions', 'story'));
    writeFileSync(join(work, 'outside', 'logo.svg'), SECRET);
    mkdirSync(join(work, 'outside', 'assets'), { recursive: true });
    writeFileSync(join(work, 'outside', 'assets', 'logo.svg'), SECRET);
    noSecret(await send(`${prefix(s, 'outputs/v3')}/assets/logo.svg`));
  });

  it('a real folder swapped in at the same path after the session started is refused (dev/ino)', async () => {
    writeComposition(comp('v4', 'story'));
    const s = await mint({ versionDir: 'outputs/v4' });
    expect((await send(`${prefix(s, 'outputs/v4')}/assets/logo.svg`)).status).toBe(200);
    renameSync(comp('v4', 'story'), join(creative, 'outputs', 'v4', 'compositions', 'story-old'));
    writeComposition(comp('v4', 'story'), (d) => writeFileSync(join(d, 'assets', 'logo.svg'), SECRET));
    noSecret(await send(`${prefix(s, 'outputs/v4')}/assets/logo.svg`));
  });

  it('mintSession validates its arguments', async () => {
    await expect(mint({ versionDir: '../v1' })).rejects.toThrow();
    await expect(mint({ versionDir: 'outputs/../outputs/v1' })).rejects.toThrow();
    await expect(mint({ versionDir: '/abs' })).rejects.toThrow();
    await expect(mint({ format: 'Story' })).rejects.toThrow();
    await expect(mint({ format: '../story' })).rejects.toThrow();
    await expect(mint({ parentOrigin: undefined })).rejects.toThrow();
    await expect(mint({ parentOrigin: 'http://evil.example' })).rejects.toThrow();
    await expect(mint({ parentOrigin: `${UI}/` })).rejects.toThrow();
    await expect(mint({ mode: 'render', parentOrigin: UI })).rejects.toThrow();
    await expect(mint({ mode: 'other' as 'render' })).rejects.toThrow();
  });
});

describe('session scope', () => {
  it('an unknown or malformed token is 404', async () => {
    const s = await mint();
    const other = mintToken();
    expect((await send(`/${other}/runtime/index.html`)).status).toBe(404);
    expect((await send(`/${other}/outputs/v1/compositions/story/assets/logo.svg`)).status).toBe(404);
    expect((await send(`/${s.token.slice(1)}/runtime/index.html`)).status).toBe(404);
    expect((await send(`/${s.token.toUpperCase()}/runtime/index.html`)).status).toBe(404);
  });

  it('an expired token is 404; renew() keeps a live one going; revoke() ends it', async () => {
    const s = await mint({ ttlMs: 1000 });
    expect((await send(`/${s.token}/runtime/index.html`)).status).toBe(200);
    clock += 900;
    s.renew();
    clock += 900;
    expect((await send(`/${s.token}/runtime/runtime.js`)).status).toBe(200);
    clock += 1100;
    expect((await send(`/${s.token}/runtime/runtime.js`)).status).toBe(404);
    expect((await send(`${prefix(s)}/assets/logo.svg`)).status).toBe(404);
    const t = await mint();
    t.revoke();
    expect((await send(`/${t.token}/runtime/index.html`)).status).toBe(404);
  });

  it('a token serves only its own composition folder: not another version, not another format', async () => {
    const s = await mint();
    expect((await send(`${prefix(s)}/assets/logo.svg`)).status).toBe(200);
    expect((await send(`${prefix(s, 'outputs/v2', 'story')}/assets/logo.svg`)).status).toBe(404);
    expect((await send(`${prefix(s, 'outputs/v1', 'square')}/assets/logo.svg`)).status).toBe(404);
    const sq = await mint({ format: 'square' });
    expect((await send(`${prefix(sq, 'outputs/v1', 'square')}/assets/logo.svg`)).status).toBe(200);
    expect((await send(`${prefix(sq)}/assets/logo.svg`)).status).toBe(404);
  });
});

describe('closing', () => {
  it('close() stops the listener and ends every session', async () => {
    const own = await startCompositionServer({ uiOrigins: () => [UI], distDir: dist });
    const s = await own.mintSession({ creativeDir: creative, versionDir: 'outputs/v1', format: 'story', composition: COMPOSITION, mode: 'render' });
    await own.close();
    await expect(fetch(s.url)).rejects.toThrow();
    await expect(own.mintSession({ creativeDir: creative, versionDir: 'outputs/v1', format: 'story', composition: COMPOSITION, mode: 'render' })).rejects.toThrow();
  });

  it('refuses a bad UI origin in its configuration', async () => {
    await expect(startCompositionServer({ uiOrigins: ['http://127.0.0.1:4318/'], distDir: dist })).rejects.toThrow();
    await expect(startCompositionServer({ uiOrigins: ['file://x'], distDir: dist })).rejects.toThrow();
    await expect(startCompositionServer({ uiOrigins: ["http://a.example 'unsafe-inline'"], distDir: dist })).rejects.toThrow();
  });
});

describe('normalised media (Task 5)', () => {
  const SHA = 'a'.repeat(64);
  const NAME = `${SHA}-30-640x360-n1.mp4`;
  let mediaDir: string;
  const VIDEO_COMP = {
    ...COMPOSITION, tracks: [{ id: 't', kind: 'video', clips: [
      { id: 'a', type: 'video', src: 'assets/clip.mp4', start: 0, duration: 1, sourceFps: 24, props: {} },
      { id: 'b', type: 'video', src: 'assets/clip.mp4', start: 1, duration: 1, props: {} },
      { id: 'c', type: 'video', src: 'assets/other.mp4', start: 2, duration: 1, sourceTrusted: true, sourceVideoEnd: 9, sourceStart: 0.5, props: {} },
      { id: 'd', type: 'image', src: 'assets/big.png', start: 0, duration: 1, props: {} },
    ] }],
  };
  const fields = { sourceFps: 30, sourceStart: 0, sourceVideoEnd: 2.5, originalVideoStart: 0.25, originalAudio: true };

  beforeAll(() => {
    mediaDir = join(work, 'project', '.studio', 'cache', 'media');
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, NAME), Buffer.from('NORMALISED-0123456789'));
    writeFileSync(join(mediaDir, `${'b'.repeat(64)}-30-640x360-n1.mp4`), Buffer.from('OTHER'));
    writeFileSync(join(mediaDir, 'notes.txt'), SECRET);
  });
  const media = (clips: Array<[string, { file: string; sourceFps: number; sourceStart: number; sourceVideoEnd: number; originalVideoStart?: number; originalAudio?: boolean }]>, dir = mediaDir) => ({ dir, clips: new Map(clips) });
  const inlined = (html: string) => JSON.parse(/<script type="application\/json" id="ms-composition">(.*?)<\/script>/s.exec(html)![1]!) as { composition: typeof VIDEO_COMP };

  it('rewrites the mapped video clips to media/<i>.mp4 with the probed fields and sourceTrusted, in the inlined copy only', async () => {
    const original = structuredClone(VIDEO_COMP);
    for (const mode of ['render', 'preview'] as const) {
      const s = await mint({ composition: VIDEO_COMP, mode, ...(mode === 'render' ? { parentOrigin: undefined } : {}), media: media([['assets/clip.mp4', { file: join(mediaDir, NAME), ...fields }]]) });
      const page = await send(new URL(s.url).pathname);
      const clips = inlined(page.body.toString('utf8')).composition.tracks[0]!.clips as Array<Record<string, unknown>>;
      expect(clips[0]).toMatchObject({ src: 'media/0.mp4', sourceFps: 30, sourceStart: 0, sourceVideoEnd: 2.5, sourceTrusted: true, audioSrc: 'assets/clip.mp4', audioStart: 0.25 });
      expect(clips[1]).toMatchObject({ src: 'media/0.mp4', sourceTrusted: true });
      // Not mapped (its normalisation failed): its own file, and no core-only field survives (the lenient rule).
      expect(clips[2]).toEqual({ id: 'c', type: 'video', src: 'assets/other.mp4', start: 2, duration: 1, props: {} });
      expect(clips[3]).toEqual(VIDEO_COMP.tracks[0]!.clips[3]);
    }
    expect(VIDEO_COMP).toEqual(original); // the caller's composition (the agent's, hashed) is never changed
    // A source without an audio stream gets no audioSrc (nothing to play in the preview).
    const silent = await mint({ composition: VIDEO_COMP, media: media([['assets/clip.mp4', { file: join(mediaDir, NAME), ...fields, originalAudio: false }]]) });
    const clip0 = inlined((await send(new URL(silent.url).pathname)).body.toString('utf8')).composition.tracks[0]!.clips[0] as Record<string, unknown>;
    expect(clip0.src).toBe('media/0.mp4');
    expect(clip0.audioSrc).toBeUndefined();
  });

  it('serves exactly the mapped files, with the composition headers and byte ranges; anything else under media/ is 404', async () => {
    const s = await mint({ composition: VIDEO_COMP, media: media([['assets/clip.mp4', { file: join(mediaDir, NAME), ...fields }]]) });
    const r = await send(`${prefix(s)}/media/0.mp4`);
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('NORMALISED-0123456789');
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(all(r, 'content-security-policy')).toEqual([CSP, 'sandbox allow-scripts']);
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['accept-ranges']).toBe('bytes');
    const part = await send(`${prefix(s)}/media/0.mp4`, { headers: { range: 'bytes=11-14' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('0123');
    expect(part.headers['content-range']).toBe('bytes 11-14/21');
    expect((await send(`${prefix(s)}/media/0.mp4`, { method: 'HEAD' })).status).toBe(200);
    for (const p of ['media/1.mp4', 'media/notes.txt', `media/${NAME}`, 'media/0.mp4/x', 'media/..%2fnotes.txt', 'media/%2e%2e/notes.txt', 'media/', 'media']) {
      const x = await send(`${prefix(s)}/${p}`);
      expect(x.status, p).toBe(404);
      expect(x.body.toString()).not.toContain(SECRET);
    }
    // Another version or format of the same token: nothing.
    expect((await send(`/${s.token}/outputs/v2/compositions/story/media/0.mp4`)).status).toBe(404);
    expect((await send(`/${s.token}/media/0.mp4`)).status).toBe(404);
    // A session without media serves no media.
    const plain = await mint();
    expect((await send(`${prefix(plain)}/media/0.mp4`)).status).toBe(404);
  });

  it('refuses a media file that became a symlink or a hard link, or a media folder swapped after the mint', async () => {
    const dir = join(work, 'project2', '.studio', 'cache', 'media');
    mkdirSync(dir, { recursive: true });
    const creative2 = join(work, 'project2', 'creatives', 'c2');
    writeComposition(join(creative2, 'outputs', 'v1', 'compositions', 'story'));
    const file = join(dir, NAME);
    writeFileSync(file, 'GOOD');
    const s = await mint({ creativeDir: creative2, composition: VIDEO_COMP, media: media([['assets/clip.mp4', { file, ...fields }]], dir) });
    expect((await send(`${prefix(s)}/media/0.mp4`)).status).toBe(200);
    rmSync(file);
    symlinkSync(join(work, 'outside', 'secret.txt'), file);
    expect((await send(`${prefix(s)}/media/0.mp4`)).status).toBe(404);
    rmSync(file);
    linkSync(join(work, 'outside', 'secret.txt'), file);
    const hard = await send(`${prefix(s)}/media/0.mp4`);
    expect(hard.status).toBe(404);
    expect(hard.body.toString()).not.toContain(SECRET);
    rmSync(file);
    writeFileSync(file, 'GOOD');
    expect((await send(`${prefix(s)}/media/0.mp4`)).status).toBe(200);
    // The whole media folder swapped for another real folder at the same path (dev/ino): refused.
    renameSync(dir, `${dir}-old`);
    mkdirSync(dir);
    writeFileSync(join(dir, NAME), SECRET);
    const swapped = await send(`${prefix(s)}/media/0.mp4`);
    expect(swapped.status).toBe(404);
    expect(swapped.body.toString()).not.toContain(SECRET);
  });

  it('mintSession refuses bad media: outside the folder, a bad name, links, a linked folder, bad source fields', async () => {
    const good = { file: join(mediaDir, NAME), ...fields };
    const bad = async (m: ReturnType<typeof media>) => expect(mint({ composition: VIDEO_COMP, media: m })).rejects.toThrow(/composition server|ENOENT/);
    await bad(media([['assets/clip.mp4', { ...good, file: join(work, 'outside', 'secret.txt') }]]));
    await bad(media([['assets/clip.mp4', { ...good, file: join(mediaDir, 'notes.txt') }]]));
    await bad(media([['assets/clip.mp4', { ...good, file: `${mediaDir}/../media/${NAME}` }]]));
    await bad(media([['assets/clip.mp4', { ...good, file: join(mediaDir, `${'c'.repeat(64)}-30-640x360-n1.mp4`) }]])); // missing
    await bad(media([['../clip.mp4', good]]));
    await bad(media([['layers/x.mp4', good]]));
    for (const f of [{ sourceFps: 0 }, { sourceFps: Number.NaN }, { sourceVideoEnd: 0 }, { sourceStart: -1 }, { sourceStart: '0' }]) {
      await bad(media([['assets/clip.mp4', { ...good, ...f } as typeof good]]));
    }
    const hardName = `${'d'.repeat(64)}-30-640x360-n1.mp4`;
    writeFileSync(join(work, 'hard-media.mp4'), 'X');
    linkSync(join(work, 'hard-media.mp4'), join(mediaDir, hardName));
    await bad(media([['assets/clip.mp4', { ...good, file: join(mediaDir, hardName) }]]));
    const linkName = `${'e'.repeat(64)}-30-640x360-n1.mp4`;
    symlinkSync(join(mediaDir, NAME), join(mediaDir, linkName));
    await bad(media([['assets/clip.mp4', { ...good, file: join(mediaDir, linkName) }]]));
    // Not the media cache, or the cache reached through a link below the project folder.
    await bad(media([['assets/clip.mp4', { ...good, file: join(work, 'outside', NAME) }]], join(work, 'outside')));
    mkdirSync(join(work, 'project3'));
    symlinkSync(join(work, 'project', '.studio'), join(work, 'project3', '.studio'));
    const aliasDir = join(work, 'project3', '.studio', 'cache', 'media');
    await bad(media([['assets/clip.mp4', { ...good, file: join(aliasDir, NAME) }]], aliasDir));
    await expect(mint({ composition: VIDEO_COMP, media: { dir: mediaDir, clips: {} as never } })).rejects.toThrow();
    // Another project's media cache (M8): refused, even though it is a real media cache.
    const otherDir = join(work, 'project4', '.studio', 'cache', 'media');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, NAME), 'OTHER PROJECT');
    await expect(mint({ composition: VIDEO_COMP, media: media([['assets/clip.mp4', { ...good, file: join(otherDir, NAME) }]], otherDir) })).rejects.toThrow(/project/);
    for (const bad2 of [-1, Number.NaN, '0']) await bad(media([['assets/clip.mp4', { ...good, originalVideoStart: bad2 as number }]]));
  });
});
