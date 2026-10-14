import { describe, expect, it } from 'vitest';
import { generalProblems, packLanguageGaps } from '../src/screens/creative/languagesModel.ts';

describe('generalProblems (Q5)', () => {
  const texts = [{ clipId: 'title', name: 'Title' }];
  it('lists the uncoded sentences of an old row next to the coded issues', () => {
    const row = {
      problems: ['The translation of "Title" does not fit its box, even at 100% size', 'An old uncoded sentence', 'Voice of "narration" is too long'],
      issues: [
        { code: 'textOverflow' as const, clipId: 'title', message: 'The translation of "Title" does not fit its box, even at 100% size' },
        { code: 'voiceTooLong' as const, clipId: 'narration', message: 'Voice of "narration" is too long' },
      ],
    };
    expect(generalProblems(row, texts)).toEqual(['Voice of "narration" is too long', 'An old uncoded sentence']);
  });

  it('shows an old uncoded overflow sentence of a shown clip inline, not again in the list', () => {
    const sentence = 'The translation of "Title" does not fit its box, even at 100% size';
    const row = { problems: [sentence, 'Something else'], issues: [{ code: 'assetChanged' as const, message: 'A file changed' }] };
    expect(generalProblems(row, texts)).toEqual(['A file changed', 'Something else']);
  });
});

describe('packLanguageGaps (Q5)', () => {
  const shot = 'appstore-iphone-69', shot2 = 'appstore-iphone-69@2';
  const comp = (format: string) => ({ format });
  const row = (locale: string, instanceId: string, over: Record<string, unknown> = {}) => ({ locale, instanceId, stale: [] as string[], ...over }) as never;
  it('counts only the pack formats of the brief, not other compositions of the version', () => {
    const v = { compositions: [comp(shot), comp(shot2), comp('instagram-post-1x1')], localizations: [row('de', shot), row('de', shot2)] };
    expect(packLanguageGaps([shot, shot2, 'instagram-post-1x1'], v, ['de'])).toEqual({ untranslated: [], review: [] });
  });
  it('marks a language that lacks a pack format, and one with an outdated or problem row for review', () => {
    const v = { compositions: [comp(shot), comp(shot2)], localizations: [
      row('de', shot), row('fr', shot), row('fr', shot2, { stale: ['title'] }), row('ja', shot), row('ja', shot2, { problems: ['x'] }), row('it', shot), row('it', shot2),
    ] };
    expect(packLanguageGaps([shot, shot2], v, ['de', 'fr', 'ja', 'it'])).toEqual({ untranslated: ['de'], review: ['fr', 'ja'] });
  });
});
