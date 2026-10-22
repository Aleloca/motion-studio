import { describe, expect, it } from 'vitest';
import { defaultSubtitleVideo, subtitlesFitVideo } from '../src/index.ts';

describe('defaultSubtitleVideo (Task 27, U8)', () => {
  const locales = { primary: 'it', extra: ['de', 'en'] } as const;
  const set = (lang: 'it' | 'de' | 'en' | 'fr', locale?: 'de') => ({ lang, timing: locale ? { locale } : {} });

  it('a set timed on a language\'s own voice goes on that video; a language with its video on it; any other on the original', () => {
    expect(defaultSubtitleVideo(set('de', 'de'), locales)).toBe('de');
    expect(defaultSubtitleVideo(set('en'), locales)).toBe('en');
    expect(defaultSubtitleVideo(set('fr'), locales)).toBe('it');
    expect(subtitlesFitVideo({ locale: 'de' }, 'it')).toBe(false);
  });

  it('a language with no translation of the format goes on the original (final review Minor 3)', () => {
    const translated = (lang: string) => lang === 'de';
    expect(defaultSubtitleVideo(set('en'), locales, translated)).toBe('it');
    expect(defaultSubtitleVideo(set('de'), locales, translated)).toBe('de');
    // A set of a language's own voice has only that video.
    expect(defaultSubtitleVideo(set('de', 'de'), locales, () => false)).toBe('de');
  });
});
