import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, INSTANCE_ID_RE, briefSchema, storePackFormats, storePackSchema, type StorePack } from '../src/index.ts';

const shots = (n: number) => Array.from({ length: n }, (_, i) => ({ caption: `Cap ${i + 1}`, screen: i % 2 ? null : `assets/s${i}.png` }));
const apple: StorePack = { app: { name: 'Bread', tagline: 'Bake' }, stores: ['appstore'], devices: { appstore: ['iphone-69'] }, screenshots: shots(3), preview: false };
const brief = { goal: 'g', message: '', formats: ['appstore-iphone-69'], durationSec: null, assets: [], notes: '' };

describe('storePackSchema', () => {
  it('accepts the minimal packs', () => {
    expect(storePackSchema.safeParse(apple).success).toBe(true);
    expect(storePackSchema.safeParse({ ...apple, stores: ['playstore'], devices: { playstore: ['phone'] }, screenshots: shots(2) }).success).toBe(true);
  });
  it('screenshot counts: App Store 1..10, Google Play 2..8, both 2..8', () => {
    expect(storePackSchema.safeParse({ ...apple, screenshots: shots(1) }).success).toBe(true);
    expect(storePackSchema.safeParse({ ...apple, screenshots: shots(10) }).success).toBe(true);
    expect(storePackSchema.safeParse({ ...apple, screenshots: shots(11) }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...apple, screenshots: [] }).success).toBe(false);
    const play = { ...apple, stores: ['playstore'], devices: { playstore: ['phone'] } };
    expect(storePackSchema.safeParse({ ...play, screenshots: shots(1) }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...play, screenshots: shots(8) }).success).toBe(true);
    expect(storePackSchema.safeParse({ ...play, screenshots: shots(9) }).success).toBe(false);
    const both = { ...apple, stores: ['appstore', 'playstore'], devices: { appstore: ['iphone-69'], playstore: ['phone'] } };
    expect(storePackSchema.safeParse({ ...both, screenshots: shots(1) }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...both, screenshots: shots(9) }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...both, screenshots: shots(5) }).success).toBe(true);
  });
  it('requires iphone-69 for the App Store and phone for Google Play', () => {
    expect(storePackSchema.safeParse({ ...apple, devices: { appstore: ['ipad-13'] } }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...apple, devices: {} }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...apple, stores: ['playstore'], devices: { playstore: ['tablet'] }, screenshots: shots(2) }).success).toBe(false);
  });
  it('is strict and bounds the text', () => {
    expect(storePackSchema.safeParse({ ...apple, extra: 1 }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...apple, app: { name: '', tagline: '' } }).success).toBe(false);
    expect(storePackSchema.safeParse({ ...apple, screenshots: [{ caption: '', screen: null }] }).success).toBe(false);
  });
  it('confines a screenshot screen to assets/', () => {
    const withScreen = (screen: string | null) => storePackSchema.safeParse({ ...apple, screenshots: [{ caption: 'a', screen }] }).success;
    expect(withScreen('assets/app/home.png')).toBe(true);
    expect(withScreen(null)).toBe(true);
    for (const bad of ['../x.png', 'assets/../x.png', '/etc/passwd', 'C:/x.png', 'assets\\x.png', 'https://example.com/a.png', 'layers/a.png', 'x.png', 'assets//x.png', ''])
      expect(withScreen(bad), bad).toBe(false);
  });
  it('rides on the brief', () => {
    expect(briefSchema.parse({ ...brief, storePack: apple }).storePack).toEqual(apple);
  });
});

describe('storePackFormats', () => {
  it('builds ids, labels and links for a full pack', () => {
    const p: StorePack = {
      app: { name: 'Bread', tagline: '' }, stores: ['appstore', 'playstore'],
      devices: { appstore: ['iphone-69', 'ipad-13'], playstore: ['phone', 'tablet', 'feature'] }, screenshots: shots(2), preview: true,
    };
    const r = storePackFormats(p);
    expect(r.formats).toEqual([
      'appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-ipad-13', 'appstore-ipad-13@2', 'appstore-preview',
      'playstore-phone-9x16', 'playstore-phone-9x16@2', 'playstore-tablet', 'playstore-tablet@2', 'playstore-feature', 'playstore-promo-16x9',
    ]);
    expect(r.formatLabels['appstore-iphone-69@2']).toBe('2 · Cap 2');
    expect(r.formatLabels['appstore-ipad-13']).toBe('1 · Cap 1');
    expect(r.formatLabels['playstore-feature']).toBeUndefined(); // the UI shows the preset name
    expect(Object.values(r.formatLabels).every((l) => /^\d+ · /.test(l))).toBe(true); // no English word
    expect(Object.keys(r.formatLabels)).toHaveLength(8);
    for (const f of r.formats) expect(INSTANCE_ID_RE.test(f)).toBe(true);
    expect(new Set(r.formats).size).toBe(r.formats.length);
    // devices of different sizes never follow each other (a link needs the same size)
    expect(r.links).toEqual({});
    expect(briefSchema.safeParse({ ...brief, formats: r.formats, formatLabels: r.formatLabels, storePack: p }).success).toBe(true);
    for (const f of r.formats) expect(DEFAULT_FORMATS.some((d) => f === d.id || f.startsWith(`${d.id}@`)), f).toBe(true);
  });
  it('links the same screenshot across devices of the same size (synthetic presets)', () => {
    const presets = [{ id: 'appstore-iphone-69', width: 100, height: 200 }, { id: 'appstore-ipad-13', width: 100, height: 200 }];
    const p: StorePack = { ...apple, devices: { appstore: ['iphone-69', 'ipad-13'] }, screenshots: shots(2) };
    expect(storePackFormats(p, presets).links).toEqual({ 'appstore-ipad-13': 'appstore-iphone-69', 'appstore-ipad-13@2': 'appstore-iphone-69@2' });
    expect(storePackFormats(p).links).toEqual({}); // shipped presets: different sizes (Ruling D)
  });
  it('a one-store pack without preview', () => {
    expect(storePackFormats(apple).formats).toEqual(['appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-iphone-69@3']);
    expect(storePackFormats({ ...apple, preview: true }).formats.at(-1)).toBe('appstore-preview');
  });
  it('a ten-screenshot App Store pack fits in the instance range', () => {
    const f = storePackFormats({ ...apple, screenshots: shots(10) }).formats;
    expect(f.at(-1)).toBe('appstore-iphone-69@10');
    expect(f).toHaveLength(10);
  });
});
