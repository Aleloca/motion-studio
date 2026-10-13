import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveServices, workspaceSettingsSchema, type BriefServices, type ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../src/i18n.ts';
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

// Waits until the tool has registered its approval request (no fixed sleep).
const waitForPending = () => vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
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
  ctx = { jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', sandboxed: false, autoApproveAtStart: false, emit: () => {}, signal: controller.signal };
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
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
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
    await waitForPending();
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect(await pending.catch(status)).toBe(403);
  });
  it('refuses when denied, without a key, for other job kinds and for outside references', async () => {
    const t = tools();
    const denied = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await waitForPending();
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
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ kind: 'font', origin: 'google-fonts', bytes: 1, attribution: expect.stringContaining('Google Fonts'), sourceUrl: 'https://fonts.google.com/specimen/Manrope' });
  });
  it('is not available to describe jobs', async () => {
    expect(await tools({}, {}).fonts_fetch!({ ...ctx, kind: 'describe' }, { family: 'Manrope' }).catch(status)).toBe(403);
  });
});

describe('inspect_site_fonts', () => {
  const siteFetch = (async (url: string) => {
    sent.push(url);
    if (url === 'https://acme.example/') return new Response('<link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="https://tracker.example/t.css">', { status: 200 });
    if (url === 'https://acme.example/s.css') return new Response('h1{font-family:"Acme Display"}', { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const brandCtx = (notes: string[]): BridgeContext => ({ ...ctx, kind: 'brand-analysis', creativeSlug: null, locale: 'en', addNotes: (l) => notes.push(...l) });
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('it'));

  it('lists the site fonts and adds its warnings to the proposal notes, in the job language', async () => {
    const notes: string[] = [];
    const out = await tools({}, {}, siteFetch).inspect_site_fonts!(brandCtx(notes), { url: 'https://acme.example/' }) as { fonts: Array<{ family: string; source: string }>; warnings: string[] };
    expect(out.fonts).toEqual([expect.objectContaining({ family: 'Acme Display', source: 'system', roles: ['heading'] })]);
    expect(out.warnings).toEqual(['tracker.example/t.css not read (stylesheet on another site)']);
    expect(notes).toEqual(out.warnings);
    expect(sent).toEqual(['https://acme.example/', 'https://acme.example/s.css']);
  });
  it.each(['creative', 'console', 'describe'] as const)('is not available to %s jobs and sends nothing', async (kind) => {
    expect(await tools({}, {}, siteFetch).inspect_site_fonts!({ ...ctx, kind }, { url: 'https://acme.example/' }).catch(status)).toBe(403);
    expect(sent).toEqual([]);
  });
  it.each([undefined, 42, 'file:///etc/passwd', 'javascript:alert(1)', 'acme.example', `https://acme.example/${'a'.repeat(2000)}`])('refuses the url %j with 400', async (url) => {
    expect(await tools({}, {}, siteFetch).inspect_site_fonts!(brandCtx([]), { url }).catch(status)).toBe(400);
    expect(sent).toEqual([]);
  });
  it('allows at most 5 inspections per job', async () => {
    const t = tools({}, {}, siteFetch);
    for (let i = 0; i < 5; i++) await t.inspect_site_fonts!(brandCtx([]), { url: 'https://acme.example/' });
    const before = sent.length;
    const e = await t.inspect_site_fonts!(brandCtx([]), { url: 'https://acme.example/' }).catch((x) => x);
    expect(e).toMatchObject({ status: 429, message: 'inspect_site_fonts can be used at most 5 times per analysis' });
    expect(sent).toHaveLength(before);
    // Another job has its own count.
    const other = { ...brandCtx([]), jobId: 'j2', signal: new AbortController().signal };
    await expect(t.inspect_site_fonts!(other, { url: 'https://acme.example/' })).resolves.toBeTruthy();
  });
  it('reports a cancelled job as cancelled', async () => {
    const hang = (async (_u: string, init: RequestInit) => new Promise((_ok, fail) => init.signal?.addEventListener('abort', () => fail(new Error('aborted'))))) as unknown as typeof fetch;
    const pending = tools({}, {}, hang).inspect_site_fonts!(brandCtx([]), { url: 'https://acme.example/' });
    controller.abort();
    expect(await pending.catch(status)).toBe(499);
  });
});

describe('availableTools', () => {
  it('reports configured and missing providers', async () => {
    const lines = await availableTools(new MemoryVault({ OPENAI_API_KEY: 'k' }));
    expect(lines.find((l) => l.startsWith('- generate_image'))).toContain('(ready)');
    expect(lines.find((l) => l.startsWith('- stock_search'))).toContain('not configured');
  });
  it('says which tools the brief turns off (old briefs: all on)', async () => {
    const vault = new MemoryVault({ OPENAI_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', PEXELS_API_KEY: 'p' });
    const lines = await availableTools(vault, { images: 'stock', voice: 'none', music: 'none', sfx: 'auto' });
    expect(lines.find((l) => l.startsWith('- generate_image'))).toContain('(off for this creative: stock images only)');
    expect(lines.find((l) => l.startsWith('- tts'))).toContain('(off for this creative)');
    expect(lines.find((l) => l.startsWith('- list_voices'))).toContain('(off for this creative)');
    expect(lines.find((l) => l.startsWith('- stock_search'))).toContain('(ready)');
    expect(lines.find((l) => l.startsWith('- sound_effect'))).toContain('(ready)');
    expect(lines.find((l) => l.startsWith('- music'))).toContain('(off for this creative)');
    expect(await availableTools(vault, undefined)).toEqual(await availableTools(vault));
  });
});

describe('availableTools and what is known about the keys (F5)', () => {
  const line = (lines: string[], tool: string) => lines.find((l) => l.startsWith(`- ${tool}`))!;
  it('a capability checked missing is not ready: the prompt names the missing permission', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    cache.record('elevenlabs', 'tts', 'missing', 'text_to_speech');
    cache.record('elevenlabs', 'music', 'missing', 'music_generation');
    const vault = new MemoryVault({ ELEVENLABS_API_KEY: 'e' });
    const lines = await availableTools(vault, { voice: 'elevenlabs' }, cache);
    expect(line(lines, 'tts')).toContain('(missing permission: text_to_speech)');
    expect(line(lines, 'tts')).not.toContain('(ready)');
    expect(line(lines, 'music')).toContain('(missing permission: music_generation)');
    // Not known as missing: ready.
    expect(line(lines, 'sound_effect')).toContain('(ready)');
  });
  it('unverified and error stay available; a key the provider does not accept blocks every capability', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    cache.merge('openai', { provider: 'openai', checkedAt: '', capabilities: [{ capability: 'key', status: 'ok' }, { capability: 'images', status: 'unverified', permission: 'model.request' }, { capability: 'tts', status: 'error', detail: 'timeout' }] });
    const vault = new MemoryVault({ OPENAI_API_KEY: 'k' });
    let lines = await availableTools(vault, undefined, cache);
    expect(line(lines, 'generate_image')).toContain('(ready)');
    expect(line(lines, 'tts')).toContain('(ready)');
    cache.merge('openai', { provider: 'openai', checkedAt: '', capabilities: [{ capability: 'key', status: 'missing' }, { capability: 'images', status: 'missing' }, { capability: 'tts', status: 'missing' }] });
    lines = await availableTools(vault, undefined, cache);
    expect(line(lines, 'generate_image')).toContain('(missing permission: OpenAI does not accept the key)');
    expect(line(lines, 'tts')).toContain('(missing permission: OpenAI does not accept the key)');
  });
  it('auto voice is ready when either provider can speak; with neither, it lists what is missing', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    cache.record('openai', 'tts', 'missing', 'model.request');
    const vault = new MemoryVault({ OPENAI_API_KEY: 'k', ELEVENLABS_API_KEY: 'e' });
    expect(line(await availableTools(vault, { voice: 'auto' }, cache), 'tts')).toContain('(ready)');
    cache.record('elevenlabs', 'tts', 'missing', 'text_to_speech');
    expect(line(await availableTools(vault, { voice: 'auto' }, cache), 'tts')).toContain('(missing permission: model.request, text_to_speech)');
  });
  it('a forced voice provider without its key is never shown ready because the other provider has one (T7 minor)', async () => {
    const onlyEleven = new MemoryVault({ ELEVENLABS_API_KEY: 'e' });
    expect(line(await availableTools(onlyEleven, { voice: 'openai' }), 'tts')).toContain('(not configured: the OpenAI key is missing)');
    expect(line(await availableTools(onlyEleven, { voice: 'elevenlabs' }), 'tts')).toContain('(ready)');
    expect(line(await availableTools(new MemoryVault({ OPENAI_API_KEY: 'k' }), { voice: 'elevenlabs' }), 'tts')).toContain('(not configured: the ElevenLabs key is missing)');
    expect(line(await availableTools(onlyEleven, { voice: 'auto' }), 'tts')).toContain('(ready)');
  });
});

describe('cancellation before asking', () => {
  it('never creates an approval when the job is cancelled while settings are read', async () => {
    // The settings read is held open until the test has aborted the job, so the
    // ordering does not depend on timer precision under load.
    let readStarted!: () => void;
    const started = new Promise<void>((r) => { readStarted = r; });
    let releaseSettings!: () => void;
    const gate = new Promise<void>((r) => { releaseSettings = r; });
    const t = providerTools({
      vault: new MemoryVault({ OPENAI_API_KEY: 'sk' }), approvals, media: NoMediaTools, fetch: fakeFetch, lookup: publicLookup, broadcast: () => {},
      settings: async () => { readStarted(); await gate; return workspaceSettingsSchema.parse({ schemaVersion: 1 }); },
    });
    const pending = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await started;
    controller.abort();
    releaseSettings();
    const err = await pending.catch((e) => e) as { status: number; message: string };
    expect(err).toMatchObject({ status: 499, message: 'Il lavoro è stato annullato.' });
    expect(approvals.pending()).toEqual([]);
  });
  it('cancels a pending approval when the job is aborted', async () => {
    const pending = tools().generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
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
    await waitForPending();
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

describe('key checks from real calls (Task 8)', () => {
  it('generate_image, tts and stock record a 401/403 as missing and a success as ok, without the key', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    let deny: RegExp | null = null;
    const gate = (async (url: string, init?: RequestInit) => (deny && deny.test(url) ? new Response('denied sk-real-0123456789', { status: 403 }) : fakeFetch(url, init))) as unknown as typeof fetch;
    const t = providerTools({
      vault: new MemoryVault({ OPENAI_API_KEY: 'sk-real-0123456789', ELEVENLABS_API_KEY: 'xi-real-0123456789', PEXELS_API_KEY: 'px-real-0123456789' }), approvals, media: NoMediaTools, fetch: gate, lookup: publicLookup,
      broadcast: () => {}, keyChecks: cache, settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, confirmPaidProviders: false }),
    });
    deny = /images\/generations/;
    await t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 }).catch(() => {});
    expect(cache.capabilities('openai').images).toMatchObject({ status: 'missing', permission: 'model.request' });
    deny = /text-to-speech/;
    await t.tts!(ctx, { text: 'Ciao', provider: 'elevenlabs' }).catch(() => {});
    expect(cache.capabilities('elevenlabs').tts).toMatchObject({ status: 'missing', permission: 'text_to_speech' });
    deny = /api\.pexels\.com\/v1\/search/;
    await t.stock_search!(ctx, { query: 'mare' }).catch(() => {});
    expect(cache.capabilities('pexels').search).toMatchObject({ status: 'missing' });
    deny = null;
    // F5: a capability known as missing is unavailable, refused before any request, until the key is saved or tested again.
    const before = sent.length;
    await expect(t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 })).rejects.toMatchObject({ status: 400 });
    expect(sent.length).toBe(before);
    cache.clear('openai');
    cache.clear('pexels');
    await t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await t.tts!(ctx, { text: 'Ciao', provider: 'openai' });
    await t.stock_search!(ctx, { query: 'mare' });
    expect(cache.capabilities('openai')).toMatchObject({ key: { status: 'ok' }, images: { status: 'ok' }, tts: { status: 'ok' } });
    expect(cache.capabilities('pexels').search).toEqual({ capability: 'search', status: 'ok' });
    const all = JSON.stringify(['openai', 'elevenlabs', 'pexels'].map((p) => cache.get(p as 'openai')));
    for (const k of ['sk-real-0123456789', 'xi-real-0123456789', 'px-real-0123456789']) expect(all).not.toContain(k);
  });
});

