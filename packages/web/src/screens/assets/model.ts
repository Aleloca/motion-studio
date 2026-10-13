import type { AssetEntry, AssetKind } from '@motion-studio/shared';

export const KINDS: AssetKind[] = ['image', 'svg', 'video', 'font', 'audio', 'other'];
export const MAX_TAGS = 30;
export const MAX_TAG = 40;

/** The file name without its folder (point 16: never the `brand/…` path as a title). */
export const baseName = (file: string) => file.split('/').pop() ?? file;
/** Tags typed by hand: trimmed, at most 40 characters, no duplicates (case-insensitive), at most 30 in all. */
export function mergeTags(current: readonly string[], added: readonly string[]): string[] {
  const out = [...current];
  for (const raw of added) {
    const tag = raw.trim().slice(0, MAX_TAG);
    if (!tag || out.some((x) => x.toLowerCase() === tag.toLowerCase())) continue;
    if (out.length >= MAX_TAGS) break;
    out.push(tag);
  }
  return out;
}
export const splitTags = (text: string) => text.split(',').map((x) => x.trim()).filter(Boolean);

/** A light logo needs a dark stage to be seen: told by its name or its tags. */
export const wantsDarkStage = (a: AssetEntry) => /\b(white|light|inverse|negative|reversed|bianco|chiaro)\b/i.test(`${a.file} ${a.tags.join(' ')}`);
/**
 * SVGs and formats with an alpha channel may be drawn in ink on nothing: they sit on a stage that suits them (a light,
 * theme-invariant stage as on the Brand page, or a dark one for light logos), never on the theme's tile colour.
 * Opaque pictures cover the stage entirely, so it only shows through transparent areas.
 */
export const mayBeTransparent = (a: AssetEntry) => a.kind === 'svg' || /\.(png|webp|gif|avif)$/i.test(a.file);

export type AssetSort = 'date' | 'name' | 'kind' | 'duration';
export const SORTS: AssetSort[] = ['date', 'name', 'kind', 'duration'];

/**
 * The order of the grid. `date`: newest first (ties keep the library's order); `name`: by file name, numbers in natural
 * order; `kind`: by type (the filter order), then name; `duration`: longest first, files without a duration last, then name.
 * Never mutates its input.
 */
export function sortAssets(assets: readonly AssetEntry[], by: AssetSort): AssetEntry[] {
  const byName = (a: AssetEntry, b: AssetEntry) => baseName(a.file).localeCompare(baseName(b.file), undefined, { numeric: true, sensitivity: 'base' }) || a.file.localeCompare(b.file);
  const indexed = assets.map((a, i) => ({ a, i }));
  const rank = (a: AssetEntry) => KINDS.indexOf(a.kind);
  const cmp = (x: { a: AssetEntry; i: number }, y: { a: AssetEntry; i: number }): number => {
    if (by === 'name') return byName(x.a, y.a);
    if (by === 'kind') return rank(x.a) - rank(y.a) || byName(x.a, y.a);
    if (by === 'duration') {
      const dx = x.a.durationSec ?? null, dy = y.a.durationSec ?? null;
      if (dx === null || dy === null) return dx === dy ? byName(x.a, y.a) : dx === null ? 1 : -1;
      return dy - dx || byName(x.a, y.a);
    }
    return y.a.addedAt.localeCompare(x.a.addedAt) || x.i - y.i;
  };
  return indexed.sort(cmp).map((e) => e.a);
}

/** `1.4 MB`-style size in decimal units (the file manager's); numbers go through `fmt` for the locale. */
export function formatBytes(bytes: number, fmt: (n: number) => string): string {
  if (bytes < 1000) return `${fmt(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1000, u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${fmt(Math.round(v * (v < 10 ? 10 : 1)) / (v < 10 ? 10 : 1))} ${units[u]}`;
}
