// Cutting words into cues, the cue warnings, and the merge that keeps what the user edited (decisions 1636-1644).
import type { LocaleTag } from '../localization/locales.ts';
import type { SubtitleCue, SubtitleWord } from './schema.ts';

export const SUBTITLE_RULES = { maxLines: 2, maxLineChars: 42, cjkLineChars: 16, minMs: 1000, maxMs: 7000, maxCps: 17, pauseMs: 500 } as const;
export type SubtitleRules = typeof SUBTITLE_RULES;

export interface TimedWord { start: number; end: number; text: string }

/** The languages of full-width text: their lines are `cjkLineChars` wide. */
const CJK_LANGS: readonly string[] = ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'th'];
/** Of those, the ones written without spaces between words: cut and joined by characters. Korean has spaces (decision 1701). */
const NO_SPACE_LANGS: readonly string[] = ['zh-Hans', 'zh-Hant', 'ja', 'th'];
const isCjk = (lang: LocaleTag): boolean => CJK_LANGS.includes(lang);
const noSpaces = (lang: LocaleTag): boolean => NO_SPACE_LANGS.includes(lang);
const lineCharsOf = (lang: LocaleTag, rules: SubtitleRules): number => (isCjk(lang) ? rules.cjkLineChars : rules.maxLineChars);
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const MAX_CUE_WORDS = 60;

interface Token { t: string; glued: boolean }

/** Words (cut at spaces, a word longer than a line hard-split) or single characters (CJK), with whether a space goes before. */
function tokenize(text: string, lang: LocaleTag, lineChars: number): Token[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return [];
  if (noSpaces(lang)) return Array.from(flat).map((t) => ({ t, glued: true }));
  const out: Token[] = [];
  for (const word of flat.split(' ')) {
    const chars = Array.from(word);
    for (let i = 0; i < chars.length; i += lineChars) out.push({ t: chars.slice(i, i + lineChars).join(''), glued: i > 0 });
  }
  return out;
}

const sepOf = (lang: LocaleTag): string => (noSpaces(lang) ? '' : ' ');
const len = (s: string): number => Array.from(s).length;

function joinTokens(tokens: Token[], sep: string): string {
  return tokens.reduce((acc, tok, i) => acc + (i > 0 && !tok.glued ? sep : '') + tok.t, '');
}

/** The text on the fewest lines of `lineChars`, balanced when two. Never returns an empty line (a blank line ends an SRT cue). */
export function wrapLines(text: string, lang: LocaleTag, rules: SubtitleRules = SUBTITLE_RULES): string[] {
  const lineChars = lineCharsOf(lang, rules);
  const tokens = tokenize(text, lang, lineChars);
  if (tokens.length === 0) return [];
  const sep = sepOf(lang);
  if (noSpaces(lang)) {
    const n = Math.ceil(tokens.length / lineChars);
    const size = Math.ceil(tokens.length / n);
    const lines: string[] = [];
    for (let i = 0; i < tokens.length; i += size) lines.push(joinTokens(tokens.slice(i, i + size), sep));
    return lines;
  }
  // Greedy fill to learn how many lines are needed.
  const greedy: Token[][] = [];
  let cur: Token[] = [];
  for (const tok of tokens) {
    const next = [...cur, tok];
    if (cur.length > 0 && len(joinTokens(next, sep)) > lineChars) { greedy.push(cur); cur = [{ ...tok, glued: false }]; } else cur = next;
  }
  greedy.push(cur);
  if (greedy.length === 1) return [joinTokens(greedy[0]!, sep)];
  if (greedy.length === 2) {
    // The split that leaves the two lines closest in length, both within a line.
    let best: [string, string] | null = null;
    let bestDiff = Infinity;
    for (let i = 1; i < tokens.length; i++) {
      const a = joinTokens(tokens.slice(0, i), sep);
      const b = joinTokens([{ ...tokens[i]!, glued: false }, ...tokens.slice(i + 1)], sep);
      if (len(a) > lineChars || len(b) > lineChars) continue;
      const diff = Math.abs(len(a) - len(b));
      if (diff < bestDiff) { bestDiff = diff; best = [a, b]; }
    }
    if (best) return best;
  }
  return greedy.map((l) => joinTokens(l, sep)).filter((l) => l.trim() !== '');
}