describe('tts key checks with a text_to_speech-only ElevenLabs key (Task 8 fix I1)', () => {
  it('a refused default-voice lookup marks voices missing, never tts', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    const restricted = (async (url: string, init?: RequestInit) => (url.startsWith('https://api.elevenlabs.io/v2/voices')
      ? new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'missing the permission voices_read' } }), { status: 401 })
      : fakeFetch(url, init))) as unknown as typeof fetch;
    const t = providerTools({
      vault: new MemoryVault({ ELEVENLABS_API_KEY: 'xi-tts-only-0123456789' }), approvals, media: NoMediaTools, fetch: restricted, lookup: publicLookup,
      broadcast: () => {}, keyChecks: cache, settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, confirmPaidProviders: false }),
    });
    await expect(t.tts!(ctx, { text: 'Ciao', provider: 'elevenlabs' })).rejects.toBeTruthy();
    expect(cache.capabilities('elevenlabs').voices).toMatchObject({ status: 'missing', permission: 'voices_read' });
    expect(cache.capabilities('elevenlabs').tts).toBeUndefined();
    // With a voice given, speech works: tts is ok and voices keeps what it learned.
    await t.tts!(ctx, { text: 'Ciao', provider: 'elevenlabs', voice: 'v9' });
    expect(cache.capabilities('elevenlabs')).toMatchObject({ tts: { status: 'ok' }, voices: { status: 'missing' } });
  });
});

