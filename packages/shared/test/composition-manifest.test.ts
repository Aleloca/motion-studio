import { describe, expect, it } from 'vitest';
import { anyManifestSchema, manifestV2Schema, versionEntrySchema, outputFileInfoSchema } from '../src/index.ts';

const h = (c: string) => c.repeat(64);
const manifest = {
  schemaVersion: 2,
  compositions: [
    { format: 'instagram-reel-9x16', dir: 'compositions/instagram-reel-9x16', hash: h('a') },
    { format: 'tiktok-9x16', dir: 'compositions/instagram-reel-9x16', hash: h('a'), followsFormat: 'instagram-reel-9x16' },
  ],
  renders: [{ format: 'instagram-reel-9x16', file: 'instagram-reel-9x16.mp4', width: 1080, height: 1920, durationSec: 6, sha256: h('f'), renderedAt: '2026-10-10T10:00:00.000Z', fromComposition: h('a') }],
};

describe('manifest v2', () => {
  it('parses a v2 manifest, and v1 stays readable through anyManifestSchema', () => {
    expect(manifestV2Schema.parse(manifest)).toEqual(manifest);
    expect(anyManifestSchema.parse(manifest).schemaVersion).toBe(2);
    const v1 = { schemaVersion: 1, files: [{ format: 'x', file: 'x.mp4', width: 10, height: 10 }], tools: [] };
    expect(anyManifestSchema.parse(v1).schemaVersion).toBe(1);
  });
  it.each([
    ['a composition dir outside compositions/', (m: typeof manifest) => { m.compositions[0]!.dir = '../x'; }],
    ['a nested composition dir', (m: typeof manifest) => { m.compositions[0]!.dir = 'compositions/a/b'; }],
    ['a bad hash', (m: typeof manifest) => { m.compositions[0]!.hash = 'nope'; }],
    ['a render file with a path', (m: typeof manifest) => { m.renders[0]!.file = 'a/b.mp4'; }],
    ['a render without sha256', (m: typeof manifest) => { delete (m.renders[0] as Partial<(typeof m.renders)[0]>).sha256; }],
  ])('rejects %s', (_n, mutate) => {
    const m = structuredClone(manifest);
    mutate(m);
    expect(manifestV2Schema.safeParse(m).success).toBe(false);
  });
  it('version entries and outputs take the v2 fields, and old entries stay valid', () => {
    const base = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-10T10:00:00.000Z', request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null };
    expect(versionEntrySchema.safeParse(base).success).toBe(true);
    expect(versionEntrySchema.safeParse({ ...base, compositions: manifest.compositions }).success).toBe(true);
    const o = { format: 'x', file: 'x.mp4', width: 1, height: 1, durationSec: null, verified: true, preview: null };
    expect(outputFileInfoSchema.safeParse(o).success).toBe(true);
    expect(outputFileInfoSchema.safeParse({ ...o, fromComposition: h('a') }).success).toBe(true);
    expect(outputFileInfoSchema.safeParse({ ...o, fromComposition: 'x' }).success).toBe(false);
  });
});
