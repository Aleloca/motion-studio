import { describe, expect, it } from 'vitest';
import { autoProjectIcon, projectIconCandidates, EMPTY_BRAND_KIT, projectFileSchema, projectIconSchema, type AssetEntry, type BrandKit } from '../src/index.ts';

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
    // Review 1: a bad icon never makes the project unreadable: it reads as automatic.
    expect(projectFileSchema.parse({ ...base, icon: { asset: '../x.png' } }).icon).toBeUndefined();
    expect(projectFileSchema.parse({ ...base, icon: 'logo' }).icon).toBeUndefined();
    expect(projectIconSchema.safeParse('logo').success).toBe(false);
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

  it('review 4: the candidates in order, only under assets/; an icon logo elsewhere does not hide the next rules', () => {
    const lib = [asset('brand/favicon.png', { width: 64, height: 64 }), asset('brand/mark.png', { width: 300, height: 300 })];
    const k = kit([logo('references/icon.png', 'icon'), logo('assets/brand/gone.png', 'icon'), logo('assets/brand/mark.png', 'secondary')]);
    expect(projectIconCandidates(k, lib)).toEqual(['assets/brand/gone.png', 'assets/brand/favicon.png', 'assets/brand/mark.png']);
    expect(autoProjectIcon(kit([logo('references/icon.png', 'icon')]), lib)).toBe('assets/brand/favicon.png');
  });

  it('automatic: a wide app icon is not one, and fonts or videos never are', () => {
    expect(autoProjectIcon(EMPTY_BRAND_KIT, [asset('brand/app-icon-banner.png', { width: 1200, height: 300 }), asset('fonts/icon.woff2', { kind: 'font' })])).toBeNull();
    // An SVG favicon has no measured size: taken.
    expect(autoProjectIcon(EMPTY_BRAND_KIT, [asset('brand/favicon.svg')])).toBe('assets/brand/favicon.svg');
  });
});