describe('ElevenLabs sound effects, music and voices', () => {
  const KEY = 'xi-secret-777';
  const seen: Array<{ url: string; body: string; key: string | undefined }> = [];
  let answer: (url: string) => Response;
  const audioFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: String(init.body ?? ''), key: (init.headers as Record<string, string> | undefined)?.['xi-api-key'] });
    return answer(url);
  }) as unknown as typeof fetch;
  const media = { ...NoMediaTools, available: true, probeAudio: async () => ({ durationSec: 4.2 }) };
  const withKey = (settings = {}, over: Partial<Parameters<typeof providerTools>[0]> = {}) => providerTools({
    vault: new MemoryVault({ ELEVENLABS_API_KEY: KEY }), approvals, media, fetch: audioFetch, lookup: publicLookup, broadcast: (m) => messages.push(m),
    settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, ...settings }), ...over,
  });
  beforeEach(() => { setLocale('en'); seen.length = 0; answer = () => new Response(new Uint8Array([5, 5]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }); });

  it('sound_effect asks (rule, prompt, duration, provider), saves in assets/audio and registers the fields', async () => {
    const t = withKey();
    const pending = t.sound_effect!(ctx, { prompt: 'door slam', durationSec: 2, loop: true, name: 'slam' });
    await waitForPending();
    const [req] = approvals.pending();
    expect(req).toMatchObject({ kind: 'provider', toolName: 'provider:sfx-elevenlabs' });
    expect(`${req!.title} ${req!.detail}`).toMatch(/door slam/);
    expect(`${req!.title} ${req!.detail}`).toMatch(/2/);
    expect(`${req!.title} ${req!.detail}`).toMatch(/ElevenLabs/);
    expect(seen).toHaveLength(0);
    await approvals.decide(req!.id, 'once');
    const out = await pending as { file: string };
    expect(out.file).toBe('assets/audio/slam.mp3');
    expect((await readFile(join(projectDir, out.file))).equals(Buffer.from([5, 5]))).toBe(true);
    expect((await new LibraryStore(projectDir, media).listAssets())[0]).toMatchObject({ file: 'audio/slam.mp3', origin: 'generated', description: 'door slam', provider: 'elevenlabs', model: 'eleven_text_to_sound_v2', durationSec: 4.2, loop: true, attribution: 'AI-generated (ElevenLabs)' });
    expect(seen[0]).toMatchObject({ key: KEY });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ text: 'door slam', duration_seconds: 2, loop: true });
    expect(JSON.stringify([out, messages])).not.toContain(KEY);
  });
  it('music uses its own rule; "always" skips later confirmations; deny sends nothing', async () => {
    const t = withKey();
    const denied = t.music!(ctx, { prompt: 'calm', durationSec: 20 }).catch((e) => e);
    await waitForPending();
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect(status(await denied)).toBe(403);
    expect(seen).toHaveLength(0);
    const p = t.music!(ctx, { prompt: 'calm', durationSec: 20, instrumental: true });
    await waitForPending();
    expect(approvals.pending()[0]).toMatchObject({ toolName: 'provider:music-elevenlabs' });
    await approvals.decide(approvals.pending()[0]!.id, 'always');
    const out = await p as { file: string };
    expect(await new PermissionsStore(projectDir).has('provider:music-elevenlabs')).toBe(true);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ prompt: 'calm', music_length_ms: 20000, force_instrumental: true });
    expect((await new LibraryStore(projectDir, media).listAssets()).find((a) => `assets/${a.file}` === out.file)).toMatchObject({ provider: 'elevenlabs', model: 'music_v1', durationSec: 4.2 });
    await t.music!(ctx, { prompt: 'again', durationSec: 15 });
    expect(approvals.pending()).toHaveLength(0);
  });
  it('validates limits before asking and refuses without a key or for other job kinds', async () => {
    const t = withKey();
    expect(status(await t.music!(ctx, { prompt: 'x', durationSec: 5 }).catch((e) => e))).toBe(400);
    expect(status(await t.sound_effect!(ctx, { prompt: 'x', durationSec: 31 }).catch((e) => e))).toBe(400);
    expect(status(await t.sound_effect!(ctx, { prompt: 'x'.repeat(1001) }).catch((e) => e))).toBe(400);
    expect(approvals.pending()).toHaveLength(0);
    expect(status(await t.sound_effect!({ ...ctx, kind: 'describe' }, { prompt: 'x' }).catch((e) => e))).toBe(403);
    const none = withKey({}, { vault: new MemoryVault({}) });
    expect(status(await none.sound_effect!(ctx, { prompt: 'x' }).catch((e) => e))).toBe(400);
    expect(seen).toHaveLength(0);
  });
  it('a 401 or 403 records the capability as missing with the permission, a 429 does not; no key leaks', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    const t = withKey({ confirmPaidProviders: false }, { keyChecks: cache });
    answer = () => new Response(`nope ${KEY}`, { status: 401 });
    const e1 = await t.sound_effect!(ctx, { prompt: 'x' }).catch((e) => e) as Error;
    answer = () => new Response('', { status: 403 });
    const e2 = await t.music!(ctx, { prompt: 'x', durationSec: 12 }).catch((e) => e) as Error;
    const e3 = await t.list_voices!(ctx, {}).catch((e) => e) as Error;
    expect(cache.capabilities('elevenlabs')).toMatchObject({ sfx: { status: 'missing', permission: 'sound_generation' }, music: { status: 'missing', permission: 'music_generation' }, voices: { status: 'missing', permission: 'voices_read' } });
    answer = () => new Response('', { status: 429 });
    const cache2 = new KeyCheckCache();
    const e4 = await withKey({ confirmPaidProviders: false }, { keyChecks: cache2 }).sound_effect!(ctx, { prompt: 'x' }).catch((e) => e) as Error;
    expect(status(e4)).toBe(429);
    expect(cache2.capabilities('elevenlabs')).toEqual({});
    for (const e of [e1, e2, e3, e4]) expect(e.message).not.toContain(KEY);
    expect(await readdirAssets()).toEqual([]);
  });
  it('aborts mid-request, saving and registering nothing', async () => {
    answer = () => { throw new Error('unused'); };
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('x'))))) as unknown as typeof fetch;
    const t = withKey({ confirmPaidProviders: false }, { fetch: hang });
    const p = t.sound_effect!(ctx, { prompt: 'x' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(status(await p)).toBe(499);
    expect(await new LibraryStore(projectDir, media).listAssets()).toEqual([]);
  });
  it('list_voices is free: no confirmation, returns the voices', async () => {
    answer = () => new Response(JSON.stringify({ voices: [{ voice_id: 'a1', name: 'Bella', labels: { gender: 'f' }, preview_url: null }] }), { status: 200 });
    const out = await withKey().list_voices!(ctx, { search: 'bel', limit: 5 }) as { voices: unknown[] };
    expect(approvals.pending()).toHaveLength(0);
    expect(out.voices).toEqual([{ id: 'a1', name: 'Bella', labels: { gender: 'f' }, previewUrl: null }]);
    expect(seen[0]!.url).toBe('https://api.elevenlabs.io/v2/voices?page_size=5&search=bel');
    expect(status(await withKey().list_voices!({ ...ctx, kind: 'brand-analysis' }, {}).catch((e) => e))).toBe(403);
  });
  it('tts defaults to the brand voice when none is passed, and an explicit voice wins', async () => {
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), JSON.stringify({ schemaVersion: 1, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'brandVoice1' } } }));
    const t = withKey({ confirmPaidProviders: false });
    expect(await t.tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'elevenlabs' });
    expect(seen.map((s) => s.url).join(' ')).toContain('/v1/text-to-speech/brandVoice1');
    seen.length = 0;
    await t.tts!(ctx, { text: 'Ciao', voice: 'other' });
    expect(seen[0]!.url).toContain('/v1/text-to-speech/other');
  });
  describe('tts brand voice (decision 346)', () => {
    const kit = (provider: string) => JSON.stringify({ schemaVersion: 1, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider, id: 'brandVoice1' } } });
    const setKit = async (text: string) => { await mkdir(join(projectDir, 'brand'), { recursive: true }); await writeFile(join(projectDir, 'brand', 'brand-kit.json'), text); };
    const both = () => providerTools({
      vault: new MemoryVault({ OPENAI_API_KEY: 'sk-o', ELEVENLABS_API_KEY: KEY }), approvals, media, fetch: audioFetch, lookup: publicLookup, broadcast: () => {},
      settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, confirmPaidProviders: false }),
    });
    const openaiVoice = () => JSON.parse(seen.find((x) => x.url.includes('api.openai.com'))!.body).voice;
    it('prefers the brand voice provider over OpenAI when both keys are set', async () => {
      await setKit(kit('elevenlabs'));
      expect(await both().tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'elevenlabs', voice: 'brandVoice1' });
      expect(seen.map((x) => x.url).join(' ')).toContain('/v1/text-to-speech/brandVoice1');
    });
    it('falls back to the default provider and voice when the brand voice provider has no key', async () => {
      await setKit(kit('elevenlabs'));
      const onlyOpenai = providerTools({
        vault: new MemoryVault({ OPENAI_API_KEY: 'sk-o' }), approvals, media, fetch: audioFetch, lookup: publicLookup, broadcast: () => {},
        settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, confirmPaidProviders: false }),
      });
      expect(await onlyOpenai.tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'openai', voice: 'marin' });
      expect(openaiVoice()).toBe('marin');
      expect(seen.map((x) => x.url).join(' ')).not.toContain('brandVoice1');
    });
    it('an explicit provider wins and uses its own default voice, not the brand one', async () => {
      await setKit(kit('elevenlabs'));
      expect(await both().tts!(ctx, { text: 'Ciao', provider: 'openai' })).toMatchObject({ provider: 'openai', voice: 'marin' });
      expect(openaiVoice()).toBe('marin');
      expect(seen.map((x) => x.url).join(' ')).not.toContain('brandVoice1');
    });
    it('an invalid or unreadable kit changes nothing: the usual default (OpenAI)', async () => {
      await setKit('{ not json');
      expect(await both().tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'openai', voice: 'marin' });
      await setKit(JSON.stringify({ schemaVersion: 1, sound: { voice: { provider: 'nope', id: 'x' } } }));
      expect(await both().tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'openai' });
      await rm(join(projectDir, 'brand', 'brand-kit.json'));
      await mkdir(join(projectDir, 'brand', 'brand-kit.json'));
      expect(await both().tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'openai' });
      expect(seen.map((x) => x.url).join(' ')).not.toContain('elevenlabs');
    });
  });
  it('availableTools lists the new tools', async () => {
    const lines = (await availableTools(new MemoryVault({ ELEVENLABS_API_KEY: 'k' }))).join('\n');
    expect(lines).toMatch(/sound_effect.*\(ready\)/);
    expect(lines).toMatch(/list_voices/);
    expect((await availableTools(new MemoryVault({}))).join('\n')).toMatch(/music.*not configured/);
  });
  afterEach(() => setLocale('it'));
  const readdirAssets = async () => (await new LibraryStore(projectDir, media).listAssets());
});

