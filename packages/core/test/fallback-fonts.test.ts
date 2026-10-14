// @vitest-environment node
/**
 * Fallback fonts (Phase 12, Task 3, spec §3.4): the Noto Sans family of a non-Latin script, downloaded once per project
 * through the phase 11 Google Fonts add path (fake fetch only: the test network guard stays on), registered in the library
 * with origin `google-fonts`, added to the overlay's `fonts`; offline, a "fallback font unavailable" problem and the
 * overlay goes on.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type JobSummary } from '@motion-studio/shared';
import { currentLocale } from '../src/i18n.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { ensureFallbackFont, FallbackFontUnavailable } from '../src/localization/fallback-fonts.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { fetchTransport } from '../src/providers/safe-fetch.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let urls: string[];
let offline: boolean;
let gate: Promise<void> | null = null;
const fakeFetch = (async (url: string) => {
  urls.push(url);
  if (gate) await gate;
  if (offline) throw new TypeError('fetch failed');
  if (url.startsWith('https://fonts.googleapis.com/css2')) {
    const fam = decodeURIComponent(/family=([^:&]+)/.exec(url)![1]!).replace(/\+/g, ' ');
    const weights = /wght@([^&]+)/.exec(url)![1]!.split(';');
    return new Response(weights.map((w) => `@font-face { font-family: '${fam}'; font-style: normal; font-weight: ${w}; src: url(https://fonts.gstatic.com/s/${fam.replace(/ /g, '')}-${w}.ttf) format('truetype'); }`).join('\n'), { status: 200 });
  }
  if (url.startsWith('https://fonts.gstatic.com/')) return new Response(new Uint8Array([0, 1, 0, 0, 7]), { status: 200 });
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;
const http = () => ({ fetch: fakeFetch, transport: fetchTransport(fakeFetch), lookup: async () => [{ address: '142.250.180.3', family: 4 }] }) as never;
beforeEach(() => { urls = []; offline = false; gate = null; });

describe('ensureFallbackFont', () => {
  let projectDir: string;
  beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'ms-test-fallback-')); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });
  const project = () => ({ projectDir, http: http(), media: NoMediaTools });

  it('none for Latin, Cyrillic and Greek scripts (no request)', async () => {
    for (const l of ['de', 'ru', 'el', 'vi'] as const) expect(await ensureFallbackFont(project(), l, new AbortController().signal)).toBeNull();
    expect(urls).toEqual([]);
  });

  it('downloads the Noto family once per project and registers it with origin google-fonts', async () => {
    const a = await ensureFallbackFont(project(), 'ja', new AbortController().signal);
    // `installed`: the core wrote it now (fix round 1, M2: only such a font is the core's own write in a turn).
    expect(a).toEqual({ family: 'Noto Sans JP', files: ['assets/fonts/NotoSansJP-400.ttf', 'assets/fonts/NotoSansJP-700.ttf'], installed: true });
    for (const f of a!.files) expect(existsSync(join(projectDir, f))).toBe(true);
    const lib = await new LibraryStore(projectDir, NoMediaTools).listAssets();
    expect(lib.map((e) => [e.file, e.origin])).toEqual([['fonts/NotoSansJP-400.ttf', 'google-fonts'], ['fonts/NotoSansJP-700.ttf', 'google-fonts']]);
    const fetched = urls.length;
    expect(fetched).toBe(3);
    // Again, and twice at once: no new request.
    const [b, c] = await Promise.all([ensureFallbackFont(project(), 'ja', new AbortController().signal), ensureFallbackFont(project(), 'ja', new AbortController().signal)]);
    // Found in the library: not written now.
    expect(b).toEqual({ family: a!.family, files: a!.files });
    expect(c).toEqual({ family: a!.family, files: a!.files });
    expect(urls).toHaveLength(fetched);
    // Another script is another family.
    expect((await ensureFallbackFont(project(), 'ko', new AbortController().signal))!.family).toBe('Noto Sans KR');
  });

  it('offline: FallbackFontUnavailable, nothing left in the project', async () => {
    offline = true;
    await expect(ensureFallbackFont(project(), 'th', new AbortController().signal)).rejects.toBeInstanceOf(FallbackFontUnavailable);
    expect(existsSync(join(projectDir, 'assets', 'fonts'))).toBe(false);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([]);
  });
});

describe('fallback fonts in the overlays', { timeout: 120_000 }, () => {
  let env: InstanceEnv;
  beforeEach(async () => { env = await startInstanceEnv('ms-test-fallback-int-', { fontsHttp: http() }); });
  afterEach(async () => { await env?.close(); });
  const put = (slug: string, inst: string, payload: object) =>
    env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/ja/${inst}`, headers: H, payload });

  it('a Japanese overlay gets Noto Sans JP (downloaded once for the project) and the render uses it as a fallback', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {}, locales: { primary: 'en', extra: ['ja'] } });
    const r = await put(slug, 'test-wide', { texts: { title: 'こんにちは' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().problems).toEqual([]);
    expect(r.json().overlay.fonts).toEqual([{ family: 'Noto Sans JP', files: ['assets/fonts/NotoSansJP-400.ttf', 'assets/fonts/NotoSansJP-700.ttf'] }]);
    const fetched = urls.length;
    expect((await put(slug, 'test-tall', { texts: { title: 'こんにちは' } })).json().overlay.fonts).toHaveLength(1);
    expect(urls).toHaveLength(fetched);
    const job = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: ['test-wide'], locales: ['ja'] } });
    expect(job.statusCode, job.body).toBe(202);
    const done = await env.waitJob((job.json() as JobSummary).id);
    expect(done.state, done.error).toBe('succeeded');
    const c = env.fake.renders.at(-1)!.composition;
    expect(c.fontFallbacks).toEqual(['Noto Sans JP']);
    expect(c.fonts.filter((f) => f.family === 'Noto Sans JP').map((f) => f.src)).toEqual(['assets/fonts/NotoSansJP-400.ttf', 'assets/fonts/NotoSansJP-700.ttf']);
  });

  it('the download happens before the creative lock: a duplicate is not held up by it', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['ja'] } });
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    const pending = put(slug, 'test-wide', { texts: { title: 'こんにちは' } });
    for (let i = 0; i < 200 && urls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(urls.length).toBeGreaterThan(0);
    const dup = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/duplicate-format`, headers: H, payload: { instanceId: 'test-wide' } });
    expect(dup.statusCode, dup.body).toBe(200);
    open();
    expect((await pending).statusCode).toBe(200);
  });

  it('offline: the overlay is stored with "fallback font unavailable"', async () => {
    offline = true;
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['ja'] } });
    const r = await put(slug, 'test-wide', { texts: { title: 'こんにちは' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ problems: [messages(currentLocale()).variants.fallbackFontUnavailable({ family: 'Noto Sans JP' })], overlay: { fonts: [] } });
  });
});
