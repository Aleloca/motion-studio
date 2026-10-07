import { describe, expect, it } from 'vitest';
import { eventsReducer, initialEventsState } from '../src/eventsReducer.ts';

describe('creative messages', () => {
  it('bump a per-creative tick', () => {
    let s = eventsReducer(initialEventsState, { type: 'creative', project: 'acme', creative: 'c1' });
    s = eventsReducer(s, { type: 'creative', project: 'acme', creative: 'c1' });
    expect(s.creativeTicks).toEqual({ 'acme/c1': 2 });
  });
  it('a snapshot (reconnection) bumps every known creative tick', () => {
    let s = eventsReducer(initialEventsState, { type: 'creative', project: 'acme', creative: 'c1' });
    s = eventsReducer(s, { type: 'creative', project: 'acme', creative: 'c2' });
    s = eventsReducer(s, { type: 'snapshot', jobs: [] });
    expect(s.creativeTicks).toEqual({ 'acme/c1': 2, 'acme/c2': 2 });
  });
});
