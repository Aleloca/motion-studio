// @vitest-environment node
/** The safe-zone check of the maskable and adaptive icons (Phase 14, spec §4.2, decision 729): a warning, never a block. */
import { describe, expect, it } from 'vitest';
import { encodePng, solidPng } from '../src/identity/png.ts';
import { safeZoneCheck } from '../src/identity/safe-zone.ts';

/** A transparent `size` square with an opaque disc of `radius` at the centre. */
function disc(size: number, radius: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - size / 2, dy = y + 0.5 - size / 2;
    if (dx * dx + dy * dy <= radius * radius) px.set([255, 0, 0, 255], (y * size + x) * 4);
  }
  return encodePng(size, size, px, 4);
}

describe('safeZoneCheck', () => {
  it('a centred dot passes, for maskable and adaptive', () => {
    expect(safeZoneCheck(disc(512, 60), 512, 'maskable')).toEqual({ ok: true, overflowPct: 0 });
    expect(safeZoneCheck(disc(432, 60), 432, 'adaptive')).toEqual({ ok: true, overflowPct: 0 });
  });

  it('a full-bleed square warns', () => {
    const m = safeZoneCheck(solidPng(512, 'ff0000'), 512, 'maskable');
    expect(m.ok).toBe(false);
    // 1 - π·0.4² ≈ 49.7% of the square is outside the 80% circle.
    expect(m.overflowPct).toBeGreaterThan(45);
    expect(m.overflowPct).toBeLessThan(55);
    expect(safeZoneCheck(solidPng(432, 'ff0000'), 432, 'adaptive').ok).toBe(false);
  });

  it('the adaptive circle is smaller than the maskable one: a disc between the two passes one and warns the other', () => {
    // radius 0.36 × size: inside 0.40 (maskable), outside 66/216 ≈ 0.306 (adaptive).
    expect(safeZoneCheck(disc(500, 180), 500, 'maskable').ok).toBe(true);
    expect(safeZoneCheck(disc(500, 180), 500, 'adaptive').ok).toBe(false);
  });

  it('an empty icon passes, a wrong size throws', () => {
    expect(safeZoneCheck(encodePng(16, 16, new Uint8Array(16 * 16 * 4), 4), 16, 'maskable')).toEqual({ ok: true, overflowPct: 0 });
    expect(() => safeZoneCheck(solidPng(16, '000000'), 32, 'maskable')).toThrow(/16×16/);
  });
});
