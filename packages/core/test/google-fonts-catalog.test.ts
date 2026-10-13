import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleFontsCatalog, parseCatalog, PREVIEW_CACHE_MAX, CATALOG_TTL_MS } from '../src/providers/google-fonts-catalog.ts';
import { fetchTransport, type LookupFn } from '../src/providers/safe-fetch.ts';

const publicLookup: LookupFn = async () => [{ address: '142.250.180.3', family: 4 }];
const net = (f: typeof fetch) => ({ fetch: f, transport: fetchTransport(f), lookup: publicLookup });

const entry = (family: string, category: string, keys: string[], popularity?: number, wght = false) => ({
  family, category, fonts: Object.fromEntries(keys.map((k) => [k, {}])), axes: wght ? [{ tag: 'wght', min: 100, max: 900 }] : [], ...(popularity !== undefined ? { popularity } : {}), subsets: ['latin'], stroke: 'Sans Serif',
});
const LIST = [
  entry('Roboto Slab', 'Serif', ['400', '700'], 3, true),
  entry('Roboto', 'Sans Serif', ['400', '400i', '700'], 1),
  entry('Open Sans', 'Sans Serif', ['300', '400', '400i'], 2, true),
  entry('Autoroboto', 'Display', ['400']),
  entry('Zilla', 'Serif', ['400'], 9),
];
const BODY = JSON.stringify({ axisRegistry: [], familyMetadataList: LIST });
const PREFIX = `)]}'\n`;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ms-gfc-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

interface Fake { fetch: typeof fetch; urls: string[]; catalog: { status: number; body: string | Uint8Array<ArrayBuffer>; type?: string } }
function fake(): Fake {
  const f: Fake = {
    urls: [], catalog: { status: 200, body: PREFIX + BODY },
    fetch: (async (url: string) => {
      f.urls.push(url);
      if (url.startsWith('https://fonts.google.com/metadata/fonts')) return new Response(f.catalog.body as BodyInit, { status: f.catalog.status, headers: { 'content-type': f.catalog.type ?? 'application/json' } });
      if (url.startsWith('https://fonts.googleapis.com/css2')) {
        if (url.includes('family=Nope')) return new Response('bad', { status: 400 });
        const w = /wght@(\d+)/.exec(url)?.[1] ?? '400';
        const fam = decodeURIComponent(/family=([^:&]+)/.exec(url)![1]!).replace(/\+/g, ' ');
        return new Response(`@font-face { font-family: '${fam}'; font-style: normal; font-weight: ${w}; src: url(https://fonts.gstatic.com/l/${fam.replace(/ /g, '')}-${w}.woff2) format('woff2'); }`, { status: 200, headers: { 'content-type': 'text/css' } });
      }
      if (url.startsWith('https://fonts.gstatic.com/')) return new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]), { status: 200, headers: { 'content-type': 'font/woff2' } });
      return new Response('no', { status: 404 });
    }) as unknown as typeof fetch,
  } as Fake;
  return f;
}
const make = (f: Fake, now: () => number = Date.now) => new GoogleFontsCatalog({ configDir: dir, http: net(f.fetch), now });
const cacheFile = () => join(dir, 'cache', 'google-fonts-catalog.json');

describe('parseCatalog', () => {
  it('reads the body with and without the anti-JSON prefix and keeps only what is needed', () => {
    const a = parseCatalog(PREFIX + BODY)!;
    expect(a).toEqual(parseCatalog(BODY));
    expect(a.find((x) => x.family === 'Roboto')).toEqual({ family: 'Roboto', category: 'Sans Serif', weights: [400, 700], italic: true, variable: false, popularity: 1 });
    expect(a.find((x) => x.family === 'Open Sans')).toMatchObject({ weights: [300, 400], variable: true });
    expect(JSON.stringify(a)).not.toContain('subsets');
  });
  it('rejects a changed shape, html and a list with nothing usable', () => {
    expect(parseCatalog('<!doctype html><html></html>')).toBeNull();
    expect(parseCatalog(JSON.stringify({ fonts: [] }))).toBeNull();
    expect(parseCatalog(JSON.stringify({ familyMetadataList: [{ name: 'x' }, { family: 'Bad;Name', fonts: { 400: {} } }] }))).toBeNull();
  });
});

