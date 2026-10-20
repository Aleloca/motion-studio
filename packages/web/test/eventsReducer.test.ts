import type { JobSummary } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { BRIEF_FILLS_KEPT, eventsReducer, initialEventsState, sessionIdOf } from '../src/eventsReducer.ts';

const job = (id: string, state: JobSummary['state']): JobSummary => ({ id, key: 'k', kind: 'creative', label: 'l', state, createdAt: '2026-10-07T10:00:00.000Z' });

describe('eventsReducer', () => {
  it('replaces jobs on snapshot and keeps events', () => {
    let s = eventsReducer(initialEventsState, { type: 'agent', jobId: 'a', event: { kind: 'text', text: 'hi' } });
    s = eventsReducer(s, { type: 'snapshot', jobs: [job('a', 'running')], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
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
  it('keeps only the latest live usage per job, outside the capped events', () => {
    const tokens = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 });
    let s = eventsReducer(initialEventsState, { type: 'agent', jobId: 'a', event: { kind: 'text', text: 'real' } });
    for (let i = 1; i <= 3000; i++) s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'usage', live: true, tokens: tokens(i), costUsd: null } });
    expect(s.events.a).toEqual([{ kind: 'text', text: 'real' }]);
    expect(s.liveUsage?.a).toEqual({ kind: 'usage', live: true, tokens: tokens(3000), costUsd: null });
    s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'usage', live: false, tokens: tokens(5), costUsd: 0.1 } });
    expect(s.events.a?.map((e) => e.kind)).toEqual(['text', 'usage']);
    // The final usage replaces the live estimate.
    expect(s.liveUsage?.a).toBeUndefined();
  });
  it('drops the live usage of a job that reaches a terminal state', () => {
    const live = { kind: 'usage' as const, live: true, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: null };
    let s = eventsReducer(initialEventsState, { type: 'agent', jobId: 'a', event: live });
    s = eventsReducer(s, { type: 'agent', jobId: 'b', event: live });
    s = eventsReducer(s, { type: 'job', job: job('a', 'running') });
    expect(Object.keys(s.liveUsage ?? {})).toEqual(['a', 'b']);
    s = eventsReducer(s, { type: 'job', job: job('a', 'cancelled') });
    expect(Object.keys(s.liveUsage ?? {})).toEqual(['b']);
  });
  it('keeps on snapshot only the live usage of jobs still running', () => {
    const live = { kind: 'usage' as const, live: true, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: null };
    let s = initialEventsState;
    for (const id of ['a', 'b', 'c']) s = eventsReducer(s, { type: 'agent', jobId: id, event: live });
    s = eventsReducer(s, { type: 'snapshot', jobs: [job('a', 'running'), job('b', 'succeeded')], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
    expect(Object.keys(s.liveUsage ?? {})).toEqual(['a']);
  });
});

