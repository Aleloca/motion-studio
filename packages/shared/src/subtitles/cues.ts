// Cutting words into cues, the cue warnings, and the merge that keeps what the user edited (decisions 1636-1644).
import type { LocaleTag } from '../localization/locales.ts';
import type { SubtitleCue, SubtitleSet, SubtitleWord } from './schema.ts';

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

/** The fresh words of a set of cues (the cues' own words, or their text spread over their time by characters), each with its cue's index. */
function freshWords(fresh: SubtitleCue[]): { words: SubtitleWord[]; cueOf: number[] } {
  const words: SubtitleWord[] = [];
  const cueOf: number[] = [];
  fresh.forEach((c, k) => {
    const before = words.length;
    if (c.words && c.words.length > 0) words.push(...c.words);
    else {
      const parts = c.text.split(/\s+/).filter((p) => p !== '');
      const total = parts.reduce((n, p) => n + len(p), 0);
      let done = 0;
      for (const p of parts) {
        const start = c.start + Math.round(((c.end - c.start) * done) / total);
        done += len(p);
        words.push({ start, end: c.start + Math.round(((c.end - c.start) * done) / total), text: p });
      }
    }
    for (let i = before; i < words.length; i++) cueOf.push(k);
  });
  return { words, cueOf };
}

/** How far from its old start an edited cue may move (review round 1 of Task 14): max(10 s, twice its length). */
const moveLimitMs = (cue: SubtitleCue): number => Math.max(10_000, 2 * (cue.end - cue.start));
/** Words this short ("a", "di", "e") are too common to place a cue by themselves. */
const isShort = (token: string): boolean => len(token) <= 2;

/**
 * Where the words of an edited cue are in the fresh words, or null (it keeps its times). Any of its words may be the anchor
 * (the user often corrects the first one): from each place the anchor is heard, the words after it are looked for forward and
 * the words before it backward. A place counts when at least 60 % of the words are found in order, at least one of them
 * longer than two characters, and it starts within `moveLimitMs` of the cue's old start; the most words found wins, then the
 * nearest to the old start. Words of the cue not found at its edges (the ones the user corrected) take the fresh words heard
 * right there in the same fresh cue, as long as no pause comes between (decisions 1713, 1717).
 */
function locate(cue: SubtitleCue, tokens: string[], fresh: { words: SubtitleWord[]; cueOf: number[] }, norm: string[], rules: SubtitleRules = SUBTITLE_RULES): { start: number; end: number } | null {
  const fw = fresh.words;
  const wanted = tokens.map(normalizeToken).filter((t) => t !== '');
  if (wanted.length === 0) return null;
  const reach = wanted.length * 2 + 4;
  const limit = moveLimitMs(cue);
  let best: { count: number; distance: number; first: number; last: number; lead: number; trail: number } | null = null;
  for (let a = 0; a < wanted.length; a++) {
    for (let s = 0; s < fw.length; s++) {
      if (norm[s] !== wanted[a]) continue;
      let count = 1;
      let long = isShort(wanted[a]!) ? 0 : 1;
      let first = s, last = s, firstAt = a, lastAt = a;
      const hi = Math.min(fw.length, s + reach);
      for (let i = a + 1, p = s + 1; i < wanted.length; i++) {
        let q = p;
        while (q < hi && norm[q] !== wanted[i]) q++;
        if (q < hi) { count++; if (!isShort(wanted[i]!)) long++; last = q; lastAt = i; p = q + 1; }
      }
      const lo = Math.max(0, s - reach);
      for (let i = a - 1, p = s - 1; i >= 0; i--) {
        let q = p;
        while (q >= lo && norm[q] !== wanted[i]) q--;
        if (q >= lo) { count++; if (!isShort(wanted[i]!)) long++; first = q; firstAt = i; p = q - 1; }
      }
      if (count / wanted.length < 0.6 || long === 0) continue;
      const distance = Math.abs(fw[first]!.start - cue.start);
      if (distance > limit) continue;
      if (!best || count > best.count || (count === best.count && distance < best.distance)) {
        best = { count, distance, first, last, lead: firstAt, trail: wanted.length - 1 - lastAt };
      }
    }
  }
  if (!best) return null;
  let { first, last } = best;
  const same = (i: number, j: number) => fresh.cueOf[i] === fresh.cueOf[j];
  for (let n = best.lead; n > 0 && first > 0 && same(first - 1, first) && fw[first]!.start - fw[first - 1]!.end < rules.pauseMs; n--) first--;
  for (let n = best.trail; n > 0 && last + 1 < fw.length && same(last, last + 1) && fw[last + 1]!.start - fw[last]!.end < rules.pauseMs; n--) last++;
  return { start: fw[first]!.start, end: Math.max(fw[last]!.end, fw[first]!.start + 1) };
}

