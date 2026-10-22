/**
 * Drawn subtitles (subtitles plan Task 16, spec §6.4): the creative's subtitle set, inlined in the page as
 * `RuntimeSubtitles` (times in composition milliseconds), and the built-in look of the `subtitles` clip.
 *
 * - `readRuntimeSubtitles` checks the block by hand (no zod: the render runtime does not carry it). A bad block is
 *   refused whole; the caller reports `subtitlesInvalid` and draws nothing (never fatal).
 * - `activeCue` finds the line at a time; `drawSubtitles` draws it. Both are pure functions of the time: render mode
 *   draws each frame from `tMs` alone (no timers, no transitions), so a frame is the same however it is reached.
 */
import type { SubtitlesClip } from '@motion-studio/shared';

export interface RuntimeWord { start: number; end: number; text: string }
export interface RuntimeCue { start: number; end: number; text: string; words?: RuntimeWord[] }
export interface RuntimeSubtitles { lang: string; cues: RuntimeCue[] }

/** As the subtitle set's own bounds (`SUBTITLE_LIMITS`), plus a ceiling on times (10 hours) and on the language tag. */
export const RUNTIME_SUBTITLE_LIMITS = { cues: 2000, words: 60, text: 200, wordText: 100, lang: 35, ms: 36_000_000 } as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysWithin = (o: Obj, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= RUNTIME_SUBTITLE_LIMITS.ms;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * The subtitles of the page data or of a `setSubtitles` message: a fresh copy, or why it was refused. Every cue has
 * finite times with `start < end`, a text of at most 200 characters, and the cues are sorted by start (overlaps are
 * allowed: the editor only warns about them); words are at most 60 per cue, each with `start <= end`.
 */
export function readRuntimeSubtitles(v: unknown): { ok: true; subtitles: RuntimeSubtitles } | { ok: false; reason: string } {
  const L = RUNTIME_SUBTITLE_LIMITS;
  if (!isObj(v) || !keysWithin(v, ['lang', 'cues'])) return { ok: false, reason: 'not a subtitles block' };
  if (typeof v.lang !== 'string' || v.lang.length > L.lang || !LANG_RE.test(v.lang)) return { ok: false, reason: 'bad language' };
  if (!Array.isArray(v.cues) || v.cues.length > L.cues) return { ok: false, reason: `cues must be an array of at most ${L.cues}` };
  const cues: RuntimeCue[] = [];
  let last = 0;
  for (let i = 0; i < v.cues.length; i++) {
    const c: unknown = v.cues[i];
    if (!isObj(c) || !keysWithin(c, ['start', 'end', 'text', 'words'])) return { ok: false, reason: `cue ${i} is malformed` };
    if (!isMs(c.start) || !isMs(c.end) || !(c.end > c.start)) return { ok: false, reason: `cue ${i} has bad times` };
    if (c.start < last) return { ok: false, reason: `cue ${i} is out of order` };
    last = c.start;
    if (typeof c.text !== 'string' || c.text.length > L.text) return { ok: false, reason: `cue ${i} has a bad text` };
    let words: RuntimeWord[] | undefined;
    if (c.words !== undefined) {
      if (!Array.isArray(c.words) || c.words.length > L.words) return { ok: false, reason: `cue ${i} has too many words` };
      words = [];
      for (const w of c.words as unknown[]) {
        if (!isObj(w) || !keysWithin(w, ['start', 'end', 'text']) || !isMs(w.start) || !isMs(w.end) || w.end < w.start
          || typeof w.text !== 'string' || w.text.length === 0 || w.text.length > L.wordText) return { ok: false, reason: `cue ${i} has a bad word` };
        words.push({ start: w.start, end: w.end, text: w.text });
      }
    }
    cues.push({ start: c.start, end: c.end, text: c.text, ...(words ? { words } : {}) });
  }
  return { ok: true, subtitles: { lang: v.lang, cues } };
}

/**
 * The index of the cue shown at `ms`, or -1: of the cues whose span holds it (start inclusive, end exclusive), the one
 * that started last (a line that starts over another one replaces it). Binary search for the last cue started by `ms`;
 * when that one has ended, a few earlier ones are tried (an overlap is between neighbours).
 */
export function activeCue(cues: ReadonlyArray<{ start: number; end: number }>, ms: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= ms) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = at; i >= 0 && i > at - LOOK_BACK; i--) if (ms < cues[i]!.end) return i;
  return -1;
}
/** How many cues before the last one started `activeCue` looks at. */
const LOOK_BACK = 8;

export interface SubtitleFrame { width: number; height: number; safeZone?: { top: number; bottom: number; left: number; right: number } }
/** Drawing options the mount gives: the font chain of the composition (its fonts and fallbacks). */
export interface SubtitleDrawOptions { fontFamily?: string }

/** Default entrance length when the clip names an entrance without `entranceSec`. */
const ENTRANCE_SEC = 0.2;
const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;

/** What is drawn in an element: its text and the words, and the word lit, so a frame that changes neither rebuilds nothing. */
interface Drawn { cue: RuntimeCue; on: number; key: string }
const drawn = new WeakMap<HTMLElement, Drawn>();

/**
 * Where each word of the cue is in its text, in order; null when the words do not match the text (the text was
 * corrected after the words were timed): then the line is drawn without highlight.
 */
function wordRanges(cue: RuntimeCue): Array<[number, number]> | null {
  if (!cue.words || cue.words.length === 0) return null;
  const out: Array<[number, number]> = [];
  let from = 0;
  for (const w of cue.words) {
    const at = cue.text.indexOf(w.text, from);
    if (at < 0) return null;
    out.push([at, at + w.text.length]);
    from = at + w.text.length;
  }
  return out;
}

