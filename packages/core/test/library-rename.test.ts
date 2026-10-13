import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = (assets: string[]) => ({ goal: 'g', message: '', formats: ['16x9'], durationSec: null, assets, notes: '' });

describe('renaming an asset (store)', () => {
  let project: string;
  let lib: LibraryStore;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ms-ren è '));
    await mkdir(join(project, 'assets', 'brand'), { recursive: true });
    await mkdir(join(project, 'brand'), { recursive: true });
    lib = new LibraryStore(project, { ...NoMediaTools, available: true });
    await writeFile(join(project, 'assets', 'logo.png'), 'x');
    await writeFile(join(project, 'assets', 'other.png'), 'y');
    await writeFile(join(project, 'assets', 'brand', 'mark.svg'), '<svg/>');
    await writeFile(join(project, 'assets', 'font.woff2'), 'f');
    await lib.registerAssets([{ file: 'logo.png', origin: 'upload' }, { file: 'other.png', origin: 'upload' }, { file: 'brand/mark.svg', origin: 'upload' }, { file: 'font.woff2', origin: 'upload' }]);
  });

  it('renames, updates the brand and every brief under their locks, and leaves staging copies alone', async () => {
    const src = { kind: 'manual' as const, ref: null };
    await new BrandStore(project).writeKit({
      schemaVersion: 1, colors: [], tone: null, dos: [], donts: [], photoStyle: null,
      logos: [{ id: 'l1', file: 'assets/logo.png', variant: 'primary', background: 'any', source: src }, { id: 'l2', file: 'assets/other.png', variant: 'mono', background: 'any', source: src }],
      fonts: [{ id: 'f1', family: 'Brand', role: 'heading', weights: [400], file: 'assets/font.woff2', source: src }],
    });
    const creatives = new CreativeStore(project);
    const a = await creatives.create({ title: 'A', brief: brief(['assets/logo.png', 'assets/other.png']) });
    const b = await creatives.create({ title: 'B', brief: brief([]) });
    const c = await creatives.create({ title: 'C', brief: brief(['assets/logo.png']) });
    const staged = join(project, '.studio', 'cache', 'editor-staging', 'x', 'tok', 'assets', 'lib', 'logo.png');
    await mkdir(join(staged, '..'), { recursive: true });
    await writeFile(staged, 'copy');

    const r = await lib.renameAsset('logo.png', 'New Logo.png');
    expect(r.entry.file).toBe('New-Logo.png');
    expect(r.brand).toBe(true);
    expect(r.creatives.sort()).toEqual([a.slug, c.slug].sort());
    expect((await lib.listAssets()).map((x) => x.file).sort()).toEqual(['New-Logo.png', 'brand/mark.svg', 'font.woff2', 'other.png']);
    expect(await readFile(join(project, 'assets', 'New-Logo.png'), 'utf8')).toBe('x');
    await expect(stat(join(project, 'assets', 'logo.png'))).rejects.toThrow();
    const kit = await new BrandStore(project).readKit();
    expect(kit.logos.map((l) => l.file)).toEqual(['assets/New-Logo.png', 'assets/other.png']);
    expect((await creatives.get(a.slug)).brief.assets).toEqual(['assets/New-Logo.png', 'assets/other.png']);
    expect((await creatives.get(b.slug)).brief.assets).toEqual([]);
    expect(await readFile(staged, 'utf8')).toBe('copy');

    const f = await lib.renameAsset('font.woff2', 'brand-font.woff2');
    expect(f.brand).toBe(true);
    expect((await new BrandStore(project).readKit()).fonts[0]!.file).toBe('assets/brand-font.woff2');
  });

  it('renames inside a subfolder and keeps the folder', async () => {
    expect((await lib.renameAsset('brand/mark.svg', 'icon.svg')).entry.file).toBe('brand/icon.svg');
    await stat(join(project, 'assets', 'brand', 'icon.svg'));
  });

  it('refuses a name that exists, in the registry or only on disk', async () => {
    await expect(lib.renameAsset('logo.png', 'other.png')).rejects.toMatchObject({ status: 409 });
    await writeFile(join(project, 'assets', 'loose.png'), 'z');
    await expect(lib.renameAsset('logo.png', 'loose.png')).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(project, 'assets', 'loose.png'), 'utf8')).toBe('z');
    expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
  });

  it('refuses another folder, traversal, reserved names, a changed type and an unknown asset', async () => {
    for (const name of ['sub/logo.png', '../logo.png', '..\\x.png', '', '   ']) await expect(lib.renameAsset('logo.png', name), name).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('logo.png', 'assets.json')).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('logo.png', 'ASSETS.JSON')).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('logo.png', 'logo.mp4')).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('nope.png', 'x.png')).rejects.toMatchObject({ status: 404 });
    expect((await lib.listAssets()).map((x) => x.file)).toContain('logo.png');
  });

  it('refuses a file or folder that is a link', async () => {
    await writeFile(join(project, 'outside.png'), 'o');
    await symlink(join(project, 'outside.png'), join(project, 'assets', 'link.png'));
    await symlink(join(project, 'assets', 'logo.png'), join(project, 'assets', 'dir-link.png'));
    // Registering a link is refused, so plant the entries by hand as an agent might.
    const meta = JSON.parse(await readFile(join(project, 'assets', 'assets.json'), 'utf8'));
    meta.assets.push({ ...meta.assets[0], file: 'link.png' });
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify(meta));
    await expect(lib.renameAsset('link.png', 'moved.png')).rejects.toMatchObject({ status: 400 });
    await expect(stat(join(project, 'assets', 'moved.png'))).rejects.toThrow();
    // A subfolder that is a link: the file inside is reachable only through it.
    await mkdir(join(project, 'elsewhere'));
    await writeFile(join(project, 'elsewhere', 'in.png'), 'i');
    await symlink(join(project, 'elsewhere'), join(project, 'assets', 'linked'));
    meta.assets.push({ ...meta.assets[0], file: 'linked/in.png' });
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify(meta));
    await expect(lib.renameAsset('linked/in.png', 'moved.png')).rejects.toMatchObject({ status: 400 });
    expect(await readFile(join(project, 'elsewhere', 'in.png'), 'utf8')).toBe('i');
  });

  it('undoes everything when a later step fails', async () => {
    const src = { kind: 'manual' as const, ref: null };
    await new BrandStore(project).writeKit({ schemaVersion: 1, colors: [], tone: null, dos: [], donts: [], photoStyle: null, fonts: [], logos: [{ id: 'l1', file: 'assets/logo.png', variant: 'primary', background: 'any', source: src }] });
    const creatives = new CreativeStore(project);
    const a = await creatives.create({ title: 'A', brief: brief(['assets/logo.png']) });
    // The assets.json write fails (invalid metadata): the file, the brand and the brief go back.
    const spy = vi.spyOn(LibraryStore.prototype as unknown as { writeAssets(a: unknown): Promise<void> }, 'writeAssets').mockRejectedValueOnce(new Error('disk full'));
    await expect(lib.renameAsset('logo.png', 'later.png')).rejects.toMatchObject({ status: 500 });
    spy.mockRestore();
    expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
    await expect(stat(join(project, 'assets', 'later.png'))).rejects.toThrow();
    expect((await new BrandStore(project).readKit()).logos[0]!.file).toBe('assets/logo.png');
    expect((await creatives.get(a.slug)).brief.assets).toEqual(['assets/logo.png']);
    expect((await lib.listAssets()).map((x) => x.file)).toContain('logo.png');
  });

  it('refuses when the brand kit is corrupt, before touching the file', async () => {
    await writeFile(join(project, 'brand', 'brand-kit.json'), '{bad');
    await expect(lib.renameAsset('logo.png', 'later.png')).rejects.toThrow();
    expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
  });
});

