import { describe, expect, it } from 'vitest';
import { slugTitle } from '../src/shell/TopBars.tsx';

describe('slugTitle (review minor 5)', () => {
  it('drops any variant id, one letter or more (decision 978)', () => {
    expect(slugTitle('2026-10-17-create-a-60-second~b')).toBe('Create a 60 second');
    expect(slugTitle('2026-10-17-create-a-60-second~aa')).toBe('Create a 60 second');
    expect(slugTitle('2026-10-17-promo')).toBe('Promo');
  });
});
