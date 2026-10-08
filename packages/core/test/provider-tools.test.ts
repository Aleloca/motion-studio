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
const fakeFetch = (async (url: string) => {
  sent.push(url);
  if (url.includes('/images/')) return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  vault: new MemoryVault(env), approvals, media: NoMediaTools, fetch: fetchImpl, broadcast: (m) => messages.push(m),
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
    expect(await pending.catch(status)).toBe(502);
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