describe('renaming an asset (API)', () => {
  let app: FastifyInstance;
  let base: string;
  const P = '/api/projects/acme';
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ms-ren-api-'));
    app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  });
  afterEach(async () => { await app.close(); });

  it('PATCH { name } renames in one commit and answers the new entry; conflicts are 409', async () => {
    const dir = join(base, 'ws', 'acme');
    await writeFile(join(dir, 'assets', 'a.png'), 'a');
    await writeFile(join(dir, 'assets', 'b.png'), 'b');
    await app.inject({ method: 'POST', url: `${P}/assets/register`, payload: { files: ['a.png', 'b.png'] } });
    const count = async () => Number((await execCommand('git', ['-C', dir, 'rev-list', '--count', 'HEAD'])).stdout.trim());
    const before = await count();
    const r = await app.inject({ method: 'PATCH', url: `${P}/assets/item/a.png`, payload: { name: 'renamed.png', description: 'd' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ file: 'renamed.png', description: 'd' });
    expect((await app.inject(`${P}/files/assets/renamed.png`)).statusCode).toBe(200);
    expect((await app.inject(`${P}/files/assets/a.png`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `${P}/assets/item/renamed.png`, payload: { name: 'b.png' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `${P}/assets/item/renamed.png`, payload: { name: 'x/y.png' } })).statusCode).toBe(400);
    expect(await count()).toBe(before + 1);
    expect((await execCommand('git', ['-C', dir, 'log', '-1', '--format=%s'])).stdout.trim()).toMatch(/^(Rename asset a\.png to|Rinomina asset a\.png in) renamed\.png$/);
  });

  it('lists old assets with their metadata filled once', async () => {
    const dir = join(base, 'ws', 'acme');
    await writeFile(join(dir, 'assets', 'f.woff2'), 'font');
    await writeFile(join(dir, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [
      { file: 'f.woff2', kind: 'font', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-01-01T00:00:00.000Z', attribution: null },
    ] }));
    const l = (await app.inject(`${P}/assets`)).json();
    expect(l.assets[0]).toMatchObject({ bytes: 4, durationSec: null });
    expect(JSON.parse(await readFile(join(dir, 'assets', 'assets.json'), 'utf8')).assets[0].bytes).toBe(4);
  });

  it('GET waveform: 404 for an unknown asset, 422 for a non-audio asset', async () => {
    const dir = join(base, 'ws', 'acme');
    await writeFile(join(dir, 'assets', 'a.png'), 'a');
    await app.inject({ method: 'POST', url: `${P}/assets/register`, payload: { files: ['a.png'] } });
    expect((await app.inject(`${P}/assets/item/nope.wav/waveform`)).statusCode).toBe(404);
    expect((await app.inject(`${P}/assets/item/a.png/waveform`)).statusCode).toBe(422);
    expect((await app.inject(`${P}/assets/item/a.png`)).statusCode).toBe(404);
  });
});
