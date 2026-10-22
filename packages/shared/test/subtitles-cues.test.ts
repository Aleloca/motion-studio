import { describe, expect, it } from 'vitest';
import { subtitleCueSchema, alignToScript, buildCues, cueWarnings, mergeKeepingEdited, relocateCues, wrapLines, type SubtitleCue } from '../src/index.ts';

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe('buildCues', () => {
  it('cuts at a sentence end and a 500 ms pause', () => {
    const cues = buildCues({ words: [w('Ciao.', 0, 400), w('come', 450, 700), w('stai', 1300, 1600)] }, 'it');
    expect(cues.map((c) => c.text)).toEqual(['Ciao.', 'come', 'stai']);
    expect(cues.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(cues[2]!.start).toBe(1300);
    // Extended towards 1000 ms, but only into the gap: it stops where the next cue starts.
    expect(cues[0]!.end).toBe(450);
    expect(cues[1]!.end).toBe(1300);
    expect(cues[2]!.end).toBe(2300);
    expect(cues[0]!.words).toEqual([w('Ciao.', 0, 400)]);
  });

  it('puts a 70-char run on two balanced lines of at most 42', () => {
    const text = 'uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici';
    const words = text.split(' ').map((t, i) => w(t, i * 100, i * 100 + 90));
    const cues = buildCues({ words }, 'it');
    expect(cues).toHaveLength(1);
    const lines = cues[0]!.text.split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    expect(Math.abs(lines[0]!.length - lines[1]!.length)).toBeLessThanOrEqual(12);
  });

  it('cuts ja text by characters', () => {
    const lines = wrapLines('あ'.repeat(40), 'ja');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(16);
    const cues = buildCues({ words: [w('あ'.repeat(30), 0, 4000)] }, 'ja');
    expect(cues[0]!.text.split('\n').map((l) => Array.from(l).length)).toEqual([15, 15]);
  });

  it('segments only: splits one long segment over contiguous cues', () => {
    const text = Array.from({ length: 32 }, () => 'abcd').join(' ');
    expect(text.length).toBeGreaterThanOrEqual(150);
    const cues = buildCues({ segments: [w(text, 0, 10000)] }, 'en');
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues[0]!.start).toBe(0);
    expect(cues[cues.length - 1]!.end).toBe(10000);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBe(cues[i - 1]!.end);
  });
});

describe('wrapLines', () => {
  it('hard-splits a word longer than a line', () => {
    const lines = wrapLines('x'.repeat(60), 'it');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    expect(lines.join('')).toBe('x'.repeat(60));
  });
  it('never returns an empty or blank line', () => {
    for (const [t, lang] of [['', 'it'], ['   \n  ', 'it'], ['a  \n\n  b', 'it'], ['x'.repeat(84) + ' y', 'it'], [' あ '.repeat(20), 'ja'], ['x'.repeat(42) + ' ' + 'y'.repeat(42), 'en']] as const) {
      for (const l of wrapLines(t, lang)) expect(l.trim()).not.toBe('');
    }
    expect(wrapLines('  ', 'it')).toEqual([]);
  });
  it('cuts a token too long for any cue over several cues, losing nothing', () => {
    const token = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const cues = buildCues({ words: [w('prima', 0, 500), w(token, 600, 9000), w('dopo', 9100, 9500)] }, 'it');
    for (const c of cues) {
      expect(subtitleCueSchema.safeParse(c).success).toBe(true);
      expect(c.text.split('\n').every((l) => l.trim() !== '')).toBe(true);
    }
    expect(cues.map((c) => c.text.replace(/\n/g, '')).slice(1, -1).join('')).toBe(token);
    expect(cues[0]!.text).toBe('prima');
    expect(cues[cues.length - 1]!.text).toBe('dopo');
  });
});

describe('cueWarnings', () => {
  const cue = (text: string, ms: number): SubtitleCue => ({ id: 'c1', start: 0, end: ms, text });
  it('flags speed, length and overlap', () => {
    expect(cueWarnings(cue('a'.repeat(30), 1000), undefined, 'it')).toContain('tooFast');
    expect(cueWarnings(cue('ok', 500), undefined, 'it')).toContain('tooShort');
    expect(cueWarnings(cue('ok', 8000), undefined, 'it')).toContain('tooLongOnScreen');
    expect(cueWarnings(cue('ok', 2000), { id: 'c2', start: 1500, end: 3000, text: 'x' }, 'it')).toContain('overlap');
    expect(cueWarnings(cue('a b '.repeat(30), 20000), undefined, 'it')).toContain('tooLong');
  });
  it('is empty for a clean cue', () => {
    expect(cueWarnings(cue('Ciao a tutti', 2000), { id: 'c2', start: 2000, end: 3000, text: 'x' }, 'it')).toEqual([]);
  });
});

