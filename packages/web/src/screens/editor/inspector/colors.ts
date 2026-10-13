// Swatches of the colour fields: the brand palette and the colours the composition already uses. Hex values are data.
import type { Composition } from '@motion-studio/shared';
import type { ColorSwatchGroup } from '../../../ui/index.ts';
import type { Ctl } from './common.tsx';

/** The distinct colours a composition uses (background, text colours, fills, colour parameters), at most `max`. */
export function compositionColors(c: Composition, max = 16): string[] {
  const seen = new Map<string, string>();
  const add = (v: unknown) => { if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v); };
  add(c.background);
  for (const t of c.tracks) for (const k of t.clips) {
    if (k.type === 'text') add(k.props.color);
    if (k.type === 'shape') add(k.props.fill);
    if (k.type === 'html') for (const p of Object.values(k.params ?? {})) if (p.type === 'color') add(p.value);
  }
  return [...seen.values()].slice(0, max);
}

export function colorGroups(e: { swatchBrand: string; swatchComposition: string }, ctl: Pick<Ctl, 'brandColors' | 'compositionColors'>): ColorSwatchGroup[] {
  const brand = new Set(ctl.brandColors.map((x) => x.toLowerCase()));
  return [
    { label: e.swatchBrand, colors: ctl.brandColors },
    { label: e.swatchComposition, colors: ctl.compositionColors.filter((x) => !brand.has(x.toLowerCase())) },
  ];
}
