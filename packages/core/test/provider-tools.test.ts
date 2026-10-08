import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceSettingsSchema, type ServerMessage } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import type { BridgeContext } from '../src/bridge/bridge.ts';
import { availableTools, providerTools } from '../src/bridge/provider-tools.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

let projectDir: string;
let ctx: BridgeContext;
let messages: ServerMessage[];
let approvals: ApprovalBroker;
let controller: AbortController;
let sent: string[];
const png = Buffer.from('png-bytes');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
const fakeFetch = (async (url: string) => {
  sent.push(url);
  if (url.includes('/images/')) return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.openai.com/v1/audio/')) return new Response(new Uint8Array([7, 7]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'v1' }] }), { status: 200 });
  if (url.startsWith('https://api.elevenlabs.io/')) return new Response(new Uint8Array([8]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (url.startsWith('https://api.pexels.com/v1/search')) return new Response(JSON.stringify({ photos: [{ id: 5, width: 10, height: 10, url: 'https://www.pexels.com/photo/5/', photographer: 'Ada', src: { medium: 'https://images.pexels.com/m.jpg' } }] }), { status: 200 });
  if (url.startsWith('https://api.pexels.com/v1/photos/')) return new Response(JSON.stringify({ url: 'https://www.pexels.com/photo/5/', photographer: 'Ada', src: { original: 'https://images.pexels.com/o.jpg' } }), { status: 200 });
  if (url.startsWith('https://images.pexels.com/')) return new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  if (url.startsWith('https://fonts.googleapis.com/')) return new Response("@font-face { font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/a.ttf) format('truetype'); }", { status: 200 });
  return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'font/ttf' } });
}) as unknown as typeof fetch;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-pt è '));
  messages = [];
  sent = [];
  controller = new AbortController();
  approvals = new ApprovalBroker({ broadcast: () => {} });
  ctx = { jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', emit: () => {}, signal: controller.signal };
});
const tools = (settings = {}, env: Record<string, string> = { OPENAI_API_KEY: 'sk-test' }, fetchImpl: typeof fetch = fakeFetch) => providerTools({
  vault: new MemoryVault(env), approvals, media: NoMediaTools, fetch: fetchImpl, lookup: publicLookup, broadcast: (m) => messages.push(m),
  settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, ...settings }),
});
const status = (e: unknown) => (e as { status?: number }).status;