describe('mergeKeepingEdited', () => {
  const edited: SubtitleCue[] = [{ id: 'c1', edited: true, text: 'Motion Studio', start: 0, end: 1000 }];
  const freshCue = (id: string, text: string, start: number, end: number): SubtitleCue => ({
    id, start, end, text, words: text.split(' ').map((t, i, a) => w(t, start + (i * (end - start)) / a.length, start + ((i + 1) * (end - start)) / a.length)),
  });
  it('relocateCues moves every cue it is given (edited or not) to its words, and keeps the ones not found (final review)', () => {
    const mine: SubtitleCue[] = [{ id: 'c1', text: 'Motion Studio', start: 0, end: 1000 }, { id: 'c2', edited: true, text: 'nowhere here', start: 3000, end: 4000 }];
    const out = relocateCues(mine, [freshCue('f1', 'motion studio', 500, 1500)]);
    expect(out.map((c) => [c.id, c.start, c.end, c.edited])).toEqual([['c1', 500, 1500, undefined], ['c2', 3000, 4000, true]]);
  });
  it('keeps an edited cue whose words no longer match', () => {
    const out = mergeKeepingEdited(edited, [freshCue('c1', 'totally other words', 0, 900), freshCue('c2', 'later text', 2000, 3000)]);
    expect(out.map((c) => [c.id, c.text, c.start, c.end])).toEqual([['c1', 'Motion Studio', 0, 1000], ['f1', 'later text', 2000, 3000]]);
    expect(out[0]!.edited).toBe(true);
  });
  it('moves an edited cue to the matching fresh words', () => {
    const out = mergeKeepingEdited(edited, [freshCue('c1', 'motion studio', 500, 1500)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'c1', text: 'Motion Studio', start: 500, end: 1500, edited: true });
  });
  it('drops old unedited cues and never collides an id', () => {
    const old: SubtitleCue[] = [{ id: 'f1', edited: true, text: 'zzz', start: 5000, end: 6000 }, { id: 'c9', text: 'gone', start: 0, end: 900 }];
    const out = mergeKeepingEdited(old, [freshCue('c1', 'new one', 0, 900)]);
    expect(out.map((c) => c.id)).toEqual(['f2', 'f1']);
  });
  it('an edited cue whose FIRST word changed is still found (anchored on a later word), its misheard first word included', () => {
    // The user corrected "Ciao" to "Benvenuti"; the video now starts 1 s later.
    const mine: SubtitleCue[] = [{ id: 'c1', edited: true, text: 'Benvenuti a tutti quanti', start: 0, end: 1400 }];
    const fresh = [freshCue('c1', 'Ciao a tutti quanti', 1000, 2400), freshCue('c2', 'Prenota ora', 3000, 4000)];
    const out = mergeKeepingEdited(mine, fresh);
    expect(out.map((c) => [c.id, c.text, c.start, c.end, c.edited])).toEqual([['c1', 'Benvenuti a tutti quanti', 1000, 2400, true], ['f1', 'Prenota ora', 3000, 4000, undefined]]);
  });
  it('the first word changed and nothing heard before it within a pause: the cue starts on its first word found', () => {
    const mine: SubtitleCue[] = [{ id: 'c1', edited: true, text: 'Oggi prenota in tre tocchi', start: 0, end: 1000 }];
    const out = mergeKeepingEdited(mine, [freshCue('c1', 'Fine.', 0, 400), freshCue('c2', 'prenota in tre tocchi', 2000, 3000)]);
    expect(out.map((c) => [c.id, c.text, c.start, c.end])).toEqual([['f1', 'Fine.', 0, 400], ['c1', 'Oggi prenota in tre tocchi', 2000, 3000]]);
  });
  it('a repeated phrase elsewhere in the video never takes an edited cue: the nearest match wins (review round 1)', () => {
    const fresh = [freshCue('c1', 'Ciao a tutti', 0, 1400), freshCue('c2', 'Prenota ora in tre tocchi', 2000, 5000), freshCue('c3', 'grazie a tutti', 8000, 9400)];
    const mine: SubtitleCue[] = [{ id: 'e1', edited: true, text: 'Salve a tutti', start: 8000, end: 9400 }];
    const out = mergeKeepingEdited(mine, fresh);
    expect(out.map((c) => [c.id, c.text, c.start, c.end])).toEqual([
      ['f1', 'Ciao a tutti', 0, 1400], ['f2', 'Prenota ora in tre tocchi', 2000, 5000], ['e1', 'Salve a tutti', 8000, 9400],
    ]);
  });
  it('a match far from the cue\'s old time is not taken: the cue keeps its times', () => {
    const mine: SubtitleCue[] = [{ id: 'e1', edited: true, text: 'Benvenuti a tutti quanti', start: 0, end: 1400 }];
    const out = mergeKeepingEdited(mine, [freshCue('c1', 'Ciao a tutti quanti', 30_000, 31_400)]);
    expect(out.map((c) => [c.id, c.start, c.end])).toEqual([['e1', 0, 1400], ['f1', 30_000, 31_400]]);
  });
  it('words of two letters or fewer alone never place a cue', () => {
    const mine: SubtitleCue[] = [{ id: 'e1', edited: true, text: 'Io e te', start: 0, end: 1000 }];
    const out = mergeKeepingEdited(mine, [freshCue('c1', 'io e lui', 500, 1500)]);
    // Not placed: it stays where it was, and the fresh cue over it is dropped as always.
    expect(out.map((c) => [c.id, c.start, c.end])).toEqual([['e1', 0, 1000]]);
  });
  it('a corrected last word never takes the first word of the next fresh cue', () => {
    const mine: SubtitleCue[] = [{ id: 'e1', edited: true, text: 'Prenota ora in tre posti', start: 0, end: 1000 }];
    const out = mergeKeepingEdited(mine, [freshCue('c1', 'prenota ora in tre', 2000, 3000), freshCue('c2', 'tocchi adesso', 3000, 4000)]);
    expect(out.map((c) => [c.id, c.text, c.start, c.end])).toEqual([['e1', 'Prenota ora in tre posti', 2000, 3000], ['f1', 'tocchi adesso', 3000, 4000]]);
  });
  it('still needs 60 % of the words in order: an edit that changed more stays where it was', () => {
    const mine: SubtitleCue[] = [{ id: 'c1', edited: true, text: 'Salve a voi gente', start: 0, end: 1400 }];
    const out = mergeKeepingEdited(mine, [freshCue('c1', 'Ciao a tutti quanti', 1000, 2400)]);
    expect(out.map((c) => [c.id, c.text, c.start, c.end])).toEqual([['c1', 'Salve a voi gente', 0, 1400]]);
  });
});

