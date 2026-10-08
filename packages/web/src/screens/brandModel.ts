// Brand page model: pure helpers shared by the Brand page and the proposal review (no React, no API).
import type { AgentEvent, BrandKit, BrandOverview, BrandSource, JobSummary, SourceRef } from '@motion-studio/shared';

export const MANUAL: SourceRef = { kind: 'manual', ref: null };

/**
 * The first family of a CSS `font-family` stack (point 15): `Newsreader, "Newsreader Fallback", Georgia` →
 * `Newsreader`. Commas inside quotes do not split; surrounding quotes and spaces go.
 */
export function normalizeFamily(input: string): string {
  let quote: string | null = null;
  let first = '';
  for (const ch of input) {
    if (quote) { if (ch === quote) quote = null; else first += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ',') break;
    first += ch;
  }
  return first.replace(/\s+/g, ' ').trim();
}

/** Six hex digits, with or without the leading '#', any case → '#RRGGBB' upper case; anything else → null. */
export function normalizeHex(input: string): string | null {
  const v = input.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : null;
}

/** Relative luminance (WCAG 2.x) of `#RRGGBB`. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const WHITE = '#FFFFFF'; // color-data: neutral fallback for text on a brand swatch
const BLACK = '#000000'; // color-data: neutral fallback for text on a brand swatch

export interface SwatchText { color: string; name: string | null; ratio: number }

/**
 * The text color to show on a swatch: the palette color with the highest contrast against it when that reaches AA
 * (4.5:1), otherwise the better of white and black. The ratio is computed, never hard-coded.
 */
export function swatchText(hex: string, palette: Array<{ hex: string; name: string }>): SwatchText {
  let best: SwatchText | null = null;
  for (const c of palette) {
    if (c.hex.toUpperCase() === hex.toUpperCase()) continue;
    const ratio = contrast(hex, c.hex);
    if (!best || ratio > best.ratio) best = { color: c.hex, name: c.name, ratio };
  }
  if (best && best.ratio >= 4.5) return best;
  const w = contrast(hex, WHITE);
  const b = contrast(hex, BLACK);
  return w >= b ? { color: WHITE, name: null, ratio: w } : { color: BLACK, name: null, ratio: b };
}

/** 15.23 → "15.2"; 4 → "4". */
export const ratioText = (r: number) => String(Math.round(r * 10) / 10);

/**
 * A stage color for a logo preview, taken from the brand's own palette (data): the darkest color for logos made for
 * dark backgrounds, the lightest otherwise. null when the palette has no suitable color (the CSS token stage is used).
 */
export function stageColor(kind: 'light' | 'dark' | 'any', palette: Array<{ hex: string }>): string | null {
  if (!palette.length) return null;
  const sorted = [...palette].sort((a, b) => luminance(a.hex) - luminance(b.hex));
  if (kind === 'dark') { const d = sorted[0]!; return luminance(d.hex) < 0.08 ? d.hex : null; }
  const l = sorted[sorted.length - 1]!;
  return luminance(l.hex) > 0.6 ? l.hex : null;
}

export const hasLogoFor = (kit: BrandKit, bg: 'light' | 'dark') => kit.logos.some((l) => l.background === bg || l.background === 'any');

export type HealthId = 'palette' | 'fonts' | 'rules' | 'lightLogo';
/** Brand health (ruling R5): a checklist derived only from the kit, each item a real pass/fail. No score. */
export function healthChecks(kit: BrandKit): Array<{ id: HealthId; ok: boolean }> {
  return [
    { id: 'palette', ok: kit.colors.some((c) => c.role !== 'other') },
    { id: 'fonts', ok: kit.fonts.length > 0 && kit.fonts.every((f) => f.file !== null) },
    { id: 'rules', ok: kit.dos.length > 0 && kit.donts.length > 0 },
    { id: 'lightLogo', ok: hasLogoFor(kit, 'light') },
  ];
}

export const kitIsEmpty = (k: BrandKit) => !k.colors.length && !k.fonts.length && !k.logos.length && !k.dos.length && !k.donts.length && !k.tone && !k.photoStyle;

/** A project with nothing about its brand yet: no kit content, no guidelines, no sources, no analysis ever. */
export function brandIsEmpty(o: BrandOverview, job: JobSummary | undefined): boolean {
  return !o.kitError && kitIsEmpty(o.kit) && !o.guidelines.trim() && o.sources.length === 0 && o.proposals.length === 0 && !job;
}

/** The latest job of the brand queue key (analysis or asset description share it). */
export function latestBrandJob(jobs: Record<string, JobSummary>, key: string): JobSummary | undefined {
  return Object.values(jobs).filter((j) => j.key === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * The analysis steps: the texts the agent reported with `report_progress`, in order, without consecutive repeats.
 * `report_progress` carries text only, so there is no percentage to show.
 */
export function analysisSteps(events: AgentEvent[] | undefined): string[] {
  const out: string[] = [];
  for (const e of events ?? []) if (e.kind === 'progress' && e.text !== out[out.length - 1]) out.push(e.text);
  return out;
}

export function hostOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** "acme.com" → "https://acme.com"; null when it is not a usable http(s) address. */
export function normalizeUrl(input: string): string | null {
  const v = input.trim();
  if (!v || /\s/.test(v)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return withScheme;
  } catch { return null; }
}

export const websiteHosts = (sources: BrandSource[], ids?: string[]) =>
  [...new Set(sources.filter((s) => s.kind === 'website' && (!ids || ids.includes(s.id))).map((s) => hostOf(s.url)).filter(Boolean))];

export const nextId = (prefix: string, ids: string[]) => { for (let n = 1; ; n++) if (!ids.includes(`${prefix}-${n}`)) return `${prefix}-${n}`; };

/** Parses "400, 700" into valid CSS weights (100–900); null when nothing valid was typed. */
export function parseWeights(input: string): number[] | null {
  const out = [...new Set(input.split(/[\s,·]+/).filter(Boolean).map(Number).filter((w) => Number.isInteger(w) && w >= 100 && w <= 900))].sort((a, b) => a - b).slice(0, 9);
  return out.length ? out : null;
}