describe('catalog fetch and cache', () => {
  it('fetches once, caches with fetchedAt and serves the second search from the cache', async () => {
    const f = fake();
    const c = make(f);
    const r = await c.search({ q: 'roboto' });
    expect(r).toMatchObject({ stale: false, fallback: false });
    expect(JSON.parse(await readFile(cacheFile(), 'utf8')).fetchedAt).toBeTypeOf('number');
    await make(f).search({});
    expect(f.urls.filter((u) => u.includes('/metadata/fonts'))).toHaveLength(1);
  });
  it.each([
    ['a 500', { status: 500, body: 'oops' }],
    ['html', { status: 200, body: '<html>captcha</html>', type: 'text/html' }],
    ['a changed shape', { status: 200, body: JSON.stringify({ families: [] }) }],
    ['an oversize body', { status: 200, body: new Uint8Array(8 * 1024 * 1024 + 10).fill(32) }],
  ])('falls back to the exact name on %s (no cache)', async (_n, resp) => {
    const f = fake();
    f.catalog = resp;
    const r = await make(f).search({ q: 'Lato' });
    expect(r.fallback).toBe(true);
    expect(r.families).toEqual([expect.objectContaining({ family: 'Lato' })]);
    expect(f.urls.some((u) => u.includes('css2?family=Lato'))).toBe(true);
    expect((await make(f).search({ q: 'Nope' })).families).toEqual([]);
    expect((await make(f).search({ q: 'Bad;Name' })).families).toEqual([]);
    await expect(readFile(cacheFile())).rejects.toThrow();
  });
  it('uses the stale cache after 7 days when the refresh fails, marked stale, and keeps the file', async () => {
    const f = fake();
    let t = 1_000_000;
    await make(f, () => t).search({});
    t += CATALOG_TTL_MS + 1;
    f.catalog = { status: 500, body: 'x' };
    const r = await make(f, () => t).search({ q: 'roboto' });
    expect(r).toMatchObject({ stale: true, fallback: false });
    expect(r.families.length).toBeGreaterThan(0);
    f.catalog = { status: 200, body: PREFIX + BODY };
    t += 6 * 60 * 1000;
    expect((await make(f, () => t).search({})).stale).toBe(false);
  });
  it('does not hit the network again within the cache lifetime', async () => {
    const f = fake();
    let t = 5;
    const c = make(f, () => t);
    await c.search({});
    t += CATALOG_TTL_MS - 10;
    await c.search({});
    expect(f.urls).toHaveLength(1);
  });
});

describe('search ranking', () => {
  it('puts the exact and prefix matches before substrings, then popularity, and filters the category', async () => {
    const c = make(fake());
    expect((await c.search({ q: 'roboto' })).families.map((x) => x.family)).toEqual(['Roboto', 'Roboto Slab', 'Autoroboto']);
    expect((await c.search({ q: '' })).families.map((x) => x.family)).toEqual(['Roboto', 'Open Sans', 'Roboto Slab', 'Zilla', 'Autoroboto']);
    expect((await c.search({ category: 'serif' })).families.map((x) => x.family)).toEqual(['Roboto Slab', 'Zilla']);
    expect((await c.search({ limit: 2 })).families).toHaveLength(2);
    expect(Object.keys((await c.search({ q: 'zilla' })).families[0]!).sort()).toEqual(['category', 'family', 'italic', 'variable', 'weights']);
  });
});

describe('preview', () => {
  it('downloads one woff2 subset, caches it by family and weight', async () => {
    const f = fake();
    const c = make(f);
    const a = await c.preview('Open Sans', 700);
    expect(a.subarray(0, 4).toString()).toBe('wOF2');
    const css = f.urls.find((u) => u.includes('css2'))!;
    expect(css).toContain('family=Open+Sans:wght@700');
    expect(decodeURIComponent(css)).toContain('text=AaBbGg 0123 Open Sans');
    await c.preview('Open Sans', 700);
    await c.preview('Open Sans', 400);
    expect(f.urls.filter((u) => u.includes('css2'))).toHaveLength(2);
    expect((await readdir(join(dir, 'cache', 'font-previews'))).sort()).toEqual(['open-sans-400.woff2', 'open-sans-700.woff2']);
  });
  it('refuses odd names and weights, maps unknown families and oversize files', async () => {
    const f = fake();
    const c = make(f);
    expect((await c.preview('../x', 400).catch((e) => e)).status).toBe(400);
    expect((await c.preview('Roboto', 450).catch((e) => e)).status).toBe(400);
    expect((await c.preview('Nope', 400).catch((e) => e)).status).toBe(404);
    const big = make({ ...f, fetch: (async (u: string) => (u.includes('gstatic') ? new Response(new Uint8Array(200 * 1024 + 1), { status: 200 }) : f.fetch(u))) as unknown as typeof fetch } as Fake);
    expect((await big.preview('Roboto', 400).catch((e) => e)).status).toBe(413);
    expect(await readdir(join(dir, 'cache', 'font-previews')).catch(() => [])).toEqual([]);
  });
  it('keeps at most 300 files and drops the least recently used first', async () => {
    const f = fake();
    let t = 1_700_000_000_000;
    const c = make(f, () => (t += 1000));
    const pdir = join(dir, 'cache', 'font-previews');
    await mkdir(pdir, { recursive: true });
    for (let i = 0; i < PREVIEW_CACHE_MAX; i++) await writeFile(join(pdir, `f${String(i).padStart(3, '0')}-400.woff2`), 'x');
    const { utimes } = await import('node:fs/promises');
    for (let i = 0; i < PREVIEW_CACHE_MAX; i++) await utimes(join(pdir, `f${String(i).padStart(3, '0')}-400.woff2`), new Date(1_600_000_000_000 + i * 1000), new Date(1_600_000_000_000 + i * 1000));
    await c.preview('New Font', 400);
    const names = await readdir(pdir);
    expect(names).toHaveLength(PREVIEW_CACHE_MAX);
    expect(names).toContain('new-font-400.woff2');
    expect(names).not.toContain('f000-400.woff2');
    expect(names).toContain('f001-400.woff2');
  });
});
