import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { findPreset, FormatCatalog, LEGACY_DEFAULT_IDS } from '../src/formats/format-catalog.ts';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ms-fmt-')); });
const file = () => join(root, '.studio', 'presets', 'formats.json');

describe('FormatCatalog', () => {
  it('creates the file with the defaults when missing', async () => {
    const s = await new FormatCatalog(root).load();
    expect(s.error).toBeNull();
    expect(s.presets).toEqual(DEFAULT_FORMATS);
    expect(JSON.parse(await readFile(file(), 'utf8')).presets).toHaveLength(DEFAULT_FORMATS.length);
  });
  it('falls back to defaults on an invalid file without rewriting it', async () => {
    await mkdir(join(root, '.studio', 'presets'), { recursive: true });
    await writeFile(file(), '{"schemaVersion":1,"presets":[]}');
    const s = await new FormatCatalog(root).load();
    expect(s.presets).toEqual(DEFAULT_FORMATS);
    expect(s.error).toContain('formats.json');
    expect(await readFile(file(), 'utf8')).toBe('{"schemaVersion":1,"presets":[]}');
  });
  it('saves a valid custom catalog and rejects an invalid one with 400', async () => {
    const c = new FormatCatalog(root);
    const custom = [{ ...DEFAULT_FORMATS[0]!, id: 'custom-1x1', name: 'Custom' }];
    expect((await c.save(custom)).presets).toEqual(custom);
    expect((await c.load()).presets).toEqual(custom);
    const err = await c.save([]).catch((e) => e);
    expect(err.status).toBe(400);
  });
  it('resets to defaults', async () => {
    const c = new FormatCatalog(root);
    await c.save([DEFAULT_FORMATS[0]!]);
    expect((await c.resetToDefaults()).presets).toEqual(DEFAULT_FORMATS);
  });
});

describe('FormatCatalog: new default presets reach existing workspaces (ruling AK)', () => {
  const NEW_IDS = ['og-image-1200x630', 'identity-logo', 'identity-favicon', 'identity-app-icon'];
  const writeOld = async (presets: unknown[], extra: Record<string, unknown> = {}) => {
    await mkdir(join(root, '.studio', 'presets'), { recursive: true });
    await writeFile(file(), JSON.stringify({ schemaVersion: 1, presets, ...extra }));
  };
  const legacy = () => DEFAULT_FORMATS.filter((p) => LEGACY_DEFAULT_IDS.includes(p.id));

  it('the frozen legacy list is the pre-phase-14 defaults: every one still a default, none of the new ones', () => {
    expect(LEGACY_DEFAULT_IDS).toHaveLength(35);
    for (const id of LEGACY_DEFAULT_IDS) expect(DEFAULT_FORMATS.some((p) => p.id === id)).toBe(true);
    for (const id of NEW_IDS) expect(LEGACY_DEFAULT_IDS).not.toContain(id);
  });

  it('an old file without youtube-16x9 stays without it and gains the identity and OG presets', async () => {
    const custom = { ...DEFAULT_FORMATS[0]!, id: 'my-custom', name: 'Mine' };
    const old = [...legacy().filter((p) => p.id !== 'youtube-16x9'), custom];
    await writeOld(old);
    const s = await new FormatCatalog(root).load();
    expect(s.error).toBeNull();
    const ids = s.presets.map((p) => p.id);
    expect(ids).not.toContain('youtube-16x9');
    expect(ids).toContain('my-custom');
    for (const id of NEW_IDS) expect(ids).toContain(id);
    // Appended after the user's own list, in the defaults' order.
    expect(ids.slice(0, old.length)).toEqual(old.map((p) => p.id));
    const onDisk = JSON.parse(await readFile(file(), 'utf8'));
    expect(onDisk.presets.map((p: { id: string }) => p.id)).toEqual(ids);
    expect([...onDisk.seenDefaults].sort()).toEqual(DEFAULT_FORMATS.map((p) => p.id).sort());
  });

  it('a second load is a no-op: the file is not written again', async () => {
    await writeOld(legacy());
    const c = new FormatCatalog(root);
    await c.load();
    const before = await readFile(file(), 'utf8');
    const mtime = (await stat(file())).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const again = await c.load();
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect((await stat(file())).mtimeMs).toBe(mtime);
    expect(again.presets.map((p) => p.id)).toEqual(JSON.parse(before).presets.map((p: { id: string }) => p.id));
  });

  it('a new preset the user deleted after it was offered stays deleted', async () => {
    await writeOld(legacy());
    const c = new FormatCatalog(root);
    const first = await c.load();
    await c.save(first.presets.filter((p) => p.id !== 'identity-favicon'));
    const s = await c.load();
    expect(s.presets.map((p) => p.id)).not.toContain('identity-favicon');
    expect(s.presets.map((p) => p.id)).toContain('identity-logo');
    // Also when the file was written by hand with seenDefaults already listing it.
    await writeOld(legacy(), { seenDefaults: DEFAULT_FORMATS.map((p) => p.id) });
    expect((await c.load()).presets.map((p) => p.id)).toEqual(legacy().map((p) => p.id));
  });

  it('a file whose seenDefaults misses a default gets only that one, and seenDefaults catches up', async () => {
    await writeOld(legacy(), { seenDefaults: [...LEGACY_DEFAULT_IDS, 'og-image-1200x630', 'identity-logo', 'identity-favicon'] });
    const s = await new FormatCatalog(root).load();
    const ids = s.presets.map((p) => p.id);
    expect(ids).toContain('identity-app-icon');
    expect(ids).not.toContain('og-image-1200x630');
    expect(JSON.parse(await readFile(file(), 'utf8')).seenDefaults).toContain('identity-app-icon');
  });

  it('a corrupt file still falls back to the defaults without rewriting it', async () => {
    await mkdir(join(root, '.studio', 'presets'), { recursive: true });
    await writeFile(file(), '{not json');
    const s = await new FormatCatalog(root).load();
    expect(s.presets).toEqual(DEFAULT_FORMATS);
    expect(s.error).toContain('formats.json');
    expect(await readFile(file(), 'utf8')).toBe('{not json');
  });

  it('save and resetToDefaults write seenDefaults with every current default', async () => {
    const c = new FormatCatalog(root);
    await c.save([DEFAULT_FORMATS[0]!]);
    expect(JSON.parse(await readFile(file(), 'utf8')).seenDefaults).toEqual(DEFAULT_FORMATS.map((p) => p.id));
    expect((await c.load()).presets).toEqual([DEFAULT_FORMATS[0]]);
    await c.resetToDefaults();
    expect(JSON.parse(await readFile(file(), 'utf8')).seenDefaults).toEqual(DEFAULT_FORMATS.map((p) => p.id));
  });
});

describe('findPreset', () => {
  it('finds by id', () => {
    expect(findPreset(DEFAULT_FORMATS, 'youtube-16x9')?.width).toBe(1920);
    expect(findPreset(DEFAULT_FORMATS, 'nope')).toBeUndefined();
  });
});
