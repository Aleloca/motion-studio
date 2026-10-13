// Comments on clips and on time ranges (Phase 10b, Task 10): how such a pin is made and how it reads. Pure, so the editor and
// the format view build the same pins and the conversation, the timeline and the transport show them the same way.
import type { Clip, Composition, Pin } from '@motion-studio/shared';
import { formatNumber, type useLocale, type useT } from '../i18n.tsx';

/** A range shorter than this (seconds) is a click, not a range. */
export const MIN_RANGE = 0.1;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const unit = (v: number) => Math.min(1, Math.max(0, v));

/** A pin's range, when it has one. */
export const rangeOf = (p: Pin): { start: number; end: number } | null => p.range ?? null;

/** The clip with this id, found in the composition's tracks. */
export function findClipById(comp: Composition, id: string): Clip | null {
  for (const t of comp.tracks) for (const c of t.clips) if (c.id === id) return c;
  return null;
}

/** The clips playing at `time` (the format view's picker). */
export function clipsAt(comp: Composition, time: number): Clip[] {
  const out: Clip[] = [];
  for (const t of comp.tracks) for (const c of t.clips) if (time >= c.start - 1e-6 && time <= c.start + c.duration + 1e-6) out.push(c);
  return out;
}

/** What a clip is called to the user: its name, else its id. */
export const clipLabel = (c: Clip): string => c.name ?? c.id;

/**
 * The clip's centre as fractions of the composition (0..1). `bounds` is the box the runtime drew (frame pixels, with the frame
 * pixels per composition pixel in `scale`); without it the clip's own x, y, width and height are used, else the middle.
 */
export function clipCentre(comp: Composition, clip: Clip, drawn?: { bounds: { x: number; y: number; width: number; height: number } | null; scale: number } | null): { x: number; y: number } {
  if (drawn?.bounds && drawn.scale > 0 && comp.width > 0 && comp.height > 0) {
    const b = drawn.bounds;
    return { x: unit((b.x + b.width / 2) / drawn.scale / comp.width), y: unit((b.y + b.height / 2) / drawn.scale / comp.height) };
  }
  const p = ('props' in clip ? clip.props : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : null);
  const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')];
  if (x !== null && y !== null && w !== null && h !== null && comp.width > 0 && comp.height > 0) return { x: unit((x + w / 2) / comp.width), y: unit((y + h / 2) / comp.height) };
  return { x: 0.5, y: 0.5 };
}

/** A clip comment: on the clip's centre, at `time`. */
export function clipPin(o: { format: string; comp: Composition; clip: Clip; time: number; drawn?: Parameters<typeof clipCentre>[2]; note?: string }): Pin {
  const c = clipCentre(o.comp, o.clip, o.drawn);
  return { format: o.format, x: c.x, y: c.y, timeSec: round3(o.time), clipId: o.clip.id, clipName: clipLabel(o.clip), ...(o.note ? { note: o.note } : {}) };
}

/** A range comment: its time is the range start, its point the middle of the picture. Null when the range is too short. */
export function rangePin(o: { format: string; start: number; end: number; duration: number; note?: string }): Pin | null {
  const a = round3(Math.max(0, Math.min(o.start, o.end)));
  const b = round3(Math.min(o.duration, Math.max(o.start, o.end)));
  if (b - a < MIN_RANGE) return null;
  return { format: o.format, x: 0.5, y: 0.5, timeSec: a, range: { start: a, end: b }, ...(o.note ? { note: o.note } : {}) };
}

type T = ReturnType<typeof useT>;
type Locale = ReturnType<typeof useLocale>;
const one = (locale: Locale, v: number) => formatNumber(locale, v, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** `2.0`, `3.5` of a range, for chips and labels. */
export const rangeTimes = (locale: Locale, r: { start: number; end: number }) => ({ a: one(locale, r.start), b: one(locale, r.end) });

/** The chip text of a clip or range pin (`Reel · "Title" clip`, `Reel · 2.0–3.5 s`); null for any other pin (the old text applies). */
export function clipRangeChip(p: Pin, format: string, t: T, locale: Locale): string | null {
  const c = t.web.conversation;
  const name = p.clipName ?? p.clipId;
  if (p.clipId && p.range) return c.chipClipRange({ format, name: name!, ...rangeTimes(locale, p.range) });
  if (p.clipId) return c.chipClip({ format, name: name! });
  if (p.range) return c.chipRange({ format, ...rangeTimes(locale, p.range) });
  return null;
}

/** `2.0–3.5 s` of a range, as a place in a card's header. */
export const rangeSeconds = (t: T, locale: Locale, r: { start: number; end: number }): string => {
  const { a, b } = rangeTimes(locale, r);
  return t.web.canvas.seconds({ n: `${a}–${b}` });
};
