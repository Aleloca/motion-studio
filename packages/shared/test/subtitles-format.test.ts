import { describe, expect, it } from 'vitest';
import {
  ISO639_2, SUBTITLES_SCHEMA_ID, SUBTITLE_LIMITS, SUBTITLES_DIR, fromSrt, fromVtt, parseSubtitleSet, subtitleLangOf, subtitleSetHash,
  subtitleSetSchema, subtitleSetText, subtitlesJobKey, toSrt, toVtt, SUPPORTED_LOCALES, type SubtitleSet,
} from '../src/index.ts';

const set = (over: Record<string, unknown> = {}) => ({
  $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
  timing: { version: 1, format: 'main', fingerprint: 'a'.repeat(64) },
  cues: [{ id: 'c1', start: 0, end: 1000, text: 'Ciao' }, { id: 'c2', start: 1000, end: 2000, text: 'a\nb' }],
  ...over,
});

describe('subtitleSetSchema', () => {
  it('accepts a valid set', () => { expect(subtitleSetSchema.safeParse(set()).success).toBe(true); });
  it('refuses end <= start', () => {
    expect(subtitleSetSchema.safeParse(set({ cues: [{ id: 'c1', start: 5, end: 5, text: 'x' }] })).success).toBe(false);
  });
  it('refuses a third text line', () => {
    expect(subtitleSetSchema.safeParse(set({ cues: [{ id: 'c1', start: 0, end: 5, text: 'a\nb\nc' }] })).success).toBe(false);
  });
  it('refuses an empty or blank line (a blank line ends an SRT cue)', () => {
    for (const text of ['a\n', '\nb', 'a\n  ', ' ', '\t', 'a\n ']) {
      expect(subtitleSetSchema.safeParse(set({ cues: [{ id: 'c1', start: 0, end: 5, text }] })).success, JSON.stringify(text)).toBe(false);
    }
    expect(subtitleSetSchema.safeParse(set({ cues: [{ id: 'c1', start: 0, end: 5, text: ' a\nb ' }] })).success).toBe(true);
  });
  it('refuses duplicate ids', () => {
    expect(subtitleSetSchema.safeParse(set({ cues: [{ id: 'c1', start: 0, end: 5, text: 'a' }, { id: 'c1', start: 6, end: 9, text: 'b' }] })).success).toBe(false);
  });
  it('refuses unsorted cues', () => {
    expect(subtitleSetSchema.safeParse(set({ cues: [{ id: 'c1', start: 6, end: 9, text: 'a' }, { id: 'c2', start: 0, end: 5, text: 'b' }] })).success).toBe(false);
  });
  it('requires sourceLang iff translation', () => {
    expect(subtitleSetSchema.safeParse(set({ origin: 'translation' })).success).toBe(false);
    expect(subtitleSetSchema.safeParse(set({ origin: 'translation', sourceLang: 'en' })).success).toBe(true);
    expect(subtitleSetSchema.safeParse(set({ sourceLang: 'en' })).success).toBe(false);
  });
  it('refuses word ends before starts, unknown keys and a bad fingerprint', () => {
    const cue = { id: 'c1', start: 0, end: 5, text: 'a' };
    expect(subtitleSetSchema.safeParse(set({ cues: [{ ...cue, words: [{ start: 3, end: 2, text: 'a' }] }] })).success).toBe(false);
    expect(subtitleSetSchema.safeParse(set({ cues: [{ ...cue, extra: 1 }] })).success).toBe(false);
    expect(subtitleSetSchema.safeParse(set({ timing: { version: 1, format: 'main', fingerprint: 'zz' } })).success).toBe(false);
  });
  it('round-trips through text and hashes it', () => {
    const s = subtitleSetSchema.parse(set()) as SubtitleSet;
    const t = subtitleSetText(s);
    expect(t.endsWith('}\n')).toBe(true);
    expect(parseSubtitleSet(t)).toEqual(s);
    expect(parseSubtitleSet('nope')).toBeNull();
    expect(subtitleSetHash(s)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('constants and languages', () => {
  it('has the limits, dir and job key', () => {
    expect(SUBTITLE_LIMITS).toEqual({ cues: 2000, words: 60, text: 200, fileBytes: 1_048_576 });
    expect(SUBTITLES_DIR).toBe('subtitles');
    expect(subtitlesJobKey('r', 'p', 'c')).toBe('subtitles:r:p:c');
  });
  it('maps every supported locale to ISO 639-2', () => {
    for (const l of SUPPORTED_LOCALES) expect(ISO639_2[l.tag]).toMatch(/^[a-z]{3}$/);
    expect(ISO639_2['zh-Hant']).toBe('zho');
  });
  it('subtitleLangOf', () => {
    expect(subtitleLangOf('zh')).toBe('zh-Hans');
    expect(subtitleLangOf('no')).toBe('nb');
    expect(subtitleLangOf('nn')).toBe('nb');
    expect(subtitleLangOf('it')).toBe('it');
    expect(subtitleLangOf('ar')).toBeNull();
    expect(subtitleLangOf(null)).toBeNull();
  });
  it('subtitleLangOf reads the 3-letter codes (ElevenLabs Scribe: ISO 639-3, also 639-2/B), any case', () => {
    const cases: Array<[string, string]> = [
      ['eng', 'en'], ['ITA', 'it'], ['fra', 'fr'], ['fre', 'fr'], ['deu', 'de'], ['ger', 'de'], ['spa', 'es'], ['por', 'pt'], ['nld', 'nl'],
      ['dut', 'nl'], ['swe', 'sv'], ['dan', 'da'], ['nob', 'nb'], ['nor', 'nb'], ['nno', 'nb'], ['fin', 'fi'], ['pol', 'pl'], ['ces', 'cs'],
      ['cze', 'cs'], ['hun', 'hu'], ['ron', 'ro'], ['rum', 'ro'], ['cat', 'ca'], ['ell', 'el'], ['gre', 'el'], ['rus', 'ru'], ['ukr', 'uk'],
      ['tur', 'tr'], ['ind', 'id'], ['vie', 'vi'], ['zho', 'zh-Hans'], ['chi', 'zh-Hans'], ['cmn', 'zh-Hans'], ['jpn', 'ja'], ['kor', 'ko'],
      ['hin', 'hi'], ['tha', 'th'], ['IT', 'it'], ['zh-hans', 'zh-Hans'], ['ZH-HANT', 'zh-Hant'],
    ];
    for (const [code, tag] of cases) expect([code, subtitleLangOf(code)]).toEqual([code, tag]);
    expect(subtitleLangOf('ara')).toBeNull();
    expect(subtitleLangOf('italian')).toBeNull();
  });
});

describe('SRT and VTT', () => {
  const cues = [{ id: 'a', start: 1000, end: 3500, text: 'Ciao' }];
  it('toSrt', () => { expect(toSrt(cues, { durationMs: 10_000 })).toBe('1\n00:00:01,000 --> 00:00:03,500\nCiao\n\n'); });
  it('toSrt clamps and drops cues past durationMs', () => {
    const out = toSrt([{ id: 'a', start: 2500, end: 4000, text: 'x' }, { id: 'b', start: 3000, end: 4000, text: 'y' }], { durationMs: 3000 });
    expect(out).toBe('1\n00:00:02,500 --> 00:00:03,000\nx\n\n');
  });
  it('toVtt escapes', () => {
    const out = toVtt([{ id: 'a', start: 0, end: 1000, text: 'a --> b <i>&' }], { durationMs: 5000 });
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).toContain('00:00:00.000 --> 00:00:01.000');
    expect(out).toContain('a --&gt; b &lt;i&gt;&amp;');
  });
  it('round-trips, two-line cue included', () => {
    const x = [{ id: 'a', start: 1000, end: 3500, text: 'Ciao\nmondo' }, { id: 'b', start: 3600, end: 3_725_001, text: 'Fine' }];
    const want = x.map(({ start, end, text }) => ({ start, end, text }));
    expect(fromSrt(toSrt(x, { durationMs: 4_000_000 }))).toEqual(want);
    expect(fromVtt(toVtt(x, { durationMs: 4_000_000 }))).toEqual(want);
  });
  it('fromVtt unescapes text', () => {
    const x = [{ id: 'a', start: 0, end: 1000, text: 'a --> b <i>&' }];
    expect(fromVtt(toVtt(x, { durationMs: 5000 }))?.[0]?.text).toBe('a --> b <i>&');
  });
  it('reads CRLF and a BOM', () => {
    const t = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nCiao\r\n\r\n';
    expect(fromSrt(t)).toEqual([{ start: 1000, end: 2000, text: 'Ciao' }]);
    expect(fromVtt('\uFEFFWEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nCiao\r\n')).toEqual([{ start: 1000, end: 2000, text: 'Ciao' }]);
  });
  it('returns null on garbage', () => {
    expect(fromSrt('hello')).toBeNull();
    expect(fromVtt('hello')).toBeNull();
  });
  it('never emits CRLF', () => {
    expect(toSrt([{ id: 'a', start: 0, end: 5, text: 'a\r\nb' }], { durationMs: 10 })).not.toContain('\r');
  });
});