describe('generate_image', () => {
  it('asks for confirmation, saves and registers the image', async () => {
    const t = tools();
    const pending = t.generate_image!(ctx, { prompt: 'Banner blu', width: 300, height: 250, name: 'banner' });
    await new Promise((r) => setTimeout(r, 20));
    const [req] = approvals.pending();
    expect(req).toMatchObject({ kind: 'provider', toolName: 'provider:openai-images' });
    await approvals.decide(req!.id, 'once');
    const out = await pending as { file: string; width: number; height: number };
    expect(out).toMatchObject({ file: 'assets/generated/banner.png', width: 880, height: 736 });
    expect((await readFile(join(projectDir, out.file))).equals(png)).toBe(true);
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ file: 'generated/banner.png', origin: 'generated', description: 'Banner blu' });
    expect(messages).toContainEqual({ type: 'library', project: 'acme' });
  });
  it('skips the confirmation when disabled or always-allowed for the project', async () => {
    await new PermissionsStore(projectDir).add('provider:openai-images', 'x');
    await tools().generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await tools({ confirmPaidProviders: false }).generate_image!(ctx, { prompt: 'y', width: 1024, height: 1024 });
    expect(approvals.pending()).toEqual([]);
  });
  it('asks again when the stored rules cannot be read', async () => {
    await mkdir(join(projectDir, '.studio'), { recursive: true });
    await writeFile(join(projectDir, '.studio', 'permissions.json'), '{ not json');
    const pending = tools().generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await new Promise((r) => setTimeout(r, 20));
    expect(approvals.pending()).toHaveLength(1);
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect(await pending.catch(status)).toBe(403);
  });
  it('refuses when denied, without a key, for other job kinds and for outside references', async () => {
    const t = tools();
    const denied = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await new Promise((r) => setTimeout(r, 20));
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect(await denied.catch((e) => e.statusCode ?? e.status)).toBe(403);
    expect(await tools({}, {}).generate_image!(ctx, { prompt: 'x', width: 1, height: 1 }).catch((e) => e.message)).toBe('Configura la chiave OpenAI nelle Impostazioni di Motion Studio');
    expect(await tools().generate_image!({ ...ctx, kind: 'describe' }, { prompt: 'x', width: 1, height: 1 }).catch((e) => e.status)).toBe(403);
    expect(await tools({ confirmPaidProviders: false }).generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, references: ['../secret.png'] }).catch((e) => e.status)).toBe(400);
    expect(await stat(join(projectDir, 'assets', 'generated')).then((s) => s.isDirectory()).catch(() => false)).toBe(false);
  });
  it('refuses a symlinked reference without sending anything to the provider', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ms-out-'));
    await writeFile(join(outside, 'secret.png'), 'x');
    await mkdir(join(projectDir, 'assets'), { recursive: true });
    await symlink(join(outside, 'secret.png'), join(projectDir, 'assets', 'link.png'));
    const t = tools({ confirmPaidProviders: false });
    expect(await t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, references: ['assets/link.png'] }).catch(status)).toBe(400);
    expect(await t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, references: ['assets/missing.png'] }).catch(status)).toBe(400);
    expect(await t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, references: ['assets/a.txt'] }).catch(status)).toBe(400);
    expect(sent).toEqual([]);
    expect(await stat(join(projectDir, 'assets', 'generated')).then(() => true).catch(() => false)).toBe(false);
  });
  it('aborts a pending provider call when the job is cancelled, saving and registering nothing', async () => {
    const hanging = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const t = tools({ confirmPaidProviders: false }, { OPENAI_API_KEY: 'sk-test' }, hanging);
    const pending = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await pending.catch(status)).toBe(499);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([]);
    expect(await stat(join(projectDir, 'assets', 'generated')).then(() => true).catch(() => false)).toBe(false);
  });
});

describe('fonts_fetch', () => {
  it('downloads the font into assets/fonts without a key', async () => {
    const out = await tools({}, {}).fonts_fetch!(ctx, { family: 'Manrope', weights: [400] }) as { files: string[] };
    expect(out.files).toEqual(['assets/fonts/Manrope-400.ttf']);
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ kind: 'font', origin: 'website', sourceUrl: 'https://fonts.google.com/specimen/Manrope' });
  });
  it('is not available to describe jobs', async () => {
    expect(await tools({}, {}).fonts_fetch!({ ...ctx, kind: 'describe' }, { family: 'Manrope' }).catch(status)).toBe(403);
  });
});

describe('availableTools', () => {
  it('reports configured and missing providers', async () => {
    const lines = await availableTools(new MemoryVault({ OPENAI_API_KEY: 'k' }));
    expect(lines.find((l) => l.startsWith('- generate_image'))).toContain('(pronto)');
    expect(lines.find((l) => l.startsWith('- stock_search'))).toContain('non configurato');
  });
});

describe('cancellation before asking', () => {
  it('never creates an approval when the job is cancelled while settings are read', async () => {
    const t = providerTools({
      vault: new MemoryVault({ OPENAI_API_KEY: 'sk' }), approvals, media: NoMediaTools, fetch: fakeFetch, lookup: publicLookup, broadcast: () => {},
      settings: async () => { await new Promise((r) => setTimeout(r, 30)); return workspaceSettingsSchema.parse({ schemaVersion: 1 }); },
    });
    const pending = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const err = await pending.catch((e) => e) as { status: number; message: string };
    expect(err).toMatchObject({ status: 499, message: 'Il lavoro è stato annullato.' });
    expect(approvals.pending()).toEqual([]);
  });
  it('cancels a pending approval when the job is aborted', async () => {
    const pending = tools().generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await new Promise((r) => setTimeout(r, 20));
    expect(approvals.pending()).toHaveLength(1);
    controller.abort();
    expect(await pending.catch(status)).toBe(499);
    expect(approvals.pending()).toEqual([]);
  });
});

