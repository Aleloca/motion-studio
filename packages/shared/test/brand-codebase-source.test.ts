import { describe, expect, it } from 'vitest';
import { BRAND_KIT_LIMITS, assetEntrySchema, brandKitSchema, brandSourceSchema, brandSourcesFileSchema, messages, sourceRefSchema } from '../src/index.ts';

const base = { id: 'c1', kind: 'codebase', url: null, file: null, path: '/Users/me/app', addedAt: '2026-10-15T10:00:00.000Z', lastAnalyzedAt: null };
const codebase = (id: string) => ({ ...base, id });

describe('codebase brand sources', () => {
  it('accepts an absolute folder, with an optional note', () => {
    expect(brandSourceSchema.safeParse(base).success).toBe(true);
    expect(brandSourceSchema.safeParse({ ...base, note: 'web app' }).success).toBe(true);
    expect(brandSourceSchema.safeParse({ ...base, path: 'C:\\code\\app' }).success).toBe(true);
  });
  it('refuses a missing, relative or root path, `..`, and stray url/file', () => {
    const { path: _p, ...noPath } = base;
    expect(brandSourceSchema.safeParse(noPath).success).toBe(false);
    for (const path of ['app', './app', '~/app', '/', '///', 'C:\\', '/Users/me/../x']) {
      expect(brandSourceSchema.safeParse({ ...base, path }).success, path).toBe(false);
    }
    expect(brandSourceSchema.safeParse({ ...base, url: 'https://example.com' }).success).toBe(false);
    expect(brandSourceSchema.safeParse({ ...base, file: 'a.png' }).success).toBe(false);
  });
  it('a path or note on a non-codebase source is refused', () => {
    const site = { id: 's', kind: 'website', url: 'https://example.com', file: null, addedAt: base.addedAt, lastAnalyzedAt: null };
    expect(brandSourceSchema.safeParse(site).success).toBe(true);
    expect(brandSourceSchema.safeParse({ ...site, path: '/x' }).success).toBe(false);
  });
  it('allows up to 5 codebase sources per brand, any number of other kinds', () => {
    expect(BRAND_KIT_LIMITS.codebaseSources).toBe(5);
    const five = ['a', 'b', 'c', 'd', 'e'].map(codebase);
    expect(brandSourcesFileSchema.safeParse({ schemaVersion: 1, sources: five }).success).toBe(true);
    const six = brandSourcesFileSchema.safeParse({ schemaVersion: 1, sources: [...five, codebase('f')] });
    expect(six.success).toBe(false);
    expect(JSON.stringify(six.error?.issues)).toContain('issue.maxCodebaseSources');
    const site = { id: 's', kind: 'website', url: 'https://example.com', file: null, addedAt: base.addedAt, lastAnalyzedAt: null };
    expect(brandSourcesFileSchema.safeParse({ schemaVersion: 1, sources: [...five, site] }).success).toBe(true);
  });
  it('a source ref of kind codebase is a relative path', () => {
    expect(sourceRefSchema.safeParse({ kind: 'codebase', ref: 'src/assets/logo.svg' }).success).toBe(true);
    expect(sourceRefSchema.safeParse({ kind: 'codebase', ref: null }).success).toBe(false);
    expect(sourceRefSchema.safeParse({ kind: 'codebase', ref: '/etc/passwd' }).success).toBe(false);
    expect(sourceRefSchema.safeParse({ kind: 'codebase', ref: '../x' }).success).toBe(false);
  });
  it('every issue message has text in both languages', () => {
    for (const l of ['en', 'it'] as const) {
      const issues = messages(l).issues as Record<string, string>;
      for (const k of ['codebaseRefRequired', 'codebaseRefInvalid', 'codebaseSourcePath', 'codebaseSourcePathInvalid', 'codebaseSourceUrl', 'codebaseSourceFile', 'pathOnlyCodebase', 'maxCodebaseSources']) {
        expect(issues[k], `${l} ${k}`).toBeTruthy();
      }
    }
  });
  it('the asset origin accepts codebase', () => {
    const e = { file: 'assets/brand/logo.svg', kind: 'svg', origin: 'codebase', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: base.addedAt };
    expect(assetEntrySchema.safeParse(e).success).toBe(true);
  });
});

describe('compatibility: older stored files still parse', () => {
  it('an old brand kit and old brand sources', () => {
    const manual = { kind: 'manual', ref: null };
    const kit = { schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: manual }], fonts: [], logos: [] };
    expect(brandKitSchema.safeParse(kit).success).toBe(true);
    const old = { schemaVersion: 1, sources: [
      { id: 's', kind: 'website', url: 'https://example.com', file: null, addedAt: base.addedAt, lastAnalyzedAt: null },
      { id: 'i', kind: 'image', url: null, file: 'refs/a.png', addedAt: base.addedAt, lastAnalyzedAt: null },
    ] };
    expect(brandSourcesFileSchema.safeParse(old).success).toBe(true);
  });
});
