import { describe, expect, it } from 'vitest';
import { brandKitSchema, brandSourceSchema, EMPTY_BRAND_KIT } from '../src/index.ts';

const manual = { kind: 'manual', ref: null } as const;

describe('brandKitSchema', () => {
  it('fills defaults and normalizes hex to upper case', () => {
    expect(brandKitSchema.parse({ schemaVersion: 1 })).toEqual(EMPTY_BRAND_KIT);
    const kit = brandKitSchema.parse({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: manual }] });
    expect(kit.colors[0]!.hex).toBe('#1E3A5F');
  });
  it('rejects bad hex, duplicate ids and unsafe files', () => {
    const c = { id: 'a', name: 'A', hex: '#123456', role: 'other', source: manual };
    expect(brandKitSchema.safeParse({ schemaVersion: 1, colors: [{ ...c, hex: 'blue' }] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ schemaVersion: 1, colors: [c, c] }).success).toBe(false);
    const logo = { id: 'l', file: '../x.svg', variant: 'primary', background: 'any', source: manual };
    expect(brandKitSchema.safeParse({ schemaVersion: 1, logos: [logo] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ schemaVersion: 1, logos: [{ ...logo, file: '/etc/x' }] }).success).toBe(false);
  });
});

describe('brandSourceSchema', () => {
  it('accepts http(s) websites only', () => {
    const s = { id: 's1', kind: 'website', url: 'https://example.com', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null };
    expect(brandSourceSchema.safeParse(s).success).toBe(true);
    expect(brandSourceSchema.safeParse({ ...s, url: 'file:///etc/passwd' }).success).toBe(false);
    expect(brandSourceSchema.safeParse({ ...s, url: null }).success).toBe(false);
  });
});
