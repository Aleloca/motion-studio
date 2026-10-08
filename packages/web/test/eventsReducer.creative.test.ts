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
    s = eventsReducer(s, { type: 'snapshot', jobs: [], approvals: [], locale: 'it', languageSetting: 'system' });
    expect(s.creativeTicks).toEqual({ 'acme/c1': 2, 'acme/c2': 2 });
  });
});

describe('brand and library messages', () => {
  it('bump per-project ticks', () => {
    let s = eventsReducer(initialEventsState, { type: 'brand', project: 'acme' });
    s = eventsReducer(s, { type: 'library', project: 'acme' });
    s = eventsReducer(s, { type: 'brand', project: 'acme' });
    expect(s.projectTicks).toEqual({ 'acme': 3 });
  });
  it('a snapshot bumps every known project tick', () => {
    let s = eventsReducer(initialEventsState, { type: 'brand', project: 'acme' });
    s = eventsReducer(s, { type: 'library', project: 'other' });
    s = eventsReducer(s, { type: 'snapshot', jobs: [], approvals: [], locale: 'it', languageSetting: 'system' });
    expect(s.projectTicks).toEqual({ 'acme': 2, 'other': 2 });
  });
});