/**
 * Draws `cue` at `tMs` in `el` (the clip's lane), or hides it when `cue` is null.
 *
 * `el` is absolutely positioned across the safe zone's width (the frame without the format's insets), `margin` px inside
 * its bottom or top edge, or centred on its middle; the line's box (`.ms-subs-box`) is at most `maxWidth` of the frame
 * wide and is aligned in the lane by `align`. The text keeps its line breaks (`white-space: pre-line`) and wraps inside
 * the box. `background` draws a box behind it (`boxPadding`, `boxRadius`), `outlineColor` / `outlineWidth` an outline
 * painted under the fill, `shadow` a soft drop shadow. The entrance (`fade`, `pop`, `slideUp`) runs over `entranceSec`
 * from the cue start. With `highlight` and words that match the text, the word whose span holds `tMs` takes the
 * highlight colour (`data-on="true"`); between words none does.
 */
export function drawSubtitles(el: HTMLElement, clip: SubtitlesClip, cue: RuntimeCue | null, tMs: number, frame: SubtitleFrame, o: SubtitleDrawOptions = {}): void {
  const p = clip.props;
  if (!cue) {
    el.style.display = 'none';
    el.replaceChildren();
    drawn.delete(el);
    return;
  }
  const sz = frame.safeZone ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const roomW = Math.max(0, frame.width - sz.left - sz.right);
  const roomH = Math.max(0, frame.height - sz.top - sz.bottom);
  const align = p.align ?? 'center';
  Object.assign(el.style, {
    display: 'flex', position: 'absolute', left: `${sz.left}px`, width: `${roomW}px`, pointerEvents: 'none',
    justifyContent: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
    top: '', bottom: '', transform: '',
  });
  if (p.position === 'bottom') el.style.bottom = `${sz.bottom + p.margin}px`;
  else if (p.position === 'top') el.style.top = `${sz.top + p.margin}px`;
  else { el.style.top = `${sz.top + roomH / 2}px`; el.style.transform = 'translateY(-50%)'; }

  // The box and its text: rebuilt only when the cue, its words or the word lit change.
  const ranges = p.highlight ? wordRanges(cue) : null;
  let on = -1;
  if (ranges) on = cue.words!.findIndex((w) => tMs >= w.start && tMs < w.end);
  const key = `${clip.id}|${p.highlight?.color ?? ''}`;
  const prev = drawn.get(el);
  let box = el.firstElementChild as HTMLElement | null;
  if (!prev || prev.cue !== cue || prev.on !== on || prev.key !== key || !box) {
    box = el.ownerDocument.createElement('div');
    box.className = 'ms-subs-box';
    if (ranges) {
      let at = 0;
      ranges.forEach(([s, e], i) => {
        if (s > at) box!.append(cue.text.slice(at, s));
        const span = el.ownerDocument.createElement('span');
        span.dataset.msWord = String(i);
        span.textContent = cue.text.slice(s, e);
        if (i === on) { span.dataset.on = 'true'; span.style.color = p.highlight!.color; }
        box!.append(span);
        at = e;
      });
      if (at < cue.text.length) box.append(cue.text.slice(at));
    } else {
      box.textContent = cue.text;
    }
    el.replaceChildren(box);
    drawn.set(el, { cue, on, key });
  }

  const fs = p.fontSize;
  const outline = p.outlineColor && (p.outlineWidth ?? 0) > 0 ? { color: p.outlineColor, width: p.outlineWidth! } : null;
  Object.assign(box.style, {
    boxSizing: 'border-box', maxWidth: `${Math.min(roomW, p.maxWidth * frame.width)}px`,
    fontFamily: o.fontFamily ?? 'sans-serif', fontSize: `${fs}px`, fontWeight: String(p.fontWeight ?? 'normal'),
    lineHeight: String(p.lineHeight ?? 1.2), color: p.color, textAlign: align,
    whiteSpace: 'pre-line', overflowWrap: 'break-word',
    padding: p.background ? `${p.boxPadding ?? Math.round(fs * 0.25)}px` : '0px',
    borderRadius: p.background ? `${p.boxRadius ?? 0}px` : '0px',
    backgroundColor: p.background ?? 'transparent',
    // The stroke is centred on the glyph's edge: twice the width, painted under the fill, leaves `outlineWidth` outside.
    webkitTextStroke: outline ? `${outline.width * 2}px ${outline.color}` : '',
    paintOrder: outline ? 'stroke fill' : '',
    textShadow: p.shadow ? `0 ${round(fs * 0.04)}px ${round(fs * 0.15)}px rgba(0, 0, 0, 0.75)` : '',
  });

  // The entrance: a pure function of the time since the cue start.
  const entrance = p.entrance ?? 'none';
  const sec = p.entranceSec ?? ENTRANCE_SEC;
  const k = entrance === 'none' || !(sec > 0) ? 1 : Math.min(1, Math.max(0, (tMs - cue.start) / (sec * 1000)));
  const e = easeOutCubic(k);
  box.style.opacity = entrance === 'none' || k >= 1 ? '1' : String(round(e, 4));
  box.style.transform = entrance === 'pop' && k < 1 ? `scale(${round(0.8 + 0.2 * e, 4)})`
    : entrance === 'slideUp' && k < 1 ? `translateY(${round((1 - e) * fs * 0.6, 2)}px)` : '';
}

const round = (v: number, digits = 1) => { const m = 10 ** digits; return Math.round(v * m) / m; };
