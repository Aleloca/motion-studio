import { mkdir, mkdtemp, readdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BridgeContext } from '../src/bridge/bridge.ts';
import { downloadTool } from '../src/bridge/download-tool.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import type { LookupFn } from '../src/providers/safe-fetch.ts';

let projectDir: string;
let ctx: BridgeContext;
let controller: AbortController;
let messages: ServerMessage[];
let sent: string[];
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const lookup: LookupFn = async (host) => [{ address: host === 'intranet.example' ? '10.0.0.1' : '93.184.216.34', family: 4 }];
const site = (handler?: (url: string) => Response) => (async (url: string) => {
  sent.push(url);
  return handler?.(url) ?? new Response(SVG, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
}) as unknown as typeof fetch;
const tool = (fetchImpl: typeof fetch = site()) => downloadTool({ media: NoMediaTools, fetch: fetchImpl, lookup, broadcast: (m) => messages.push(m) });
const status = (e: unknown) => (e as { status?: number }).status;
const listDir = (d: string) => readdir(join(projectDir, 'assets', d)).catch(() => [] as string[]);

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-dl è '));
  controller = new AbortController();
  messages = [];
  sent = [];
  ctx = { jobId: 'j1', kind: 'brand-analysis', projectSlug: 'acme', projectDir, creativeSlug: null, sandboxed: false, autoApproveAtStart: false, emit: () => {}, signal: controller.signal };
});

describe('download_file', () => {
  it('saves the file under assets/brand, registers it with its source and broadcasts', async () => {
    const out = await tool()(ctx, { url: 'https://acme.example/img/logo.svg', dest: 'assets/brand/logo.svg' });
    expect(out).toEqual({ file: 'assets/brand/logo.svg' });
    expect((await readFile(join(projectDir, 'assets', 'brand', 'logo.svg'))).equals(SVG)).toBe(true);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([
      expect.objectContaining({ file: 'brand/logo.svg', origin: 'website', sourceUrl: 'https://acme.example/img/logo.svg', description: '', tags: ['brand'] }),
    ]);
    expect(messages).toContainEqual({ type: 'library', project: 'acme' });
  });
  it('accepts http, saves fonts under assets/fonts and never overwrites an existing file', async () => {
    const t = tool();
    expect(await t(ctx, { url: 'http://acme.example/f/Inter.woff2', dest: 'assets/fonts/Inter.woff2' })).toEqual({ file: 'assets/fonts/Inter.woff2' });
    const again = await t(ctx, { url: 'http://acme.example/f/Inter.woff2', dest: 'assets/fonts/Inter.woff2' }) as { file: string };
    expect(again.file).not.toBe('assets/fonts/Inter.woff2');
    expect(again.file.startsWith('assets/fonts/Inter')).toBe(true);
    expect((await listDir('fonts')).sort()).toHaveLength(2);
    const assets = await new LibraryStore(projectDir, NoMediaTools).listAssets();
    expect(assets.map((a) => a.tags)).toEqual([['font'], ['font']]);
  });
  it.each([
    'assets/other/x.png', 'assets/brand/../x.png', 'assets/brand/.hidden.png', 'assets/.brand/x.png', 'assets/brand/x.exe', 'assets/brand/x',
    'assets/brand/sub/x.png', '/tmp/x.png', 'brand/x.png', '', 'assets/brand/', 'assets\\brand\\x.png',
  ])('refuses the destination %j with 400 before downloading', async (dest) => {
    expect(await tool()(ctx, { url: 'https://acme.example/x.png', dest }).catch(status)).toBe(400);
    expect(sent).toHaveLength(0);
  });
  it('refuses odd URLs with 400 before downloading', async () => {
    for (const url of [undefined, 42, '', 'not a url', 'ftp://acme.example/x.png', `https://acme.example/${'a'.repeat(2000)}.png`]) {
      expect(await tool()(ctx, { url, dest: 'assets/brand/x.png' }).catch(status)).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });
  it('is available only to brand analysis jobs', async () => {
    const e = await tool()({ ...ctx, kind: 'creative' }, { url: 'https://acme.example/x.png', dest: 'assets/brand/x.png' }).catch((x) => x) as Error;
    expect(e).toMatchObject({ status: 403, message: 'Strumento non disponibile in questo lavoro' });
    expect(sent).toHaveLength(0);
  });
  it('refuses private targets, oversized and empty bodies and upstream errors, leaving nothing behind', async () => {
    const huge = () => new Response(new ReadableStream({
      start(c) { const mb = new Uint8Array(1024 * 1024); for (let i = 0; i < 51; i++) c.enqueue(mb); c.close(); },
    }), { status: 200 });
    const cases: Array<[string, typeof fetch, number, string?]> = [
      ['https://intranet.example/logo.png', site(), 502, 'Indirizzo non consentito per il download'],
      ['https://127.0.0.1/logo.png', site(), 502, 'Indirizzo non consentito per il download'],
      ['https://acme.example/big.png', site(huge), 413],
      ['https://acme.example/empty.png', site(() => new Response(new Uint8Array(0), { status: 200 })), 502],
      ['https://acme.example/missing.png', site(() => new Response('no', { status: 404 })), 502],
      ['https://acme.example/locked.png', site(() => new Response('no', { status: 403 })), 502],
    ];
    for (const [url, f, code, message] of cases) {
      const e = await tool(f)(ctx, { url, dest: 'assets/brand/logo.png' }).catch((x) => x) as Error;
      expect(status(e)).toBe(code);
      if (message) expect(e.message).toBe(message);
    }
    expect(await listDir('brand')).toEqual([]);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([]);
    expect(messages).toEqual([]);
  });
  it('does not call a site that denies access a key problem', async () => {
    const e = await tool(site(() => new Response('no', { status: 401 })))(ctx, { url: 'https://acme.example/x.png', dest: 'assets/brand/x.png' }).catch((x) => x) as Error;
    expect(e.message).not.toContain('Chiave');
    expect(e.message).toContain('acme.example');
  });
  it('refuses a symlinked assets/brand folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ms-dl-out-'));
    await mkdir(join(projectDir, 'assets'), { recursive: true });
    await symlink(outside, join(projectDir, 'assets', 'brand'));
    expect(await tool()(ctx, { url: 'https://acme.example/logo.svg', dest: 'assets/brand/logo.svg' }).catch(status)).toBe(400);
    expect(await readdir(outside)).toEqual([]);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([]);
  });
  it('reports a cancelled job as cancelled and leaves nothing behind', async () => {
    const f = (async (_url: string, init: RequestInit = {}) => {
      controller.abort();
      if (init.signal?.aborted) throw new Error('aborted');
      return new Response(SVG, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await tool(f)(ctx, { url: 'https://acme.example/logo.svg', dest: 'assets/brand/logo.svg' }).catch(status)).toBe(499);
    expect(await listDir('brand')).toEqual([]);
  });
});
