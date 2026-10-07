import { describe, expect, it } from 'vitest';
import { eventsReducer, initialEventsState } from '../src/eventsReducer.ts';

describe('creative messages', () => {
  it('bump a per-creative tick', () => {
    let s = eventsReducer(initialEventsState, { type: 'creative', project: 'acme', creative: 'c1' });
    s = eventsReducer(s, { type: 'creative', project: 'acme', creative: 'c1' });
    expect(s.creativeTicks).toEqual({ 'acme/c1': 2 });
  });
});
