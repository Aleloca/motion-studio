// The subtitle editor's model: a pure reducer over the cues with undo, the warnings and the cue under the playhead (decisions 1652-1655).
import { SUBTITLE_LIMITS, SUBTITLE_RULES, cueWarnings, wrapLines, type CueWarning, type LocaleTag, type SubtitleCue, type SubtitleWord } from '@motion-studio/shared';

export interface EditorState {
  cues: SubtitleCue[];
  past: SubtitleCue[][];
  future: SubtitleCue[][];
  selected: string | null;
  durationMs: number;
  dirty: boolean;
  /** The set's language: wrapping and the warnings depend on it. */
  lang: LocaleTag;
  /** The cue being typed in: its next `text` op joins the last undo step (until another op, a select or `endTyping`). */
  typing: string | null;
  /** The cue being dragged on the timeline: its next `times` op marked `drag` joins the last undo step (until `endDrag` or another op). */
  dragging: string | null;
}

export type EditorOp =
  | { type: 'text'; id: string; text: string }
  /** `drag`: a move of a timeline drag (the whole drag is one undo step). */
  | { type: 'times'; id: string; start?: number; end?: number; drag?: boolean }
  | { type: 'split'; id: string; at: number }
  | { type: 'merge'; id: string }
  | { type: 'add'; at: number }
  | { type: 'delete'; id: string }
  | { type: 'replace'; find: string; with: string; caseSensitive: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; id: string | null }
  /** The video's duration, known after the load (the player reports it): no history, nothing to save. */
  | { type: 'duration'; ms: number }
  /** The user left the text box: the next typing is a new undo step. */
  | { type: 'endTyping' }
  /** The timeline drag ended: the next one is a new undo step. */
  | { type: 'endDrag' }
  | { type: 'load'; cues: SubtitleCue[]; durationMs: number; lang: LocaleTag };

export const UNDO_DEPTH = 200;
export const MIN_CUE_MS = 200;
export const SNAP_MS = 100;
export const NEW_CUE_MS = 2000;
/** The text of a cue made by `add`: a cue cannot be empty (the file format wants one character), so it starts as an ellipsis. */
export const NEW_CUE_TEXT = '…';

const len = (s: string): number => Array.from(s).length;
const NO_SPACE_LANGS: readonly string[] = ['zh-Hans', 'zh-Hant', 'ja', 'th'];
const joiner = (lang: LocaleTag): string => (NO_SPACE_LANGS.includes(lang) ? '' : ' ');

/**
 * The text a cue may hold: each line trimmed, empty lines dropped (a blank line ends an SRT cue), at most 200 characters and two lines
 * (a third line is rewrapped, any overflow folded into the last line). Empty when nothing is left.
 */
export function normalizeCueText(text: string, lang: LocaleTag): string {
  let lines = text.split(/\r\n|[\r\n]/).map((l) => l.trim()).filter((l) => l !== '');
  let joined = lines.join('\n');
  if (len(joined) > SUBTITLE_LIMITS.text) {
    joined = Array.from(joined).slice(0, SUBTITLE_LIMITS.text).join('');
    lines = joined.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  }
  if (lines.length <= SUBTITLE_RULES.maxLines) return lines.join('\n');
  const wrapped = wrapLines(lines.join(joiner(lang)), lang);
  if (wrapped.length <= SUBTITLE_RULES.maxLines) return wrapped.join('\n');
  return [...wrapped.slice(0, SUBTITLE_RULES.maxLines - 1), wrapped.slice(SUBTITLE_RULES.maxLines - 1).join(joiner(lang))].join('\n');
}

const flatten = (text: string, lang: LocaleTag): string => text.replace(/\s*\n\s*/g, joiner(lang));
const compact = (s: string): string => s.replace(/\s+/g, '');
/** The editor's cue order (by start, then end): every `load` and edit sorts with it. */
export const byStart = (a: SubtitleCue, b: SubtitleCue): number => a.start - b.start || a.end - b.end;

