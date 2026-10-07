import type { JobSummary } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { eventsReducer, initialEventsState, sessionIdOf } from '../src/eventsReducer.ts';

const job = (id: string, state: JobSummary['state']): JobSummary => ({ id, key: 'k', label: 'l', state, createdAt: '2026-10-07T10:00:00.000Z' });

describe('eventsReducer', () => {
  it('replaces jobs on snapshot and keeps events', () => {
    let s = eventsReducer(initialEventsState, { type: 'agent', jobId: 'a', event: { kind: 'text', text: 'hi' } });
    s = eventsReducer(s, { type: 'snapshot', jobs: [job('a', 'running')], approvals: [] });
    expect(s.jobs).toEqual({ a: job('a', 'running') });
    expect(s.events.a).toHaveLength(1);
  });
  it('upserts jobs and appends events per job', () => {
    let s = eventsReducer(initialEventsState, { type: 'job', job: job('a', 'queued') });
    s = eventsReducer(s, { type: 'job', job: job('a', 'running') });
    s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'session', sessionId: 's1' } });
    s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'text', text: 'x' } });
    expect(s.jobs.a?.state).toBe('running');
    expect(s.events.a?.map((e) => e.kind)).toEqual(['session', 'text']);
  });
  it('caps stored events per job at 2000', () => {
    let s = initialEventsState;
    for (let i = 0; i < 2010; i++) s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'text', text: String(i) } });
    expect(s.events.a).toHaveLength(2000);
    expect(s.events.a?.[0]).toEqual({ kind: 'text', text: '10' });
  });
});

describe('project ticks', () => {
  it('bumps the project tick on project, brand and library messages', () => {
    let s = eventsReducer(initialEventsState, { type: 'project', project: 'acme' });
    s = eventsReducer(s, { type: 'brand', project: 'acme' });
    expect(s.projectTicks.acme).toBe(2);
  });
});

describe('sessionIdOf', () => {
  it('prefers the result session id, then the session event', () => {
    expect(sessionIdOf([{ kind: 'session', sessionId: 's1' }])).toBe('s1');
    expect(sessionIdOf([{ kind: 'session', sessionId: 's1' }, { kind: 'result', ok: true, sessionId: 's2' }])).toBe('s2');
    expect(sessionIdOf([])).toBeUndefined();
  });
});

describe('approvals', () => {
  const approval = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: null, kind: 'tool' as const, title: 't', detail: 'd', toolName: 'Bash', alwaysRule: null, createdAt: 'x', expiresAt: 'y' };
  it('tracks pending approvals from snapshot, add and resolve', () => {
    let s = eventsReducer(initialEventsState, { type: 'snapshot', jobs: [], approvals: [approval] });
    expect(Object.keys(s.approvals)).toEqual(['a1']);
    s = eventsReducer(s, { type: 'approval_resolved', id: 'a1', decision: 'deny' });
    expect(s.approvals).toEqual({});
    s = eventsReducer(s, { type: 'approval', approval: { ...approval, id: 'a2' } });
    expect(Object.keys(s.approvals)).toEqual(['a2']);
  });
});
