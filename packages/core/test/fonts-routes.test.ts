import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { saveGeneratedFile } from '../src/providers/files.ts';
import { fetchTransport } from '../src/providers/safe-fetch.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'a'.repeat(64);
const P = '/api/projects/acme';
let app: FastifyInstance;
let base: string;
let urls: string[];
let failOn: number | null;
let saves: number;

const catalog = JSON.stringify({ familyMetadataList: [
  { family: 'Manrope', category: 'Sans Serif', fonts: { 400: {}, 700: {} }, axes: [{ tag: 'wght' }], popularity: 1 },
  { family: 'Lora', category: 'Serif', fonts: { 400: {}, '400i': {}, 700: {} }, popularity: 2 },
] });
const fakeFetch = (async (url: string) => {
  urls.push(url);
  if (url.startsWith('https://fonts.google.com/metadata/fonts')) return new Response(`)]}'\n${catalog}`, { status: 200 });
  if (url.startsWith('https://fonts.googleapis.com/css2')) {
    const fam = decodeURIComponent(/family=([^:&]+)/.exec(url)![1]!).replace(/\+/g, ' ');
    const preview = url.includes('text=');
    const axis = /family=[^:&]+:([^&]+)/.exec(url)![1]!;
    const faces = preview ? [{ i: 0, w: axis.slice(5) }] : axis.startsWith('ital,') ? axis.split('@')[1]!.split(';').map((x) => ({ i: Number(x.split(',')[0]), w: x.split(',')[1]! })) : axis.slice(5).split(';').map((w) => ({ i: 0, w }));
    return new Response(faces.map(({ i, w }) => `@font-face { font-family: '${fam}'; font-style: ${i ? 'italic' : 'normal'}; font-weight: ${w}; src: url(https://fonts.gstatic.com/s/${fam.replace(/ /g, '')}-${w}${i ? 'i' : ''}.${preview ? 'woff2' : 'ttf'}) format('x'); }`).join('\n'), { status: 200 });
  }
  if (url.startsWith('https://fonts.gstatic.com/')) return new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 9]), { status: 200 });
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;

async function boot(extra: Record<string, unknown> = {}) {
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'),
    git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    fontsHttp: { fetch: fakeFetch, transport: fetchTransport(fakeFetch), lookup: async () => [{ address: '142.250.180.3', family: 4 }] }, ...extra,
  });
  const h = { 'x-motion-studio-ui': TOKEN };
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') }, headers: h });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' }, headers: h });
  return h;
}
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'ms-fr-')); urls = []; failOn = null; saves = 0; });
afterEach(async () => { await app.close(); });

