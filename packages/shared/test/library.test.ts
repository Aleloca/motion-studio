import { describe, expect, it } from 'vitest';
import { assetEntrySchema, assetKindOf, assetsFileSchema, creativeFileSchema } from '../src/index.ts';

describe('assetKindOf', () => {
  it.each([['a.PNG', 'image'], ['b.svg', 'svg'], ['c.mp4', 'video'], ['d.woff2', 'font'], ['e.mp3', 'audio'], ['f.pdf', 'other']])('%s → %s', (f, k) => {
    expect(assetKindOf(f)).toBe(k);
  });
  it('resists prototype pollution attacks', () => {
    expect(assetKindOf('x.constructor')).toBe('other');
    expect(assetKindOf('x.__proto__')).toBe('other');
    expect(assetKindOf('x.toString')).toBe('other');
  });
});

describe('assetEntrySchema', () => {
  const a = { file: 'fonts/brand.woff2', kind: 'font', origin: 'website', sourceUrl: 'https://x.it/f.woff2', description: '', tags: [], width: null, height: null, addedAt: '2026-10-07T10:00:00.000Z' };
  it('accepts sub-folders and rejects traversal', () => {
    expect(assetEntrySchema.safeParse(a).success).toBe(true);
    expect(assetEntrySchema.safeParse({ ...a, file: '../brand/x' }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...a, file: 'a\\b' }).success).toBe(false);
  });
  it('rejects duplicate files in assets.json', () => {
    expect(assetsFileSchema.safeParse({ schemaVersion: 1, assets: [a, a] }).success).toBe(false);
  });
  it('accepts http(s) sourceUrl and rejects unsafe schemes', () => {
    expect(assetEntrySchema.safeParse(a).success).toBe(true);
    expect(assetEntrySchema.safeParse({ ...a, sourceUrl: 'http://x.it/f.woff2' }).success).toBe(true);
    expect(assetEntrySchema.safeParse({ ...a, sourceUrl: null }).success).toBe(true);
    expect(assetEntrySchema.safeParse({ ...a, sourceUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...a, sourceUrl: 'file:///etc/passwd' }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...a, sourceUrl: 'data:text/html,<script>alert(1)</script>' }).success).toBe(false);
  });
});

describe('creativeFileSchema', () => {
  it('defaults linkedCodebases to []', () => {
    const at = '2026-10-07T10:00:00.000Z';
    const c = creativeFileSchema.parse({ schemaVersion: 1, title: 'T', status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null,
      brief: { goal: 'g', message: '', formats: ['x'], durationSec: null, assets: [], notes: '' } });
    expect(c.linkedCodebases).toEqual([]);
  });
});
