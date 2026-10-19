import { describe, expect, it } from 'vitest';
import { autoProjectIcon, EMPTY_BRAND_KIT, projectFileSchema, type AssetEntry, type BrandKit } from '../src/index.ts';

// Report 44: the project's icon, automatic from the brand and the library, or chosen.
const at = '2026-10-19T10:00:00.000Z';
const base = { schemaVersion: 1, name: 'Audin', description: '', createdAt: at, updatedAt: at, linkedCodebases: [] };
const asset = (file: string, o: Partial<AssetEntry> = {}): AssetEntry => ({
  file, kind: file.endsWith('.svg') ? 'svg' : 'image', origin: 'website', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: at, attribution: null, ...o,
});
const kit = (logos: BrandKit['logos']): BrandKit => ({ ...EMPTY_BRAND_KIT, logos });
const logo = (file: string, variant: BrandKit['logos'][number]['variant']) => ({ id: file, file, variant, background: 'any' as const, source: { kind: 'manual' as const, ref: null } });

describe('project icon', () => {
  it('the schema reads old files (automatic) and takes an asset or the initials', () => {
    expect(projectFileSchema.parse(base).icon).toBeUndefined();
    expect(projectFileSchema.parse({ ...base, icon: { asset: 'brand/icon.png' } }).icon).toEqual({ asset: 'brand/icon.png' });
    expect(projectFileSchema.parse({ ...base, icon: 'initials' }).icon).toBe('initials');
    expect(projectFileSchema.safeParse({ ...base, icon: { asset: '../x.png' } }).success).toBe(false);
    expect(projectFileSchema.safeParse({ ...base, icon: 'logo' }).success).toBe(false);
  });

  it('automatic: the brand\'s icon logo first, then an app icon or favicon of the library, then a square logo', () => {
    const lib = [asset('brand/wide-logo.png', { width: 600, height: 200 }), asset('brand/apple-touch-icon.png', { width: 180, height: 180 }), asset('brand/favicon-32.png', { width: 32, height: 32 }), asset('brand/mark.png', { width: 400, height: 400 })];
    expect(autoProjectIcon(kit([logo('assets/brand/wide-logo.png', 'primary'), logo('assets/brand/mark.png', 'icon')]), lib)).toBe('assets/brand/mark.png');
    // No icon logo: the largest app icon / favicon.
    expect(autoProjectIcon(kit([logo('assets/brand/wide-logo.png', 'primary')]), lib)).toBe('assets/brand/apple-touch-icon.png');
    // Neither: a square-ish logo of the kit; a wide one never.
    expect(autoProjectIcon(kit([logo('assets/brand/wide-logo.png', 'primary'), logo('assets/brand/mark.png', 'secondary')]), [lib[0]!, lib[3]!])).toBe('assets/brand/mark.png');
    expect(autoProjectIcon(kit([logo('assets/brand/wide-logo.png', 'primary')]), [lib[0]!])).toBeNull();
    expect(autoProjectIcon(EMPTY_BRAND_KIT, [])).toBeNull();
  });

  it('automatic: a wide app icon is not one, and fonts or videos never are', () => {
    expect(autoProjectIcon(EMPTY_BRAND_KIT, [asset('brand/app-icon-banner.png', { width: 1200, height: 300 }), asset('fonts/icon.woff2', { kind: 'font' })])).toBeNull();
    // An SVG favicon has no measured size: taken.
    expect(autoProjectIcon(EMPTY_BRAND_KIT, [asset('brand/favicon.svg')])).toBe('assets/brand/favicon.svg');
  });
});