describe('alignToScript', () => {
  const heard = [w('motion', 0, 400), w('studia', 400, 800), w('is', 800, 900), w('grate', 900, 1400)];
  const span = { start: 0, end: 1400 };
  it('takes the script words with the heard times', () => {
    const out = alignToScript(heard, 'Motion Studio is great!', span);
    expect(out.map((x) => x.text)).toEqual(['Motion', 'Studio', 'is', 'great!']);
    expect(out.map((x) => [x.start, x.end])).toEqual([[0, 400], [400, 800], [800, 900], [900, 1400]]);
  });
  it('puts an extra script word between its neighbours', () => {
    const out = alignToScript(heard, 'Motion Studio is really great!', span);
    expect(out.map((x) => x.text)).toEqual(['Motion', 'Studio', 'is', 'really', 'great!']);
    expect(out[3]!.start).toBeGreaterThanOrEqual(900);
    expect(out[3]!.end).toBeLessThanOrEqual(900);
  });
  it('spreads over the span when nothing was heard', () => {
    const out = alignToScript([], 'a b', { start: 1000, end: 2000 });
    expect(out.map((x) => [x.start, x.end])).toEqual([[1000, 1500], [1500, 2000]]);
  });
  it('ignores heard words outside the span', () => {
    const out = alignToScript([w('x', 0, 100), ...heard.map((h) => ({ ...h, start: h.start + 1000, end: h.end + 1000 }))], 'Motion Studio is great', { start: 1000, end: 2400 });
    expect(out[0]).toMatchObject({ text: 'Motion', start: 1000 });
  });
});

describe('Korean keeps its spaces', () => {
  it('cuts Korean at its words and joins them with spaces', () => {
    const k = (text: string, start: number, end: number) => ({ text, start, end });
    const cues = buildCues({ words: [k('안녕하세요', 0, 600), k('여러분', 700, 1200), k('반갑습니다.', 1300, 2000)] }, 'ko');
    expect(cues.map((c) => c.text)).toEqual(['안녕하세요 여러분 반갑습니다.']);
    expect(wrapLines('안녕하세요 여러분', 'ko')).toEqual(['안녕하세요 여러분']);
    expect(buildCues({ segments: [k('안녕하세요 여러분', 0, 2000)] }, 'ko').map((c) => c.text)).toEqual(['안녕하세요 여러분']);
  });
});