describe('argument validation before paying', () => {
  it('rejects bad enums, voices and providers without asking', async () => {
    const t = tools({}, { OPENAI_API_KEY: 'k', PEXELS_API_KEY: 'p' });
    const base = { prompt: 'x', width: 1024, height: 1024 };
    expect(await t.generate_image!(ctx, { ...base, quality: 'ultra' }).catch(status)).toBe(400);
    expect(await t.generate_image!(ctx, { ...base, background: 'red' }).catch(status)).toBe(400);
    expect(await t.tts!(ctx, { text: 'ciao', voice: '../x' }).catch(status)).toBe(400);
    expect(await t.tts!(ctx, { text: 'ciao', provider: 'nope' }).catch(status)).toBe(400);
    expect(await t.stock_search!(ctx, { query: 'q', provider: 'nope' }).catch((e) => e.message)).toBe('Provider non valido');
    expect(await t.stock_search!(ctx, { query: 'q', orientation: 'diagonal' }).catch(status)).toBe(400);
    expect(await t.stock_download!(ctx, { id: '5', provider: 'nope' }).catch(status)).toBe(400);
    expect(approvals.pending()).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('caps the total size of the references', async () => {
    await mkdir(join(projectDir, 'references'), { recursive: true });
    const big = Buffer.alloc(30 * 1024 * 1024);
    await writeFile(join(projectDir, 'references', 'a.png'), big);
    await writeFile(join(projectDir, 'references', 'b.png'), big);
    const err = await tools({ confirmPaidProviders: false }).generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, references: ['references/a.png', 'references/b.png'] }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: 'Riferimenti troppo grandi' });
    expect(sent).toEqual([]);
  });
});

describe('tts', () => {
  it('falls back to ElevenLabs and asks with the provider rule', async () => {
    const t = tools({}, { ELEVENLABS_API_KEY: 'e' });
    const pending = t.tts!(ctx, { text: 'Ciao mondo', name: 'voce' });
    await new Promise((r) => setTimeout(r, 20));
    expect(approvals.pending()[0]).toMatchObject({ kind: 'provider', toolName: 'provider:tts-elevenlabs' });
    await approvals.decide(approvals.pending()[0]!.id, 'once');
    expect(await pending).toEqual({ file: 'assets/audio/voce.mp3', provider: 'elevenlabs', voice: 'v1' });
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ file: 'audio/voce.mp3', origin: 'generated' });
  });
  it('prefers OpenAI when configured', async () => {
    const out = await tools({ confirmPaidProviders: false }, { OPENAI_API_KEY: 'k', ELEVENLABS_API_KEY: 'e' }).tts!(ctx, { text: 'Ciao' }) as { provider: string };
    expect(out.provider).toBe('openai');
  });
});

describe('stock', () => {
  it('searches and downloads with attribution', async () => {
    const t = tools({}, { PEXELS_API_KEY: 'p' });
    const found = await t.stock_search!(ctx, { query: 'mare' }) as { results: Array<{ id: string }> };
    expect(found.results[0]!.id).toBe('5');
    const out = await t.stock_download!(ctx, { id: '5' });
    expect(out).toEqual({ file: 'assets/stock/pexels-5.jpg', attribution: 'Foto di Ada su Pexels' });
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ origin: 'stock', attribution: 'Foto di Ada su Pexels', sourceUrl: 'https://www.pexels.com/photo/5/' });
  });
});

describe('registration failure', () => {
  it('removes the saved file and does not broadcast', async () => {
    await mkdir(join(projectDir, 'assets'), { recursive: true });
    await writeFile(join(projectDir, 'assets', 'assets.json'), '{ not json');
    const err = await tools({ confirmPaidProviders: false }).generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, name: 'gone' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await stat(join(projectDir, 'assets', 'generated', 'gone.png')).then(() => true).catch(() => false)).toBe(false);
    expect(messages).toEqual([]);
  });
});
