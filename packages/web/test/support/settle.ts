// Waits until what `read` returns stops changing (a few polls in a row), instead of a fixed sleep: the page has "settled".
import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';

export async function settled(read: () => string, o: { polls?: number; timeout?: number } = {}): Promise<void> {
  const polls = o.polls ?? 4;
  let last: string | null = null;
  let same = 0;
  await waitFor(() => {
    const cur = read();
    same = cur === last ? same + 1 : 0;
    last = cur;
    expect(same).toBeGreaterThanOrEqual(polls);
  }, { timeout: o.timeout ?? 5000, interval: 40 });
}