/** A text of at most `maxLines` lines: any overflow of a pathological word is folded into the last line (the warning `tooLong` tells). */
function cueText(text: string, lang: LocaleTag, rules: SubtitleRules): string {
  const lines = wrapLines(text, lang, rules);
  if (lines.length <= rules.maxLines) return lines.join('\n');
  const head = lines.slice(0, rules.maxLines - 1);
  return [...head, lines.slice(rules.maxLines - 1).join('')].join('\n');
}

const fits = (text: string, lang: LocaleTag, rules: SubtitleRules): boolean => wrapLines(text, lang, rules).length <= rules.maxLines;

function toCue(n: number, start: number, end: number, text: string, words: TimedWord[] | undefined, lang: LocaleTag, rules: SubtitleRules): SubtitleCue {
  const cue: SubtitleCue = { id: `c${n}`, start, end: Math.max(end, start + 1), text: cueText(text, lang, rules) };
  if (words) cue.words = words.map((w) => ({ start: w.start, end: Math.max(w.end, w.start), text: w.text }));
  return cue;
}

/** A cue shorter than `minMs` grows into the gap that follows it, never over the next cue. */
function extendShort(cues: SubtitleCue[], rules: SubtitleRules): SubtitleCue[] {
  return cues.map((c, i) => {
    if (c.end - c.start >= rules.minMs) return c;
    const limit = i + 1 < cues.length ? cues[i + 1]!.start : Infinity;
    return { ...c, end: Math.max(c.end, Math.min(c.start + rules.minMs, limit)) };
  });
}

export function buildCues(input: { words: TimedWord[] } | { segments: TimedWord[] }, lang: LocaleTag, rules: SubtitleRules = SUBTITLE_RULES): SubtitleCue[] {
  const sep = sepOf(lang);
  const cues: SubtitleCue[] = [];
  const push = (start: number, end: number, text: string, words?: TimedWord[]): void => {
    cues.push(toCue(cues.length + 1, start, end, text, words, lang, rules));
  };

  if ('words' in input) {
    let group: TimedWord[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      push(group[0]!.start, group[group.length - 1]!.end, group.map((w) => w.text.trim()).join(sep), group);
      group = [];
    };
    for (const raw of input.words) {
      const w = { ...raw, text: raw.text.trim() };
      if (w.text === '') continue;
      const cap = rules.maxLines * lineCharsOf(lang, rules);
      if (len(w.text) > cap) {
        // A token that cannot fit one cue (a URL, garbage): cut it over cues of one full capacity each, times by characters.
        flush();
        const chars = Array.from(w.text);
        for (let i = 0; i < chars.length; i += cap) {
          const start = w.start + Math.round(((w.end - w.start) * i) / chars.length);
          const end = w.start + Math.round(((w.end - w.start) * Math.min(i + cap, chars.length)) / chars.length);
          const piece = chars.slice(i, i + cap).join('');
          push(start, end, piece, [{ start, end, text: piece }]);
        }
        continue;
      }
      if (group.length > 0) {
        const last = group[group.length - 1]!;
        const text = group.map((x) => x.text).concat(w.text).join(sep);
        if (w.start - last.end >= rules.pauseMs || group.length >= MAX_CUE_WORDS || w.end - group[0]!.start > rules.maxMs || !fits(text, lang, rules)) flush();
      }
      group.push(w);
      if (SENTENCE_END.test(w.text)) flush();
    }
    flush();
  } else {
    for (const seg of input.segments) {
      const tokens = tokenize(seg.text, lang, lineCharsOf(lang, rules));
      if (tokens.length === 0) continue;
      const chunks: string[] = [];
      let cur: Token[] = [];
      for (const tok of tokens) {
        const next = [...cur, tok];
        if (cur.length > 0 && !fits(joinTokens(next, sep), lang, rules)) { chunks.push(joinTokens(cur, sep)); cur = [{ ...tok, glued: false }]; } else cur = next;
      }
      chunks.push(joinTokens(cur, sep));
      const total = chunks.reduce((n, c) => n + len(c), 0);
      const dur = seg.end - seg.start;
      let done = 0;
      let from = seg.start;
      for (const chunk of chunks) {
        done += len(chunk);
        const to = seg.start + Math.round((dur * done) / total);
        push(from, to, chunk);
        from = to;
      }
    }
  }
  return extendShort(cues, rules);
}

