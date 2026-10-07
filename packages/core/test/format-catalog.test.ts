import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { findPreset, FormatCatalog } from '../src/formats/format-catalog.ts';

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

describe('findPreset', () => {
  it('finds by id', () => {
    expect(findPreset(DEFAULT_FORMATS, 'youtube-16x9')?.width).toBe(1920);
    expect(findPreset(DEFAULT_FORMATS, 'nope')).toBeUndefined();
  });
});
