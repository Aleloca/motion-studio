import { describe, expect, it } from 'vitest';
import { FALLBACK_FONT_BY_SCRIPT, RTL_LOCALES, SUPPORTED_LOCALES, isRtlLocale, localizationSchema } from '../src/index.ts';

const base = { $schema: 'motion-studio/localization@1', locale: 'de', instanceId: 'instagram-post-1x1@2', texts: {}, params: {}, voices: {}, fit: {}, fonts: [] };

describe('localizationSchema', () => {
  it('accepts a full overlay', () => {
    const o = {
      ...base,
      texts: { title: { source: 'Book now', text: 'Jetzt buchen' } },
      params: { 'layer-1.headline': { source: 'Hi', text: 'Hallo' } },
      voices: { vo: { src: 'assets/vo-de.mp3', sourceScript: 'Hello', script: 'Hallo' } },
      fit: { title: 0.8 },
      fonts: [{ family: 'Noto Sans JP', files: ['assets/noto-jp.ttf'] }],
    };
    expect(localizationSchema.parse(o)).toEqual(o);
  });
  it('refuses extra keys at every level', () => {
    expect(localizationSchema.safeParse({ ...base, x: 1 }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, texts: { t: { source: 'a', text: 'b', color: '#fff' } } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, params: { 'a.b': { source: 'a', text: 'b', extra: 1 } } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, voices: { v: { src: 'assets/a.mp3', sourceScript: '', script: '', volume: 1 } } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, fonts: [{ family: 'A', files: ['assets/a.ttf'], weight: 700 }] }).success).toBe(false);
  });
  it('refuses a missing section, a wrong tag or instance id', () => {
    const { fit: _fit, ...noFit } = base;
    expect(localizationSchema.safeParse(noFit).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, locale: 'ar' }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, instanceId: 'x@1' }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, $schema: 'other' }).success).toBe(false);
  });
  it('bounds fit, lengths and voice/font paths', () => {
    expect(localizationSchema.safeParse({ ...base, fit: { t: 0.69 } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, fit: { t: 1.01 } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, fit: { t: 0.7 } }).success).toBe(true);
    expect(localizationSchema.safeParse({ ...base, texts: { t: { source: 'a', text: 'x'.repeat(2001) } } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, texts: { 'Bad Id': { source: 'a', text: 'b' } } }).success).toBe(false);
    expect(localizationSchema.safeParse({ ...base, params: { nodot: { source: 'a', text: 'b' } } }).success).toBe(false);
    for (const src of ['../assets/a.mp3', 'assets/../x.mp3', 'layers/a.html', '/etc/passwd', 'https://x/a.mp3', 'assets\\a.mp3'])
      expect(localizationSchema.safeParse({ ...base, voices: { v: { src, sourceScript: '', script: '' } } }).success, src).toBe(false);
    expect(localizationSchema.safeParse({ ...base, fonts: [{ family: 'A', files: ['layers/a.ttf'] }] }).success).toBe(false);
    const f = { family: 'A', files: ['assets/a.ttf'] };
    expect(localizationSchema.safeParse({ ...base, fonts: [f, f, f, f] }).success).toBe(false);
  });
});

describe('locales', () => {
  it('is a curated left-to-right list with the required languages', () => {
    const tags: string[] = SUPPORTED_LOCALES.map((l) => l.tag);
    for (const t of ['en', 'it', 'fr', 'de', 'es', 'pt', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'hi', 'th', 'vi', 'id', 'tr', 'ru', 'uk']) expect(tags).toContain(t);
    expect(new Set(tags).size).toBe(tags.length);
    expect(SUPPORTED_LOCALES.every((l) => !l.rtl)).toBe(true);
    for (const r of RTL_LOCALES) { expect(tags).not.toContain(r); expect(isRtlLocale(r)).toBe(true); }
  });
  it('maps each non-latin/cyrillic/greek script to a Noto family', () => {
    for (const l of SUPPORTED_LOCALES) {
      if (['latin', 'cyrillic', 'greek'].includes(l.script)) expect(FALLBACK_FONT_BY_SCRIPT[l.script]).toBeUndefined();
      else expect(FALLBACK_FONT_BY_SCRIPT[l.script], l.tag).toMatch(/^Noto Sans /);
    }
    expect(FALLBACK_FONT_BY_SCRIPT.jp).toBe('Noto Sans JP');
    expect(FALLBACK_FONT_BY_SCRIPT['han-sc']).toBe('Noto Sans SC');
  });
});
