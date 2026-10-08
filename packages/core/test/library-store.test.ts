import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';

const media: MediaTools = { ...NoMediaTools, available: true, probe: async (f) => (f.endsWith('.png') ? { width: 300, height: 250, durationSec: null } : null) };
let project: string;
let lib: LibraryStore;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'ms-lib è '));
  await mkdir(join(project, 'assets', 'fonts'), { recursive: true });
  await mkdir(join(project, 'references'), { recursive: true });
  lib = new LibraryStore(project, media);
});

describe('assets', () => {
  it('registers files with kind and probed size, upserting by file', async () => {
    await writeFile(join(project, 'assets', 'logo.png'), 'x');
    await writeFile(join(project, 'assets', 'fonts', 'brand.woff2'), 'x');
    const [logo, font] = await lib.registerAssets([
      { file: 'logo.png', origin: 'upload' },
      { file: 'fonts/brand.woff2', origin: 'website', sourceUrl: 'https://acme.example/f.woff2', description: 'Font titoli', tags: ['font'] },
    ]);
    expect(logo).toMatchObject({ file: 'logo.png', kind: 'image', origin: 'upload', width: 300, height: 250, description: '', tags: [] });
    expect(font).toMatchObject({ kind: 'font', width: null, sourceUrl: 'https://acme.example/f.woff2' });
    const again = await lib.registerAssets([{ file: 'logo.png', origin: 'upload' }]);
    expect(again[0]!.addedAt).toBe(logo!.addedAt);
    expect(await lib.listAssets()).toHaveLength(2);
  });
  it('refuses missing files, symlinks and traversal', async () => {
    expect((await lib.registerAssets([{ file: 'nope.png', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
    await symlink('/etc/hosts', join(project, 'assets', 'link.png'));
    expect((await lib.registerAssets([{ file: 'link.png', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
    expect((await lib.registerAssets([{ file: '../project.json', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
  });
  it('updates, lists unregistered files and removes', async () => {
    await writeFile(join(project, 'assets', 'a.png'), 'x');
    await writeFile(join(project, 'assets', 'b.svg'), 'x');
    await writeFile(join(project, 'assets', '.DS_Store'), 'x');
    await lib.registerAssets([{ file: 'a.png', origin: 'upload' }]);
    expect(await lib.unregisteredAssets()).toEqual(['b.svg']);
    expect(await lib.updateAsset('a.png', { description: 'Logo', tags: ['logo'] })).toMatchObject({ description: 'Logo', tags: ['logo'] });
    await lib.removeAsset('a.png');
    await expect(stat(join(project, 'assets', 'a.png'))).rejects.toBeTruthy();
    expect((await lib.removeAsset('a.png').catch((e) => e)).status).toBe(404);
  });
  it('reports a corrupt assets.json without rewriting it', async () => {
    await writeFile(join(project, 'assets', 'assets.json'), '{"schemaVersion":1,"assets":[{}]}');
    await expect(lib.listAssets()).rejects.toMatchObject({ reason: 'schema' });
    await writeFile(join(project, 'assets', 'c.png'), 'x');
    await expect(lib.registerAssets([{ file: 'c.png', origin: 'upload' }])).rejects.toMatchObject({ reason: 'schema' });
    expect(await readFile(join(project, 'assets', 'assets.json'), 'utf8')).toBe('{"schemaVersion":1,"assets":[{}]}');
  });
  it('validates schema before writing: 2001-char description → 400, file unchanged', async () => {
    await writeFile(join(project, 'assets', 'd.png'), 'x');
    const longDesc = 'x'.repeat(2001);
    const err = await lib.registerAssets([{ file: 'd.png', origin: 'upload', description: longDesc }]).catch((e) => e);
    expect(err.status).toBe(400);
    // assets.json should not exist or be unchanged
    const existing = await readFile(join(project, 'assets', 'assets.json'), 'utf8').catch(() => null);
    expect(existing).toBe(null);
  });
  it('rejects metadata file names', async () => {
    expect((await lib.registerAssets([{ file: 'assets.json', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
  });
  it.skipIf(platform() === 'win32')('confines symlinked subdirectories', async () => {
    // Create a temp outside directory
    const tmpOutside = await mkdtemp(join(tmpdir(), 'ms-outside-'));
    await writeFile(join(tmpOutside, 'outside.png'), 'outside');
    // Symlink it into assets
    await symlink(tmpOutside, join(project, 'assets', 'linked'));
    // Try to register a file inside the symlinked dir → should fail (400)
    const err = await lib.registerAssets([{ file: 'linked/outside.png', origin: 'upload' }]).catch((e) => e);
    expect(err.status).toBe(400);
    // File outside should still exist (not touched)
    const content = await readFile(join(tmpOutside, 'outside.png'), 'utf8');
    expect(content).toBe('outside');
  });
  it.skipIf(platform() === 'win32')('does not delete files outside assets dir on remove', async () => {
    // Create a temp outside directory with a file
    const tmpOutside = await mkdtemp(join(tmpdir(), 'ms-asset-outside-'));
    await writeFile(join(tmpOutside, 'outside.png'), 'outside');
    // Symlink it into assets
    await symlink(tmpOutside, join(project, 'assets', 'linked'));

    // Pre-seed assets.json with an entry for linked/outside.png
    const assetsJsonPath = join(project, 'assets', 'assets.json');
    await writeFile(assetsJsonPath, JSON.stringify({
      schemaVersion: 1,
      assets: [{
        file: 'linked/outside.png',
        kind: 'image',
        origin: 'upload',
        sourceUrl: null,
        description: 'Outside file',
        tags: [],
        width: 100,
        height: 100,
        addedAt: new Date().toISOString(),
      }],
    }));

    // Remove the entry - should remove from metadata but NOT delete outside file
    await lib.removeAsset('linked/outside.png');

    // Entry should be gone from metadata
    const assets = await lib.listAssets();
    expect(assets).toEqual([]);

    // Outside file should still exist
    const content = await readFile(join(tmpOutside, 'outside.png'), 'utf8');
    expect(content).toBe('outside');
  });
});

describe('references', () => {
  it('registers, updates and removes', async () => {
    await writeFile(join(project, 'references', 'mood.jpg'), 'x');
    expect(await lib.registerReferences(['mood.jpg'])).toEqual([expect.objectContaining({ file: 'mood.jpg', note: '', useForBrand: true })]);
    expect(await lib.updateReference('mood.jpg', { note: 'Luce calda', useForBrand: false })).toMatchObject({ note: 'Luce calda', useForBrand: false });
    await lib.removeReference('mood.jpg');
    expect(await lib.listReferences()).toEqual([]);
  });
  it('rejects metadata file name references.json', async () => {
    expect((await lib.registerReferences(['references.json']).catch((e) => e)).status).toBe(400);
  });
  it.skipIf(platform() === 'win32')('does not delete files outside references dir on remove', async () => {
    // Create a temp outside directory with a file
    const tmpOutside = await mkdtemp(join(tmpdir(), 'ms-ref-outside-'));
    await writeFile(join(tmpOutside, 'outside.jpg'), 'outside');
    // Symlink it into references
    await symlink(tmpOutside, join(project, 'references', 'linked'));

    // Pre-seed references.json with an entry for linked/outside.jpg
    const refsJsonPath = join(project, 'references', 'references.json');
    await writeFile(refsJsonPath, JSON.stringify({
      schemaVersion: 1,
      references: [{
        file: 'linked/outside.jpg',
        note: 'Outside reference',
        useForBrand: false,
        addedAt: new Date().toISOString(),
      }],
    }));

    // Remove the entry - should remove from metadata but NOT delete outside file
    await lib.removeReference('linked/outside.jpg');

    // Entry should be gone from metadata
    const refs = await lib.listReferences();
    expect(refs).toEqual([]);

    // Outside file should still exist
    const content = await readFile(join(tmpOutside, 'outside.jpg'), 'utf8');
    expect(content).toBe('outside');
  });
});

describe('metadata writes stay in the project', () => {
  it('refuses to write assets.json or references.json through a symlinked library folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ms-lib-out-'));
    const at = new Date().toISOString();
    for (const kind of ['assets', 'references'] as const) {
      const target = join(outside, kind);
      await mkdir(target);
      await writeFile(join(target, 'a.png'), 'x');
      const meta = kind === 'assets'
        ? { schemaVersion: 1, assets: [{ file: 'a.png', kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: at }] }
        : { schemaVersion: 1, references: [{ file: 'a.png', note: '', useForBrand: true, addedAt: at }] };
      await writeFile(join(target, `${kind}.json`), JSON.stringify(meta));
      await rm(join(project, kind), { recursive: true });
      await symlink(target, join(project, kind));
    }
    const before = { a: await readFile(join(outside, 'assets', 'assets.json'), 'utf8'), r: await readFile(join(outside, 'references', 'references.json'), 'utf8') };
    await expect(lib.registerAssets([{ file: 'a.png', origin: 'upload' }])).rejects.toThrow(/fuori dal progetto/);
    await expect(lib.updateAsset('a.png', { description: 'x' })).rejects.toThrow(/fuori dal progetto/);
    await expect(lib.registerReferences(['a.png'])).rejects.toThrow(/fuori dal progetto/);
    await expect(lib.updateReference('a.png', { note: 'x' })).rejects.toThrow(/fuori dal progetto/);
    expect(await readFile(join(outside, 'assets', 'assets.json'), 'utf8')).toBe(before.a);
    expect(await readFile(join(outside, 'references', 'references.json'), 'utf8')).toBe(before.r);
    await rm(outside, { recursive: true, force: true });
  });
});