describe('brief services (Review Focus 2)', () => {
  const ALL_KEYS = { OPENAI_API_KEY: 'sk-test', ELEVENLABS_API_KEY: 'el-test', PEXELS_API_KEY: 'px-test', UNSPLASH_ACCESS_KEY: 'us-test' };
  const withServices = (services: BriefServices | undefined, over: Partial<BridgeContext> = {}): BridgeContext => ({ ...ctx, ...over, ...(services ? { services: effectiveServices({ services }) } : {}) });
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('it'));

  /** A refusal: the tool fails before any approval request and any network request. */
  const refused = async (run: Promise<unknown>) => {
    const asked = vi.spyOn(approvals, 'request');
    const e = await run.then(() => null, (x: unknown) => x) as { status: number; message: string } | null;
    expect(e).not.toBeNull();
    expect(asked).not.toHaveBeenCalled();
    expect(approvals.pending()).toEqual([]);
    expect(sent).toEqual([]);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([]);
    return e!;
  };
  const OFF = {
    Images: "Images are turned off in this creative's brief: tell the user they are off and that they can change this with the Services button",
    Voice: "Voice is turned off in this creative's brief: tell the user it is off and that they can change this with the Services button",
    Music: "Music is turned off in this creative's brief: tell the user it is off and that they can change this with the Services button",
    'Sound effects': "Sound effects are turned off in this creative's brief: tell the user they are off and that they can change this with the Services button",
  };

  it.each([
    ['tts', { voice: 'none' }, { text: 'Ciao', provider: 'openai' }, 'Voice'],
    ['tts', { voice: 'none' }, { text: 'Ciao' }, 'Voice'],
    ['list_voices', { voice: 'none' }, {}, 'Voice'],
    ['generate_image', { images: 'none' }, { prompt: 'x', width: 1024, height: 1024 }, 'Images'],
    ['stock_search', { images: 'none' }, { query: 'sea' }, 'Images'],
    ['stock_download', { images: 'none' }, { id: '5' }, 'Images'],
    ['music', { music: 'none' }, { prompt: 'calm piano', durationSec: 10 }, 'Music'],
    ['sound_effect', { sfx: 'none' }, { prompt: 'whoosh' }, 'Sound effects'],
  ] as const)('%s with %j is refused with the translated reason, without asking or paying', async (tool, services, args, service) => {
    const e = await refused(tools({}, ALL_KEYS)[tool]!(withServices(services), args));
    expect(e).toMatchObject({ status: 403, message: OFF[service] });
  });

  it('refuses in the language of the core (Italian)', async () => {
    setLocale('it');
    const e = await refused(tools({}, ALL_KEYS).tts!(withServices({ voice: 'none' }), { text: 'Ciao' }));
    expect(e.message).toBe("La voce è disattivata nel brief di questo creativo: dillo all'utente, che può cambiarlo con il pulsante Servizi");
  });

  it('refuses before checking the arguments: a forbidden call never reaches validation either', async () => {
    const e = await refused(tools({}, ALL_KEYS).tts!(withServices({ voice: 'none' }), {}));
    expect(e.status).toBe(403);
  });

  it('images "stock only": generate_image points to stock_search, the stock tools work', async () => {
    const e = await refused(tools({}, ALL_KEYS).generate_image!(withServices({ images: 'stock' }), { prompt: 'x', width: 1024, height: 1024 }));
    expect(e).toMatchObject({ status: 403, message: 'This creative uses stock images only: use stock_search and stock_download instead of generate_image' });
    const out = await tools({}, ALL_KEYS).stock_search!(withServices({ images: 'stock' }), { query: 'sea' }) as { results: unknown[] };
    expect(out.results).toHaveLength(1);
    // Stock is free: allowed under OpenAI too.
    await expect(tools({}, ALL_KEYS).stock_search!(withServices({ images: 'openai' }), { query: 'sea' })).resolves.toBeTruthy();
  });

  it('voice OpenAI: a tts call asking for ElevenLabs uses OpenAI and says so in the result', async () => {
    const bodies: string[] = [];
    const recording = (async (url: string, init?: RequestInit) => { bodies.push(String(init?.body ?? '')); return fakeFetch(url, init); }) as unknown as typeof fetch;
    const t = tools({}, ALL_KEYS, recording);
    const pending = t.tts!(withServices({ voice: 'openai' }), { text: 'Ciao', provider: 'elevenlabs', voice: 'JBFqnCBsd6RMkjVDRZzb' });
    await waitForPending();
    const [req] = approvals.pending();
    expect(req).toMatchObject({ toolName: 'provider:tts-openai' });
    await approvals.decide(req!.id, 'once');
    const out = await pending as { provider: string; note?: string };
    expect(out.provider).toBe('openai');
    expect(out.note).toBe("This creative's brief chooses OpenAI for voice: used instead of ElevenLabs The voice JBFqnCBsd6RMkjVDRZzb belongs to ElevenLabs and this voice-over uses OpenAI: it was not used, the OpenAI default voice was used instead");
    expect(sent.every((u) => u.startsWith('https://api.openai.com/'))).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    // The ElevenLabs voice id did not travel to OpenAI.
    expect(bodies.join('\n')).not.toContain('JBFqnCBsd6RMkjVDRZzb');
  });

  it('voice OpenAI without an OpenAI key: refused, never switched to ElevenLabs', async () => {
    const e = await refused(tools({}, { ELEVENLABS_API_KEY: 'el-test' }).tts!(withServices({ voice: 'openai' }), { text: 'Ciao', provider: 'elevenlabs' }));
    expect(e).toMatchObject({ status: 400, message: "This creative's brief chooses OpenAI for voice, but the OpenAI key is not set: add it in the Motion Studio settings, or the user can change the service with the Services button" });
  });

  it('voice ElevenLabs: a tts call without a provider uses ElevenLabs even when OpenAI is set', async () => {
    const out = await tools({ confirmPaidProviders: false }, ALL_KEYS).tts!(withServices({ voice: 'elevenlabs' }), { text: 'Ciao' }) as { provider: string; note?: string };
    expect(out.provider).toBe('elevenlabs');
    expect(out.note).toBeUndefined();
    expect(sent.every((u) => u.startsWith('https://api.elevenlabs.io/'))).toBe(true);
  });

  it('images OpenAI without a key, music and sound effects ElevenLabs without a key: refused before asking', async () => {
    expect((await refused(tools({}, { ELEVENLABS_API_KEY: 'el' }).generate_image!(withServices({ images: 'openai' }), { prompt: 'x', width: 1024, height: 1024 }))).status).toBe(400);
    expect((await refused(tools({}, { OPENAI_API_KEY: 'sk' }).music!(withServices({ music: 'elevenlabs' }), { prompt: 'calm', durationSec: 10 }))).status).toBe(400);
    expect((await refused(tools({}, { OPENAI_API_KEY: 'sk' }).sound_effect!(withServices({ sfx: 'elevenlabs' }), { prompt: 'whoosh' }))).status).toBe(400);
  });

  it('list_voices follows the voice choice: off under OpenAI (ElevenLabs is not this creative\'s voice), on under auto and ElevenLabs', async () => {
    expect((await refused(tools({}, ALL_KEYS).list_voices!(withServices({ voice: 'openai' }), {}))).status).toBe(403);
    await expect(tools({}, ALL_KEYS).list_voices!(withServices({ voice: 'elevenlabs' }), {})).resolves.toMatchObject({ voices: [expect.anything()] });
    await expect(tools({}, ALL_KEYS).list_voices!(withServices({ voice: 'auto' }), {})).resolves.toBeTruthy();
  });

  it('a context without services (old brief, console job) keeps today\'s behaviour', async () => {
    const out = await tools({ confirmPaidProviders: false }, ALL_KEYS).tts!(withServices(undefined), { text: 'Ciao', provider: 'elevenlabs' }) as { provider: string; note?: string };
    expect(out).toMatchObject({ provider: 'elevenlabs' });
    expect(out.note).toBeUndefined();
    await expect(tools({ confirmPaidProviders: false }, ALL_KEYS).generate_image!(withServices(undefined, { kind: 'console', creativeSlug: null }), { prompt: 'x', width: 1024, height: 1024 })).resolves.toBeTruthy();
  });

  it('auto keeps today\'s choice: the brand voice\'s provider when no provider is asked', async () => {
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    const { EMPTY_BRAND_KIT } = await import('@motion-studio/shared');
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), JSON.stringify({ ...EMPTY_BRAND_KIT, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'JBFqnCBsd6RMkjVDRZzb' } } }));
    const out = await tools({ confirmPaidProviders: false }, ALL_KEYS).tts!(withServices({ voice: 'auto' }), { text: 'Ciao' }) as { provider: string };
    expect(out.provider).toBe('elevenlabs');
  });

  it('the brand voice follows a chosen provider only when it is that provider\'s voice', async () => {
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    const { EMPTY_BRAND_KIT } = await import('@motion-studio/shared');
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), JSON.stringify({ ...EMPTY_BRAND_KIT, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'JBFqnCBsd6RMkjVDRZzb' } } }));
    const seenBodies: string[] = [];
    const recording = (async (url: string, init?: RequestInit) => { seenBodies.push(String(init?.body ?? '')); return fakeFetch(url, init); }) as unknown as typeof fetch;
    const out = await tools({ confirmPaidProviders: false }, ALL_KEYS, recording).tts!(withServices({ voice: 'openai' }), { text: 'Ciao' }) as { provider: string };
    expect(out.provider).toBe('openai');
    expect(seenBodies.join('\n')).not.toContain('JBFqnCBsd6RMkjVDRZzb');
  });
});