export type CueWarning = 'tooLong' | 'tooFast' | 'tooShort' | 'tooLongOnScreen' | 'overlap';

export function cueWarnings(cue: SubtitleCue, next: SubtitleCue | undefined, lang: LocaleTag, rules: SubtitleRules = SUBTITLE_RULES): CueWarning[] {
  const out: CueWarning[] = [];
  const dur = cue.end - cue.start;
  const flat = cue.text.replace(/\s*\n\s*/g, ' ');
  if (wrapLines(flat, lang, rules).length > rules.maxLines) out.push('tooLong');
  if (dur > 0 && len(cue.text.replace(/\n/g, '')) / (dur / 1000) > rules.maxCps) out.push('tooFast');
  if (dur < rules.minMs) out.push('tooShort');
  if (dur > rules.maxMs) out.push('tooLongOnScreen');
  if (next && next.start < cue.end) out.push('overlap');
  return out;
}

export const normalizeToken = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The fresh words of a set of cues: the cues' own words, or their text spread over their time by characters. */
function freshWords(fresh: SubtitleCue[]): SubtitleWord[] {
  const out: SubtitleWord[] = [];
  for (const c of fresh) {
    if (c.words && c.words.length > 0) { out.push(...c.words); continue; }
    const parts = c.text.split(/\s+/).filter((p) => p !== '');
    const total = parts.reduce((n, p) => n + len(p), 0);
    let done = 0;
    for (const p of parts) {
      const start = c.start + Math.round(((c.end - c.start) * done) / total);
      done += len(p);
      out.push({ start, end: c.start + Math.round(((c.end - c.start) * done) / total), text: p });
    }
  }
  return out;
}

/** Where the words of an edited cue are in the fresh words: at least 60 % found in order, or null. */
function locate(tokens: string[], fresh: SubtitleWord[], norm: string[]): { start: number; end: number } | null {
  const wanted = tokens.map(normalizeToken).filter((t) => t !== '');
  if (wanted.length === 0) return null;
  let best: { count: number; first: number; last: number } | null = null;
  for (let s = 0; s < fresh.length; s++) {
    if (norm[s] !== wanted[0]) continue;
    let p = s;
    let count = 0;
    let last = s;
    const limit = Math.min(fresh.length, s + wanted.length * 2 + 4);
    for (const w of wanted) {
      let q = p;
      while (q < limit && norm[q] !== w) q++;
      if (q < limit) { count++; last = q; p = q + 1; }
    }
    if (!best || count > best.count) best = { count, first: s, last };
  }
  if (!best || best.count / wanted.length < 0.6) return null;
  return { start: fresh[best.first]!.start, end: Math.max(fresh[best.last]!.end, fresh[best.first]!.start + 1) };
}

/** The old cues the user edited stay (text kept, times following the fresh words they match); fresh cues over them are dropped. */
export function mergeKeepingEdited(old: SubtitleCue[], fresh: SubtitleCue[]): SubtitleCue[] {
  const fw = freshWords(fresh);
  const norm = fw.map((w) => normalizeToken(w.text));
  const kept: SubtitleCue[] = old.filter((c) => c.edited).map((c) => {
    const tokens = c.words && c.words.length > 0 ? c.words.map((w) => w.text) : c.text.split(/\s+/);
    const at = locate(tokens, fw, norm);
    if (!at) return c;
    const delta = at.start - c.start;
    const moved: SubtitleCue = { ...c, start: at.start, end: at.end };
    if (c.words) moved.words = c.words.map((w) => ({ ...w, start: Math.max(0, w.start + delta), end: Math.max(0, w.end + delta) }));
    return moved;
  });
  const free = fresh.filter((f) => !kept.some((k) => f.start < k.end && f.end > k.start));
  const used = new Set(kept.map((k) => k.id));
  let n = 0;
  const renamed = free.map((f) => {
    do n++; while (used.has(`f${n}`));
    return { ...f, id: `f${n}` };
  });
  return [...kept, ...renamed].sort((a, b) => a.start - b.start || a.end - b.end);
}