/** Each cue (text kept) moved to the fresh words it matches (`locate`); a cue not found keeps its times. */
export function relocateCues(cues: SubtitleCue[], fresh: SubtitleCue[]): SubtitleCue[] {
  const fw = freshWords(fresh);
  const norm = fw.words.map((w) => normalizeToken(w.text));
  return cues.map((c) => {
    const tokens = c.words && c.words.length > 0 ? c.words.map((w) => w.text) : c.text.split(/\s+/);
    const at = locate(c, tokens, fw, norm);
    if (!at) return c;
    const delta = at.start - c.start;
    const moved: SubtitleCue = { ...c, start: at.start, end: at.end };
    if (c.words) moved.words = c.words.map((w) => ({ ...w, start: Math.max(0, w.start + delta), end: Math.max(0, w.end + delta) }));
    return moved;
  });
}

/** The old cues the user edited stay (text kept, times following the fresh words they match); fresh cues over them are dropped. */
export function mergeKeepingEdited(old: SubtitleCue[], fresh: SubtitleCue[]): SubtitleCue[] {
  const kept = relocateCues(old.filter((c) => c.edited), fresh);
  const free = fresh.filter((f) => !kept.some((k) => f.start < k.end && f.end > k.start));
  const used = new Set(kept.map((k) => k.id));
  let n = 0;
  const renamed = free.map((f) => {
    do n++; while (used.has(`f${n}`));
    return { ...f, id: `f${n}` };
  });
  return [...kept, ...renamed].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The translated cues of `target` whose source line changed since they were translated (Task 23, spec §6.5): each cue with a
 * `source` is compared with the source cue it overlaps most in time (ids change when the source is timed again), and is stale
 * when that cue's text differs from its `source.text`, or when no source cue overlaps it any more. A cue without `source` (a
 * line the user added in that language) is never stale. Ids in the target's order.
 */
export function staleCues(target: Pick<SubtitleSet, 'cues'>, source: Pick<SubtitleSet, 'cues'>): string[] {
  const out: string[] = [];
  for (const c of target.cues) {
    if (!c.source) continue;
    const best = sourceCueOf(c, source.cues);
    if (!best || best.text !== c.source.text) out.push(c.id);
  }
  return out;
}

/** A line's text for pairing: words lower-cased, punctuation and spacing aside. */
const pairingText = (text: string) => text.split(/\s+/).map(normalizeToken).filter(Boolean).join(' ');

/**
 * The pairs of `a` and `b` (indexes) that every longest common subsequence of their keys agrees on (Task 25, review round 3):
 * order kept (nothing crosses); a pair two alignments would choose differently (a line repeated) is left out.
 */
function certainPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length, m = b.length, w = m + 1;
  // f: LCS of a[0..i) and b[0..j); g: LCS of a[i..) and b[j..).
  const f = new Uint32Array((n + 1) * w), g = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    f[i * w + j] = a[i - 1] === b[j - 1] ? f[(i - 1) * w + j - 1]! + 1 : Math.max(f[(i - 1) * w + j]!, f[i * w + j - 1]!);
  }
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    g[i * w + j] = a[i] === b[j] ? g[(i + 1) * w + j + 1]! + 1 : Math.max(g[(i + 1) * w + j]!, g[i * w + j + 1]!);
  }
  const total = f[n * w + m]!;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    if (a[i] === b[j] && f[i * w + j]! + 1 + g[(i + 1) * w + j + 1]! === total) pairs.push([i, j]);
  }
  const countA = new Map<number, number>(), countB = new Map<number, number>();
  for (const [i, j] of pairs) { countA.set(i, (countA.get(i) ?? 0) + 1); countB.set(j, (countB.get(j) ?? 0) + 1); }
  const sure = pairs.filter(([i, j]) => countA.get(i) === 1 && countB.get(j) === 1);
  // Kept only when in order with every other sure pair.
  return sure.filter(([i, j]) => sure.every(([k, l]) => (k === i && l === j) || (k < i && l < j) || (k > i && l > j)));
}

/**
 * A translation's cues after its source was made again (Task 25, review round 3): each translated line the user did not
 * correct goes to the line of the source now (`after`) with its own source text (`source.text`, normalised), by an
 * order-keeping alignment of the whole sequences (`certainPairs`: a repeated line pairs only when unambiguous), and takes its
 * times. Never by id (the ids of uncorrected source lines are recycled) nor by position: a wrong move is worse than none. A
 * line with no partner keeps its times, and so does a line whose move would overlap a line left in place. A corrected line
 * keeps its times (anti-goal 1). Texts untouched; sorted by time. `complete`: every uncorrected line moved to its partner
 * (or `before` is `after`'s lines as they were, "Tempi controllati": nothing moves, and it follows); when false, the
 * translation does not claim its source's timing.
 */
export function followSourceTimes(cues: readonly SubtitleCue[], before: readonly SubtitleCue[], after: readonly SubtitleCue[]): { cues: SubtitleCue[]; complete: boolean } {
  const unchanged = before.length === after.length
    && before.every((c, i) => { const d = after[i]!; return c.id === d.id && c.start === d.start && c.end === d.end && c.text === d.text; });
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  if (unchanged) return { cues: sorted, complete: true };
  const free = sorted.filter((c) => !c.edited && c.source);
  const pairs = certainPairs(free.map((c) => pairingText(c.source!.text)), after.map((c) => pairingText(c.text)));
  const target = new Map(pairs.map(([i, j]) => [free[i]!.id, after[j]!]));
  const moved = new Set<string>();
  let out = sorted.map((c) => {
    const to = target.get(c.id);
    if (!to) return c;
    moved.add(c.id);
    return { ...c, start: to.start, end: to.end };
  });
  // A moved line never overlaps one left in place: it stays (until nothing changes, as one put back may meet another).
  for (let again = true; again;) {
    again = false;
    out = out.map((c, i) => {
      if (!moved.has(c.id)) return c;
      const hits = out.some((d, k) => k !== i && !moved.has(d.id) && c.start < d.end && d.start < c.end);
      if (!hits) return c;
      moved.delete(c.id);
      again = true;
      return sorted.find((x) => x.id === c.id)!;
    });
  }
  const complete = free.every((c) => moved.has(c.id));
  return { cues: out.sort((a, b) => a.start - b.start || a.end - b.end), complete };
}

/** The source cue a translated cue stands for (Task 25): the one it overlaps most in time (the first of equals), or null. */
export function sourceCueOf(cue: Pick<SubtitleCue, 'start' | 'end'>, source: readonly SubtitleCue[]): SubtitleCue | null {
  let best: SubtitleCue | null = null;
  let most = 0;
  for (const s of source) {
    const overlap = Math.min(cue.end, s.end) - Math.max(cue.start, s.start);
    if (overlap > most) { most = overlap; best = s; }
  }
  return best;
}
