import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { chatTick, useGroupChat } from '../src/screens/variants/useGroupChat.ts';
import { detailFor, groupOf, HOST, version } from './support/variants.ts';

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;

describe('useGroupChat', () => {
  it('review minor 6: outside a group the page is still its own variant (a host whose group is gone keeps stamped entries)', () => {
    const { result } = renderHook(() => useGroupChat(live, 'acme', HOST, detailFor(HOST, [version(1)], null)));
    expect(result.current.self).toBe('a');
    const orphan = renderHook(() => useGroupChat(live, 'acme', `${HOST}~c`, detailFor(`${HOST}~c`, [version(1)], null)));
    expect(orphan.result.current.self).toBe('c');
  });
  it('the other members\' turns carry their variant (review minor 8)', () => {
    const jobs = { jb: { id: 'jb', key: `creative:/w:acme:${HOST}~b`, kind: 'creative', label: 'x', state: 'running', createdAt: '2026-10-08T10:00:00.000Z' } };
    const { result } = renderHook(() => useGroupChat({ ...live, jobs } as unknown as EventsState, 'acme', HOST, detailFor(HOST, [version(1)], groupOf(['a', 'b']))));
    expect(result.current.memberJobs.map((m) => [m.job.id, m.variant])).toEqual([['jb', 'b']]);
  });
  it('chatTick sums the host\'s and its sisters\' ticks, any id length', () => {
    expect(chatTick({ [`acme/${HOST}`]: 1, [`acme/${HOST}~aa`]: 2, [`acme/${HOST}-2`]: 5 }, 'acme', `${HOST}~b`)).toBe(3);
  });
});