function nextId(cues: SubtitleCue[]): string {
  let n = 0;
  for (const c of cues) {
    const m = /^u(\d+)$/.exec(c.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `u${n + 1}`;
}

/** The cue with a new text; its words go when the text no longer says them. */
function withText(c: SubtitleCue, text: string): SubtitleCue {
  const out: SubtitleCue = { ...c, text, edited: true };
  if (c.words && compact(c.words.map((w) => w.text).join('')) !== compact(text)) delete out.words;
  return out;
}

function commit(s: EditorState, cues: SubtitleCue[], selected: string | null = s.selected): EditorState {
  return { ...s, cues: [...cues].sort(byStart), past: [...s.past, s.cues].slice(-UNDO_DEPTH), future: [], selected, dirty: true, typing: null, dragging: null };
}

function setTimes(s: EditorState, op: Extract<EditorOp, { type: 'times' }>): EditorState {
  const i = s.cues.findIndex((c) => c.id === op.id);
  if (i < 0) return s;
  const cue = s.cues[i]!;
  const prev = s.cues[i - 1];
  const next = s.cues[i + 1];
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : s.durationMs;
  const snap = (v: number, edge: number | undefined): number => (edge !== undefined && Math.abs(v - edge) <= SNAP_MS ? edge : v);
  let start = cue.start;
  let end = cue.end;
  if (op.start !== undefined && op.end !== undefined) {
    // Both given: the cue moves as a block of the asked length.
    const dur = Math.max(MIN_CUE_MS, op.end - op.start);
    const sn = snap(op.start, prev?.end);
    start = sn !== op.start ? sn : snap(op.end, next?.start) - dur;
    start = Math.min(Math.max(start, lo), Math.max(lo, hi - dur));
    end = Math.min(start + dur, hi);
  } else if (op.start !== undefined) {
    start = Math.min(Math.max(snap(op.start, prev?.end), lo), cue.end - MIN_CUE_MS);
  } else if (op.end !== undefined) {
    end = Math.max(Math.min(snap(op.end, next?.start), hi), cue.start + MIN_CUE_MS);
  }
  start = Math.round(start);
  end = Math.round(end);
  if (start === cue.start && end === cue.end) return s;
  const cues = s.cues.slice();
  cues[i] = { ...cue, start, end, edited: true };
  // Dragging on in the same cue: the drag is one undo step (as typing).
  if (op.drag && s.dragging === op.id && s.past.length > 0) return { ...s, cues: cues.sort(byStart), future: [], dirty: true };
  return { ...commit(s, cues), dragging: op.drag ? op.id : null };
}

function split(s: EditorState, op: Extract<EditorOp, { type: 'split'; }>): EditorState {
  const i = s.cues.findIndex((c) => c.id === op.id);
  if (i < 0) return s;
  const cue = s.cues[i]!;
  const at = Math.max(0, Math.min(op.at, cue.text.length));
  const left = normalizeCueText(cue.text.slice(0, at), s.lang);
  const right = normalizeCueText(cue.text.slice(at), s.lang);
  if (left === '' || right === '') return s;
  let cut: number;
  let leftEnd: number;
  let rightStart: number;
  let leftWords: SubtitleWord[] | undefined;
  let rightWords: SubtitleWord[] | undefined;
  // The cut falls between two words: use their times; otherwise (no words, or the cut inside a word) spread by characters.
  let k = -1;
  if (cue.words && cue.words.length > 1) {
    const want = len(compact(cue.text.slice(0, at)));
    let done = 0;
    for (let w = 0; w < cue.words.length; w++) {
      done += len(compact(cue.words[w]!.text));
      if (done === want) { k = w + 1; break; }
      if (done > want) break;
    }
    if (k <= 0 || k >= cue.words.length) k = -1;
  }
  if (k > 0 && cue.words) {
    leftWords = cue.words.slice(0, k);
    rightWords = cue.words.slice(k);
    leftEnd = Math.max(leftWords[k - 1]!.end, cue.start + 1);
    rightStart = Math.min(rightWords[0]!.start, cue.end - 1);
    if (rightStart < leftEnd) rightStart = leftEnd;
  } else {
    const l = len(compact(left));
    const r = len(compact(right));
    cut = cue.start + Math.round(((cue.end - cue.start) * l) / (l + r));
    cut = Math.min(Math.max(cut, cue.start + 1), cue.end - 1);
    leftEnd = cut;
    rightStart = cut;
  }
  if (leftEnd <= cue.start || rightStart >= cue.end) return s;
  const a: SubtitleCue = { ...cue, text: left, end: leftEnd, edited: true };
  const b: SubtitleCue = { id: nextId(s.cues), start: rightStart, end: cue.end, text: right, edited: true };
  if (cue.source) a.source = cue.source;
  delete a.words;
  if (leftWords) a.words = leftWords;
  if (rightWords) b.words = rightWords;
  const cues = s.cues.slice();
  cues.splice(i, 1, a, b);
  return commit(s, cues);
}

function merge(s: EditorState, id: string): EditorState {
  const i = s.cues.findIndex((c) => c.id === id);
  const a = s.cues[i];
  const b = s.cues[i + 1];
  if (!a || !b) return s;
  const text = normalizeCueText(`${flatten(a.text, s.lang)}${joiner(s.lang)}${flatten(b.text, s.lang)}`, s.lang);
  const merged: SubtitleCue = { ...a, text, end: b.end, edited: true };
  delete merged.words;
  if (a.words && b.words && a.words.length + b.words.length <= SUBTITLE_LIMITS.words) merged.words = [...a.words, ...b.words];
  const cues = s.cues.slice();
  cues.splice(i, 2, merged);
  return commit(s, cues, s.selected === b.id ? a.id : s.selected);
}

function add(s: EditorState, at: number): EditorState {
  if (at < 0 || at > s.durationMs) return s;
  if (s.cues.some((c) => at >= c.start && at < c.end)) return s;
  const prev = [...s.cues].reverse().find((c) => c.end <= at);
  const next = s.cues.find((c) => c.start >= at);
  const gapStart = prev ? prev.end : 0;
  const gapEnd = next ? next.start : s.durationMs;
  if (gapEnd - gapStart < MIN_CUE_MS) return s;
  const start = Math.max(gapStart, Math.min(at, gapEnd - NEW_CUE_MS));
  const end = Math.min(start + NEW_CUE_MS, gapEnd);
  const cue: SubtitleCue = { id: nextId(s.cues), start, end, text: NEW_CUE_TEXT, edited: true };
  return commit(s, [...s.cues, cue], cue.id);
}

function replaceAll(s: EditorState, op: Extract<EditorOp, { type: 'replace' }>): EditorState {
  if (op.find === '') return s;
  const re = new RegExp(op.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), op.caseSensitive ? 'gu' : 'giu');
  let changed = false;
  const cues = s.cues.map((c) => {
    const text = normalizeCueText(c.text.replace(re, () => op.with), s.lang);
    if (text === '' || text === c.text) return c;
    changed = true;
    return withText(c, text);
  });
  return changed ? commit(s, cues) : s;
}

export function editorReducer(s: EditorState, op: EditorOp): EditorState {
  switch (op.type) {
    case 'load':
      return { cues: [...op.cues].sort(byStart), past: [], future: [], selected: null, durationMs: op.durationMs, dirty: false, lang: op.lang, typing: null, dragging: null };
    case 'select':
      return op.id === s.selected && s.typing === null && s.dragging === null ? s : { ...s, selected: op.id, typing: null, dragging: null };
    case 'endTyping':
      return s.typing === null ? s : { ...s, typing: null };
    case 'endDrag':
      return s.dragging === null ? s : { ...s, dragging: null };
    case 'duration':
      return op.ms === s.durationMs || !(op.ms > 0) ? s : { ...s, durationMs: Math.round(op.ms) };
    case 'undo': {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return { ...s, cues: prev, past: s.past.slice(0, -1), future: [s.cues, ...s.future], selected: prev.some((c) => c.id === s.selected) ? s.selected : null, dirty: true, typing: null, dragging: null };
    }
    case 'redo': {
      const nxt = s.future[0];
      if (!nxt) return s;
      return { ...s, cues: nxt, past: [...s.past, s.cues].slice(-UNDO_DEPTH), future: s.future.slice(1), selected: nxt.some((c) => c.id === s.selected) ? s.selected : null, dirty: true, typing: null, dragging: null };
    }
    case 'text': {
      const i = s.cues.findIndex((c) => c.id === op.id);
      if (i < 0) return s;
      const text = normalizeCueText(op.text, s.lang);
      // A cue cannot be empty: an empty result changes nothing (delete the cue to remove it).
      if (text === '' || text === s.cues[i]!.text) return s;
      const cues = s.cues.slice();
      cues[i] = withText(s.cues[i]!, text);
      // Typing on in the same cue: the burst is one undo step (the step before it stays the one to go back to).
      if (s.typing === op.id && s.past.length > 0) return { ...s, cues, future: [], dirty: true, dragging: null };
      return { ...commit(s, cues), typing: op.id };
    }
    case 'times': return setTimes(s, op);
    case 'split': return split(s, op);
    case 'merge': return merge(s, op.id);
    case 'add': return add(s, op.at);
    case 'delete': {
      if (!s.cues.some((c) => c.id === op.id)) return s;
      return commit(s, s.cues.filter((c) => c.id !== op.id), s.selected === op.id ? null : s.selected);
    }
    case 'replace': return replaceAll(s, op);
  }
}

export function initialEditorState(): EditorState {
  return { cues: [], past: [], future: [], selected: null, durationMs: 0, dirty: false, lang: 'en', typing: null, dragging: null };
}

/** The warnings of each cue that has any, keyed by cue id. */
export function warningsOf(cues: SubtitleCue[], lang: LocaleTag): Map<string, CueWarning[]> {
  const sorted = [...cues].sort(byStart);
  const out = new Map<string, CueWarning[]>();
  sorted.forEach((c, i) => {
    const w = cueWarnings(c, sorted[i + 1], lang);
    if (w.length > 0) out.set(c.id, w);
  });
  return out;
}

/** The cue on screen at `ms` (its start included, its end not), or null. */
export function cueAt(cues: SubtitleCue[], ms: number): SubtitleCue | null {
  return cues.find((c) => ms >= c.start && ms < c.end) ?? null;
}
