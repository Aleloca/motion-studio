import { decodePng } from './png.ts';

/**
 * Safe zone of the masked icons (Phase 14, spec §4.2, decision 729): where the non-transparent content of
 * `icon-512-maskable.png` and of the Android adaptive foreground falls. Content outside the safe circle may be cut by the
 * platform's mask; the check only warns, it never blocks.
 *
 * - `maskable` (W3C manifest): a circle of 80% of the icon's side, centred;
 * - `adaptive` (Android): the 66 dp circle of the 108 dp layer.
 *
 * A pixel counts as content when its alpha is at least `ALPHA_MIN` (anti-aliased edges below it do not); `overflowPct` is
 * the share of content pixels whose centre lies outside the circle, in percent (one decimal). `ok` allows `TOLERANCE_PCT`
 * for the anti-aliasing of a shape that touches the circle.
 */

const SAFE_DIAMETER = { maskable: 0.8, adaptive: 66 / 108 } as const;
const ALPHA_MIN = 32;
export const SAFE_ZONE_TOLERANCE_PCT = 0.5;

export function safeZoneCheck(png: Buffer, size: number, kind: 'maskable' | 'adaptive'): { ok: boolean; overflowPct: number } {
  const img = decodePng(png);
  if (img.width !== size || img.height !== size) throw new Error(`safe zone: the image is ${img.width}×${img.height}, not ${size}×${size}`);
  const r = (size * SAFE_DIAMETER[kind]) / 2;
  const c = size / 2;
  let content = 0;
  let outside = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (img.rgba[(y * size + x) * 4 + 3]! < ALPHA_MIN) continue;
      content++;
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      if (dx * dx + dy * dy > r * r) outside++;
    }
  }
  const overflowPct = content === 0 ? 0 : Math.round((outside / content) * 1000) / 10;
  return { ok: overflowPct <= SAFE_ZONE_TOLERANCE_PCT, overflowPct };
}