describe('tts: a voice of the other provider never reaches a provider nor costs a confirmation (final review I1, M3)', () => {
  const BOTH = { OPENAI_API_KEY: 'sk-test', ELEVENLABS_API_KEY: 'el-test' };
  const EL_ID = 'JBFqnCBsd6RMkjVDRZzb';
  const withServices = (services: BriefServices | undefined): BridgeContext => ({ ...ctx, ...(services ? { services: effectiveServices({ services }) } : {}) });
  let bodies: string[];
  const recording = (async (url: string, init?: RequestInit) => { bodies.push(`${url} ${String(init?.body ?? '')}`); return fakeFetch(url, init); }) as unknown as typeof fetch;
  const setBrandVoice = async (provider: string, id: string) => {
    const { EMPTY_BRAND_KIT } = await import('@motion-studio/shared');
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), JSON.stringify({ ...EMPTY_BRAND_KIT, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider, id } } }));
  };
  /** Runs a tts call that asks for confirmation; returns the rule asked and the result. */
  const confirmed = async (run: Promise<unknown>) => {
    await waitForPending();
    const [req] = approvals.pending();
    await approvals.decide(req!.id, 'once');
    return { rule: req!.toolName, out: await run as { provider: string; voice: string; note?: string } };
  };
  beforeEach(() => { setLocale('en'); bodies = []; });
  afterEach(() => setLocale('it'));

  it('auto, both keys, no provider: an ElevenLabs id goes to ElevenLabs (asked as ElevenLabs), never to OpenAI', async () => {
    const t = tools({}, BOTH, recording);
    const { rule, out } = await confirmed(t.tts!(withServices({ voice: 'auto' }), { text: 'Ciao', voice: EL_ID }));
    expect(rule).toBe('provider:tts-elevenlabs');
    expect(out).toMatchObject({ provider: 'elevenlabs', voice: EL_ID });
    expect(out.note).toBeUndefined();
    expect(sent.some((u) => u.includes(`/v1/text-to-speech/${EL_ID}`))).toBe(true);
    expect(sent.some((u) => u.startsWith('https://api.openai.com/'))).toBe(false);
  });
  it('the same with no services at all (old brief, console job)', async () => {
    const out = await tools({ confirmPaidProviders: false }, BOTH, recording).tts!(withServices(undefined), { text: 'Ciao', voice: EL_ID }) as { provider: string };
    expect(out.provider).toBe('elevenlabs');
    expect(sent.some((u) => u.startsWith('https://api.openai.com/'))).toBe(false);
  });
  it('auto, both keys, no provider: an OpenAI voice name goes to OpenAI', async () => {
    const t = tools({}, BOTH, recording);
    const { rule, out } = await confirmed(t.tts!(withServices({ voice: 'auto' }), { text: 'Ciao', voice: 'alloy' }));
    expect(rule).toBe('provider:tts-openai');
    expect(out).toMatchObject({ provider: 'openai', voice: 'alloy' });
    expect(sent.every((u) => u.startsWith('https://api.openai.com/'))).toBe(true);
  });
  it('auto, the provider asked does not own the voice: the voice is dropped with a note, before the confirmation', async () => {
    const t = tools({}, BOTH, recording);
    const { rule, out } = await confirmed(t.tts!(withServices({ voice: 'auto' }), { text: 'Ciao', provider: 'openai', voice: EL_ID }));
    expect(rule).toBe('provider:tts-openai');
    expect(out).toMatchObject({ provider: 'openai', voice: 'marin' });
    expect(out.note).toBe(`The voice ${EL_ID} belongs to ElevenLabs and this voice-over uses OpenAI: it was not used, the OpenAI default voice was used instead`);
    expect(bodies.join('\n')).not.toContain(EL_ID);
  });
  it('forced ElevenLabs, an OpenAI voice and no provider: dropped with a note, the brand\'s ElevenLabs voice used', async () => {
    await setBrandVoice('elevenlabs', 'brandVoice1');
    const t = tools({}, BOTH, recording);
    const { rule, out } = await confirmed(t.tts!(withServices({ voice: 'elevenlabs' }), { text: 'Ciao', voice: 'alloy' }));
    expect(rule).toBe('provider:tts-elevenlabs');
    expect(out).toMatchObject({ provider: 'elevenlabs', voice: 'brandVoice1' });
    expect(out.note).toBe("The voice alloy belongs to OpenAI and this voice-over uses ElevenLabs: it was not used, the brand's ElevenLabs voice was used instead");
    expect(sent.some((u) => u.startsWith('https://api.openai.com/'))).toBe(false);
  });
  it('forced OpenAI, an ElevenLabs id and no provider: dropped with a note only about the voice', async () => {
    const t = tools({}, BOTH, recording);
    const { rule, out } = await confirmed(t.tts!(withServices({ voice: 'openai' }), { text: 'Ciao', voice: EL_ID }));
    expect(rule).toBe('provider:tts-openai');
    expect(out.provider).toBe('openai');
    expect(out.note).toBe(`The voice ${EL_ID} belongs to ElevenLabs and this voice-over uses OpenAI: it was not used, the OpenAI default voice was used instead`);
    expect(bodies.join('\n')).not.toContain(EL_ID);
  });
  it('auto with only the OpenAI key: an ElevenLabs id is refused before any confirmation or request', async () => {
    const e = await tools({}, { OPENAI_API_KEY: 'sk-test' }, recording).tts!(withServices({ voice: 'auto' }), { text: 'Ciao', voice: EL_ID }).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ status: 400 });
    expect(approvals.pending()).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('M3: ElevenLabs with no voice and a key that cannot list voices is refused before the confirmation', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    const restricted = (async (url: string, init?: RequestInit) => (url.startsWith('https://api.elevenlabs.io/v2/voices')
      ? new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'missing the permission voices_read' } }), { status: 401 })
      : fakeFetch(url, init))) as unknown as typeof fetch;
    const t = providerTools({
      vault: new MemoryVault({ ELEVENLABS_API_KEY: 'xi-tts-only-0123456789' }), approvals, media: NoMediaTools, fetch: restricted, lookup: publicLookup,
      broadcast: () => {}, keyChecks: cache, settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1 }),
    });
    const created = vi.spyOn(approvals, 'request');
    await expect(t.tts!(ctx, { text: 'Ciao', provider: 'elevenlabs' })).rejects.toBeTruthy();
    expect(created).not.toHaveBeenCalled();
    expect(cache.capabilities('elevenlabs').voices).toMatchObject({ status: 'missing', permission: 'voices_read' });
  });
  it('M6: an agent image and voice-over register their provider and model', async () => {
    const t = tools({ confirmPaidProviders: false }, BOTH);
    const img = await t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 }) as { file: string };
    const tts = await t.tts!(ctx, { text: 'Ciao', provider: 'elevenlabs', voice: EL_ID }) as { file: string };
    const tts2 = await t.tts!(ctx, { text: 'Hello', voice: 'alloy' }) as { file: string };
    const assets = await new LibraryStore(projectDir, NoMediaTools).listAssets();
    const byFile = (f: string) => assets.find((a) => `assets/${a.file}` === f);
    expect(byFile(img.file)).toMatchObject({ provider: 'openai', model: 'gpt-image-2' });
    expect(byFile(tts.file)).toMatchObject({ provider: 'elevenlabs', model: 'eleven_multilingual_v2' });
    expect(byFile(tts2.file)).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini-tts' });
  });
});