describe('Google Fonts routes', () => {
  it('searches the catalog through the core, with the token', async () => {
    const h = await boot();
    expect((await app.inject('/api/fonts/google?q=man')).statusCode).toBe(401);
    const r = (await app.inject({ url: '/api/fonts/google?q=man&limit=5', headers: h })).json();
    expect(r).toMatchObject({ stale: false, fallback: false, families: [{ family: 'Manrope', category: 'Sans Serif', weights: [400, 700], italic: false, variable: true }] });
    expect((await app.inject({ url: '/api/fonts/google?category=Serif', headers: h })).json().families.map((f: { family: string }) => f.family)).toEqual(['Lora']);
  });
  it('serves the preview only through the signed URL of the authenticated search', async () => {
    const h = await boot();
    const fams = (await app.inject({ url: '/api/fonts/google?q=man', headers: h })).json().families as Array<{ family: string; previewUrl: string }>;
    const url = fams[0]!.previewUrl;
    expect(url).toMatch(/^\/api\/fonts\/google\/preview\/400\/Manrope\?s=\d+\./);
    const r = await app.inject(url); // no header token: FontFace cannot send one
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('font/woff2');
    expect(r.headers['cache-control']).toContain('private');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('wOF2');
    await app.inject(url);
    expect(urls.filter((u) => u.includes('css2'))).toHaveLength(1);
  });
  it('refuses unsigned, tampered and other-family or other-weight previews with 403 and never reaches Google', async () => {
    const h = await boot();
    const [man, lora] = (await app.inject({ url: '/api/fonts/google', headers: h })).json().families as Array<{ family: string; previewUrl: string }>;
    const sig = new URL(man!.previewUrl, 'http://x').searchParams.get('s')!;
    const before = urls.length;
    for (const bad of [
      '/api/fonts/google/preview/400/Manrope',
      '/api/fonts/google/preview/400/Manrope?s=1.abc',
      `/api/fonts/google/preview/400/Lora?s=${sig}`,
      `/api/fonts/google/preview/700/Manrope?s=${sig}`,
      `/api/fonts/google/preview/400/Manrope?s=${new URL(lora!.previewUrl, 'http://x').searchParams.get('s')}`,
      '/api/fonts/google/preview?family=Manrope&weight=400',
    ]) expect([bad, (await app.inject(bad)).statusCode]).toEqual([bad, bad.includes('?family') ? 401 : 403]);
    expect(urls.length).toBe(before);
  });
  it('an expired preview URL is refused', async () => {
    await app.close();
    const h = await boot({ signedUrlTtlMs: 30 });
    const url = (await app.inject({ url: '/api/fonts/google?q=man', headers: h })).json().families[0].previewUrl;
    await new Promise((r) => setTimeout(r, 60));
    expect((await app.inject(url)).statusCode).toBe(403);
  });
  it('adds a family: files, library entries with origin google-fonts, brand font and a commit', async () => {
    const h = await boot();
    const r = await app.inject({ method: 'POST', url: `${P}/brand/fonts/google`, headers: h, payload: { family: 'Lora', weights: [400, 700], italic: true, role: 'heading' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.files.sort()).toEqual(['assets/fonts/Lora-400-italic.ttf', 'assets/fonts/Lora-400.ttf', 'assets/fonts/Lora-700-italic.ttf', 'assets/fonts/Lora-700.ttf']);
    expect(body.font).toMatchObject({ family: 'Lora', role: 'heading', weights: [400, 700], file: 'assets/fonts/Lora-400.ttf', source: { kind: 'manual', ref: null } });
    const kit = (await app.inject({ url: `${P}/brand`, headers: h })).json().kit;
    expect(kit.fonts).toEqual([body.font]);
    const assets = (await app.inject({ url: `${P}/assets`, headers: h })).json().assets;
    expect(assets).toHaveLength(4);
    expect(assets.every((a: { origin: string; bytes: number; attribution: string }) => a.origin === 'google-fonts' && a.bytes === 5 && a.attribution.startsWith('Google Fonts · '))).toBe(true);
  });
  it('adds under the brand lock: two adds at once and a kit save keep every font', async () => {
    const h = await boot();
    const add = (family: string) => app.inject({ method: 'POST', url: `${P}/brand/fonts/google`, headers: h, payload: { family, weights: [400], italic: false, role: 'body' } });
    const [a, b] = await Promise.all([add('Lora'), add('Manrope')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect((await app.inject({ url: `${P}/brand`, headers: h })).json().kit.fonts.map((f: { family: string }) => f.family).sort()).toEqual(['Lora', 'Manrope']);
    const again = await add('lora');
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ url: `${P}/brand`, headers: h })).json().kit.fonts).toHaveLength(2);
  });
  it('adding a family already in the kit merges the weights, keeps role, file and old files, and says updated', async () => {
    const h = await boot();
    const add = (weights: number[], role: string) => app.inject({ method: 'POST', url: `${P}/brand/fonts/google`, headers: h, payload: { family: 'Lora', weights, italic: false, role } });
    const first = (await add([400, 700], 'heading')).json();
    expect(first.updated).toBe(false);
    const second = (await add([700], 'accent')).json();
    expect(second.updated).toBe(true);
    expect(second.font).toMatchObject({ id: first.font.id, role: 'heading', weights: [400, 700], file: 'assets/fonts/Lora-400.ttf' });
    const only700 = (await add([300], 'body')).json();
    expect(only700.font.weights).toEqual([300, 400, 700]);
    const kit = (await app.inject({ url: `${P}/brand`, headers: h })).json().kit;
    expect(kit.fonts).toHaveLength(1);
    // the earlier files are kept (a repeated weight is saved again under a new name)
    const files = (await app.inject({ url: `${P}/assets`, headers: h })).json().assets.map((a: { file: string }) => a.file);
    expect(files).toEqual(expect.arrayContaining(['fonts/Lora-400.ttf', 'fonts/Lora-700.ttf', 'fonts/Lora-700-2.ttf', 'fonts/Lora-300.ttf']));
  });
  it('rejects bad bodies and unknown families without leaving files', async () => {
    const h = await boot();
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${P}/brand/fonts/google`, headers: h, payload });
    expect((await post({ family: 'Lora' })).statusCode).toBe(400);
    expect((await post({ family: 'Bad;Name', weights: [400], italic: false, role: 'body' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/projects/none/brand/fonts/google', headers: h, payload: { family: 'Lora', weights: [400], italic: false, role: 'body' } })).statusCode).toBe(404);
    expect((await app.inject({ url: `${P}/assets`, headers: h })).json().assets).toEqual([]);
  });
});

describe('Google Fonts add is all or nothing', () => {
  it('a failure on the second file leaves no font file, no library entry and no brand font', async () => {
    const h = await boot({ fontsInstallIo: { save: async (...a: Parameters<typeof saveGeneratedFile>) => { if (++saves === 2) throw new Error('disk full'); return saveGeneratedFile(...a); } } });
    const r = await app.inject({ method: 'POST', url: `${P}/brand/fonts/google`, headers: h, payload: { family: 'Lora', weights: [400, 700], italic: false, role: 'body' } });
    expect(r.statusCode).toBe(500);
    expect(saves).toBe(2);
    const ws = join(base, 'ws');
    const dirs = await readdir(ws);
    const projectDir = join(ws, dirs.find((d) => d.includes('acme')) ?? 'acme');
    expect(await readdir(join(projectDir, 'assets', 'fonts')).catch(() => [])).toEqual([]);
    expect((await app.inject({ url: `${P}/assets`, headers: h })).json().assets).toEqual([]);
    expect((await app.inject({ url: `${P}/brand`, headers: h })).json().kit.fonts).toEqual([]);
  });
  it('a corrupt brand kit refuses before anything is downloaded', async () => {
    const h = await boot();
    const projectDir = join(base, 'ws', (await readdir(join(base, 'ws'))).find((d) => d.includes('acme')) ?? 'acme');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), '{oops');
    const r = await app.inject({ method: 'POST', url: `${P}/brand/fonts/google`, headers: h, payload: { family: 'Lora', weights: [400], italic: false, role: 'body' } });
    expect(r.statusCode).toBe(422);
    expect(urls).toEqual([]);
    expect(await readFile(join(projectDir, 'brand', 'brand-kit.json'), 'utf8')).toBe('{oops');
  });
});