describe('language', () => {
  it('keeps the system locale from the snapshot and the locale event', () => {
    let s = eventsReducer(initialEventsState, { type: 'snapshot', jobs: [], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
    expect(s.language).toEqual({ locale: 'it', setting: 'system', systemLocale: 'it' });
    s = eventsReducer(s, { type: 'locale', locale: 'en', setting: 'en', systemLocale: 'it' });
    expect(s.language).toEqual({ locale: 'en', setting: 'en', systemLocale: 'it' });
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
  const approval = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: null, kind: 'tool' as const, title: 't', detail: 'd', toolName: 'Bash', alwaysRule: null, explanation: null, agentReason: null, createdAt: 'x', expiresAt: 'y' };
  it('tracks pending approvals from snapshot, add and resolve', () => {
    let s = eventsReducer(initialEventsState, { type: 'snapshot', jobs: [], approvals: [approval], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
    expect(Object.keys(s.approvals)).toEqual(['a1']);
    s = eventsReducer(s, { type: 'approval_resolved', id: 'a1', decision: 'deny' });
    expect(s.approvals).toEqual({});
    s = eventsReducer(s, { type: 'approval', approval: { ...approval, id: 'a2' } });
    expect(Object.keys(s.approvals)).toEqual(['a2']);
  });
});

describe('report 41: formats ready during a turn', () => {
  const ready = (format: string, hash: string | null) => ({ type: 'formatReady' as const, jobId: 'j1', project: 'acme', creative: 'c', n: 3, format, hash });
  it('keeps each checked format of a running job with its version and hash; a null hash takes it back; the end of the job drops them', () => {
    let s = eventsReducer(initialEventsState, { type: 'job', job: job('j1', 'running') });
    s = eventsReducer(s, ready('a', 'h1'));
    s = eventsReducer(s, ready('b', 'h2'));
    s = eventsReducer(s, ready('a', 'h3'));
    expect(s.ready).toEqual({ j1: { a: { n: 3, hash: 'h3' }, b: { n: 3, hash: 'h2' } } });
    s = eventsReducer(s, ready('b', null));
    expect(s.ready).toEqual({ j1: { a: { n: 3, hash: 'h3' } } });
    expect(eventsReducer(s, { type: 'job', job: job('j1', 'cancelled') }).ready).toEqual({});
    expect(eventsReducer(s, { type: 'snapshot', jobs: [job('j1', 'failed')], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' }).ready).toEqual({});
    expect(eventsReducer(s, { type: 'snapshot', jobs: [job('j1', 'running')], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' }).ready).toEqual(s.ready);
    // A snapshot that carries the core's list replaces it (a reloaded window).
    expect(eventsReducer(initialEventsState, { type: 'snapshot', jobs: [job('j1', 'running'), job('j2', 'succeeded')], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it',
      ready: { j1: { a: { n: 4, hash: 'h' } }, j2: { b: { n: 1, hash: 'g' } } } }).ready).toEqual({ j1: { a: { n: 4, hash: 'h' } } });
  });
});

describe('eventsReducer · brief sessions (decision 1421)', () => {
  it('counts brief-session messages per project and keeps the latest fill with an increasing seq', () => {
    let s = eventsReducer(initialEventsState, { type: 'brief-session', project: 'acme', sessionId: 's1', revision: 1 });
    s = eventsReducer(s, { type: 'brief-session', project: 'acme', sessionId: 's1', revision: 2 });
    expect(s.briefTicks?.acme).toBe(2);
    expect(s.briefFills?.acme).toBeUndefined();
    s = eventsReducer(s, { type: 'brief-session', project: 'acme', sessionId: 's1', revision: 3, fill: { written: ['goal', 'formats'], kept: [], reclaimed: [] } });
    s = eventsReducer(s, { type: 'brief-session', project: 'acme', sessionId: 's1', revision: 4, fill: { written: [], kept: [], reclaimed: ['message'] } });
    // Both fills are kept (two fills between renders must not lose the first's fields), in order, seq growing.
    const [first, second] = s.briefFills!.acme!;
    expect(first).toMatchObject({ sessionId: 's1', written: ['goal', 'formats'], reclaimed: [] });
    expect(second!.seq).toBeGreaterThan(first!.seq);
    expect(second!.reclaimed).toEqual(['message']);
    for (let i = 0; i < 30; i++) s = eventsReducer(s, { type: 'brief-session', project: 'acme', sessionId: 's1', fill: { written: ['notes'], kept: [], reclaimed: [] } });
    expect(s.briefFills!.acme).toHaveLength(BRIEF_FILLS_KEPT);
    s = { ...s, briefTicks: { acme: 4 } };
    expect(s.briefTicks?.acme).toBe(4);
    // Another project has its own count.
    s = eventsReducer(s, { type: 'brief-session', project: 'other', sessionId: 's2', ended: true });
    expect(s.briefTicks?.other).toBe(1);
  });
});
