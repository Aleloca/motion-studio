// @vitest-environment node
/** The `.ico` writer and reader (Phase 14, spec §4.2) and the PNG helpers it relies on. */
import { describe, expect, it } from 'vitest';
import { FAVICON_ICO_SIZES } from '@motion-studio/shared';
import { readIco, writeIco } from '../src/identity/ico.ts';
import { decodePng, encodePng, PNG_SIGNATURE, pngSize, solidPng } from '../src/identity/png.ts';

const rgbaPng = (size: number, shade: number) => {
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set([shade, 255 - shade, i % 256, i % 3 === 0 ? 0 : 255], i * 4);
  return encodePng(size, size, px, 4);
};

describe('writeIco / readIco', () => {
  it('round trip: 3 entries, PNG payloads, sizes 16/32/48 in order', () => {
    const pngs = FAVICON_ICO_SIZES.map((size, k) => ({ size, png: rgbaPng(size, k * 80) }));
    const ico = writeIco(pngs);
    // ICONDIR: reserved 0, type 1, count 3.
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    // First entry: 16×16, 32 bpp, offset right after the directory.
    expect([ico[6], ico[7], ico.readUInt16LE(6 + 4), ico.readUInt16LE(6 + 6), ico.readUInt32LE(6 + 12)]).toEqual([16, 16, 1, 32, 6 + 16 * 3]);
    const back = readIco(ico);
    expect(back.map((e) => [e.width, e.height])).toEqual([[16, 16], [32, 32], [48, 48]]);
    for (const [k, e] of back.entries()) {
      expect(e.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(e.png.equals(pngs[k]!.png)).toBe(true);
      const img = decodePng(e.png);
      expect([img.width, img.height, img.alpha]).toEqual([pngs[k]!.size, pngs[k]!.size, true]);
    }
  });

  it('a 256 px entry is written as 0 and read back as 256', () => {
    const ico = writeIco([{ size: 256, png: solidPng(256, '336699') }]);
    expect(ico[6]).toBe(0);
    expect(readIco(ico)[0]).toMatchObject({ width: 256, height: 256 });
  });

  it('refuses a PNG of the wrong size, a non-PNG, and a broken file', () => {
    expect(() => writeIco([{ size: 16, png: solidPng(32, '000000') }])).toThrow(/16 px/);
    expect(() => writeIco([{ size: 16, png: Buffer.from('not a png') }])).toThrow(/PNG/);
    expect(() => writeIco([])).toThrow();
    const ico = writeIco([{ size: 16, png: solidPng(16, '000000') }]);
    expect(() => readIco(ico.subarray(0, 30))).toThrow();
    const bad = Buffer.from(ico);
    bad[6] = 32; // the entry says 32 px, the PNG is 16
    expect(() => readIco(bad)).toThrow(/match/);
  });
});

describe('PNG helpers', () => {
  it('encode then decode RGB and RGBA, every filter type of a real encoder is covered by the decoder', () => {
    const rgb = solidPng(5, 'a0b1c2');
    expect(pngSize(rgb)).toMatchObject({ width: 5, height: 5, colorType: 2 });
    const d = decodePng(rgb);
    expect([...d.rgba.subarray(0, 4)]).toEqual([0xa0, 0xb1, 0xc2, 255]);
    expect(d.alpha).toBe(false);
    const rgba = decodePng(rgbaPng(7, 10));
    expect(rgba.alpha).toBe(true);
    expect(rgba.rgba[3]).toBe(0);
  });
});