describe('key checks follow only the current key (final review M2)', () => {
  it('a 401 that comes back after the key was replaced during the confirmation is not recorded', async () => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    const vault = new MemoryVault();
    await vault.set('openai', 'sk-old-0123456789');
    const denied = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const t = providerTools({
      vault, approvals, media: NoMediaTools, fetch: denied, lookup: publicLookup, broadcast: () => {}, keyChecks: cache,
      settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1 }),
    });
    const run = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 }).then(() => null, (e: unknown) => e);
    await waitForPending();
    // The user saves a new key while the approval waits (the settings route sets the key, then clears the cache).
    await vault.set('openai', 'sk-new-0123456789');
    cache.clear('openai');
    await approvals.decide(approvals.pending()[0]!.id, 'once');
    expect(await run).toBeTruthy();
    expect(cache.get('openai')).toBeNull();
  });
});

describe('F5 under auto: a provider known to lack the capability is skipped, none left is refused', () => {
  const BOTH = { OPENAI_API_KEY: 'sk-test', ELEVENLABS_API_KEY: 'el-test' };
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('it'));
  const withCache = async (record: (c: InstanceType<typeof import('../src/providers/key-check.ts').KeyCheckCache>) => void, settings = {}) => {
    const { KeyCheckCache } = await import('../src/providers/key-check.ts');
    const cache = new KeyCheckCache();
    record(cache);
    return providerTools({
      vault: new MemoryVault(BOTH), approvals, media: NoMediaTools, fetch: fakeFetch, lookup: publicLookup, broadcast: () => {}, keyChecks: cache,
      settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, ...settings }),
    });
  };
  it('tts with both keys: OpenAI lacks text-to-speech, so ElevenLabs is asked for and used', async () => {
    const t = await withCache((c) => c.record('openai', 'tts', 'missing', 'model.request'));
    const run = t.tts!(ctx, { text: 'Ciao' });
    await waitForPending();
    const [req] = approvals.pending();
    expect(req!.toolName).toBe('provider:tts-elevenlabs');
    await approvals.decide(req!.id, 'once');
    expect(await run).toMatchObject({ provider: 'elevenlabs' });
    expect(sent.some((u) => u.startsWith('https://api.openai.com/'))).toBe(false);
  });
  it('unverified and error stay usable', async () => {
    const t = await withCache((c) => c.merge('openai', { provider: 'openai', checkedAt: '', capabilities: [{ capability: 'key', status: 'ok' }, { capability: 'images', status: 'unverified' }, { capability: 'tts', status: 'error', detail: 'x' }] }), { confirmPaidProviders: false });
    expect(await t.tts!(ctx, { text: 'Ciao' })).toMatchObject({ provider: 'openai' });
    await expect(t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 })).resolves.toBeTruthy();
  });
  it('both lack it: refused with the reason before any confirmation or request', async () => {
    const t = await withCache((c) => { c.record('openai', 'tts', 'missing', 'model.request'); c.record('elevenlabs', 'tts', 'missing', 'text_to_speech'); });
    const e = await t.tts!(ctx, { text: 'Ciao' }).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ status: 400, message: 'The OpenAI key cannot be used for voice: it lacks the permission model.request. Tell the user to fix the key in the Motion Studio settings (then test it again), or to change the service with the Services button' });
    expect(approvals.pending()).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('list_voices looks at the voice list permission, not text-to-speech', async () => {
    const t = await withCache((c) => c.record('elevenlabs', 'tts', 'missing', 'text_to_speech'));
    await expect(t.list_voices!(ctx, {})).resolves.toMatchObject({ voices: [expect.anything()] });
    const t2 = await withCache((c) => c.record('elevenlabs', 'voices', 'missing', 'voices_read'));
    await expect(t2.list_voices!(ctx, {})).rejects.toMatchObject({ status: 400 });
  });
});
