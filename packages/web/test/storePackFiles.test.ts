import { DEFAULT_FORMATS, storePackFormats, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { galleryRows, groupCheck, groupThumb, packFileGroups, scrollEdges, versionThumb, withFiles } from '../src/screens/creative/storePackFiles.ts';

const pack: StorePack = {
  app: { name: 'Tasky', tagline: '' }, stores: ['appstore', 'playstore'],
  devices: { appstore: ['iphone-69'], playstore: ['phone', 'tablet', 'feature'] },
  screenshots: [{ caption: 'Sort', screen: null }, { caption: 'Find', screen: null }], preview: true,
};
const made = storePackFormats(pack);
const names = { iphone69: 'iPhone 6.9″', ipad13: 'iPad 13″', phone: 'Phone', tablet: 'Tablet', feature: 'Feature graphic' };

describe('packFileGroups', () => {
  it('groups the pack by store and device, a screenshot by its label, previews and the feature graphic alone', () => {
    const g = packFileGroups(made.formats, { presets: DEFAULT_FORMATS, labels: made.formatLabels, locale: 'en', deviceName: (d) => names[d], thumbOf: () => null });
    expect(g.map((s) => [s.store, s.devices.map((d) => [d.label, d.single, d.rows.map((r) => r.label)])])).toEqual([
      ['appstore', [['iPhone 6.9″', false, ['1 · Sort', '2 · Find']], ['App Preview', true, ['App Preview']]]],
      ['playstore', [['Phone', false, ['1 · Sort', '2 · Find']], ['Tablet', false, ['1 · Sort', '2 · Find']], ['Feature graphic', true, ['Feature graphic']], ['Promo video 16:9', true, ['Promo video 16:9']]]],
    ]);
    expect(g[0]!.devices[0]!.rows.map((r) => r.id)).toEqual(['appstore-iphone-69', 'appstore-iphone-69@2']);
  });

  it('leaves out a format that is not a store pack format', () => {
    expect(packFileGroups(['instagram-post-1x1'], { presets: DEFAULT_FORMATS, locale: 'en', deviceName: (d) => names[d], thumbOf: () => null })).toEqual([]);
  });
});

describe('report 54: the gallery', () => {
  const groups = (p: StorePack) => { const m = storePackFormats(p); return packFileGroups(m.formats, { presets: DEFAULT_FORMATS, labels: m.formatLabels, locale: 'en', deviceName: (d) => names[d], thumbOf: () => null }); };
  const shape = (rows: ReturnType<typeof galleryRows>) => rows.map((r) => [r.label, r.files.map((f) => f.id), r.tail.map((f) => f.id)]);

  it('one row per device; the single files at the end of the store\'s last row', () => {
    const [app, play] = groups(pack);
    expect(shape(galleryRows(app!))).toEqual([['iPhone 6.9″', ['appstore-iphone-69', 'appstore-iphone-69@2'], ['appstore-preview']]]);
    expect(shape(galleryRows(play!))).toEqual([
      ['Phone', ['playstore-phone-9x16', 'playstore-phone-9x16@2'], []],
      ['Tablet', ['playstore-tablet', 'playstore-tablet@2'], ['playstore-feature', 'playstore-promo-16x9']],
    ]);
  });

  it('a store with only single files: one row without a device', () => {
    const [play] = groups({ ...pack, stores: ['playstore'], devices: { playstore: ['feature'] } });
    expect(shape(galleryRows(play!))).toEqual([[null, [], ['playstore-feature', 'playstore-promo-16x9']]]);
  });

  it('a group\'s checkbox: on, off or mixed, with n/m', () => {
    expect(groupCheck(['a', 'b'], new Set())).toEqual({ n: 2, of: 2, on: true, mixed: false });
    expect(groupCheck(['a', 'b'], new Set(['a']))).toEqual({ n: 1, of: 2, on: false, mixed: true });
    expect(groupCheck(['a', 'b'], new Set(['a', 'b', 'c']))).toEqual({ n: 0, of: 2, on: false, mixed: false });
  });

  it('includes or leaves out files, without touching the others', () => {
    const off = new Set(['a']);
    expect([...withFiles(off, ['b', 'c'], false)].sort()).toEqual(['a', 'b', 'c']);
    expect([...withFiles(off, ['a'], true)]).toEqual([]);
    expect([...off]).toEqual(['a']);
  });

  it('the strip\'s edges: more to either side, a pixel of rounding ignored', () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 500, clientWidth: 500 })).toEqual({ back: false, more: false });
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 900, clientWidth: 500 })).toEqual({ back: false, more: true });
    expect(scrollEdges({ scrollLeft: 200, scrollWidth: 900, clientWidth: 500 })).toEqual({ back: true, more: true });
    expect(scrollEdges({ scrollLeft: 399.5, scrollWidth: 900, clientWidth: 500 })).toEqual({ back: true, more: false });
  });
});

describe('pack thumbnails', () => {
  const v = (o: Partial<VersionEntry>): VersionEntry => ({ n: 2, outputs: [], ...o } as VersionEntry);
  it('a version: a still of the composition without a current render, the render otherwise', () => {
    const comp = { format: 'appstore-iphone-69', hash: 'h1' };
    expect(versionThumb('acme', 'c1', v({ compositions: [comp] as VersionEntry['compositions'] }), 'appstore-iphone-69'))
      .toEqual({ still: { slug: 'acme', creative: 'c1', n: 2, format: 'appstore-iphone-69', hash: 'h1' } });
    const out = { format: 'appstore-iphone-69', file: 'appstore-iphone-69.png', width: 1, height: 1, durationSec: null, verified: true, preview: null, sha256: 'x', fromComposition: 'h1' };
    const t = versionThumb('acme', 'c1', v({ compositions: [comp] as VersionEntry['compositions'], outputs: [out] as VersionEntry['outputs'] }), 'appstore-iphone-69');
    expect(t && 'media' in t ? t.media.src : null).toMatch(/outputs\/v2\/appstore-iphone-69\.png/);
    expect(versionThumb('acme', 'c1', undefined, 'x')).toBeNull();
  });

  it('a group: the member and version of its selection', () => {
    const g = { format: 'appstore-iphone-69', slug: 'c1~b', letter: 'b' as const, version: 3, source: 'pick' as const, file: '', width: 1, height: 1, state: 'needs-render' as const, hash: 'h' };
    expect(groupThumb('acme', g)).toEqual({ still: { slug: 'acme', creative: 'c1~b', n: 3, format: 'appstore-iphone-69', hash: 'h' } });
    const ready = groupThumb('acme', { ...g, state: 'ready', file: 'a.png' });
    expect(ready && 'media' in ready ? ready.media.src : null).toMatch(/c1~b.*outputs\/v3\/a\.png|c1%7Eb.*outputs/);
    expect(groupThumb('acme', { ...g, state: 'missing' })).toBeNull();
  });
});
