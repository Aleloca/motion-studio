import type { JobSummary } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { JobConflictError, JobQueue } from '../src/jobs/job-queue.ts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('JobQueue', () => {
  it('respects the concurrency limit', async () => {
    const q = new JobQueue({ concurrency: 2 });
    const ds = [deferred(), deferred(), deferred()];
    const jobs = ds.map((d, i) => q.enqueue({ key: `k${i}`, label: `j${i}`, run: () => d.promise }));
    await tick();
    expect(q.list().filter((j) => j.state === 'running')).toHaveLength(2);
    ds[0]!.resolve();
    await tick(); await tick();
    expect(q.list().find((j) => j.id === jobs[2]!.id)?.state).toBe('running');
    ds[1]!.resolve(); ds[2]!.resolve();
    await q.whenIdle();
    expect(q.list().every((j) => j.state === 'succeeded')).toBe(true);
  });
  it('rejects a second active job with the same key', () => {
    const q = new JobQueue({ concurrency: 1 });
    q.enqueue({ key: 'same', label: 'a', run: () => deferred().promise });
    expect(() => q.enqueue({ key: 'same', label: 'b', run: async () => {} })).toThrow(JobConflictError);
  });
  it('allows the same key again after the first finishes', async () => {
    const q = new JobQueue({ concurrency: 1 });
    q.enqueue({ key: 'k', label: 'a', run: async () => {} });
    await q.whenIdle();
    expect(() => q.enqueue({ key: 'k', label: 'b', run: async () => {} })).not.toThrow();
  });
  it('marks failures with the error message', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const job = q.enqueue({ key: 'k', label: 'a', run: async () => { throw new Error('nope'); } });
    await q.whenIdle();
    expect(q.list().find((j) => j.id === job.id)).toMatchObject({ state: 'failed', error: 'nope' });
  });
  it('cancels a running job via its AbortSignal and a queued job without running it', async () => {
    const q = new JobQueue({ concurrency: 1 });
    let ran = false;
    const running = q.enqueue({
      key: 'a', label: 'a',
      run: (signal) => new Promise<void>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const queued = q.enqueue({ key: 'b', label: 'b', run: async () => { ran = true; } });
    await tick();
    expect(q.cancel(queued.id)).toBe(true);
    expect(q.cancel(running.id)).toBe(true);
    await q.whenIdle();
    expect(ran).toBe(false);
    expect(q.list().map((j) => j.state).sort()).toEqual(['cancelled', 'cancelled']);
    expect(q.cancel(running.id)).toBe(false);
  });
  it('reports every state change through onUpdate', async () => {
    const updates: JobSummary[] = [];
    const q = new JobQueue({ concurrency: 1, onUpdate: (j) => updates.push(j) });
    q.enqueue({ key: 'k', label: 'a', run: async () => {} });
    await q.whenIdle();
    expect(updates.map((u) => u.state)).toEqual(['queued', 'running', 'succeeded']);
  });
  it('starts waiting jobs when concurrency is raised', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const d1 = deferred(); const d2 = deferred();
    q.enqueue({ key: 'a', label: 'a', run: () => d1.promise });
    q.enqueue({ key: 'b', label: 'b', run: () => d2.promise });
    await tick();
    q.setConcurrency(2);
    await tick();
    expect(q.list().filter((j) => j.state === 'running')).toHaveLength(2);
    d1.resolve(); d2.resolve();
    await q.whenIdle();
  });
  it('handles a non-async run that throws synchronously', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const job = q.enqueue({ key: 'k', label: 'a', run: () => { throw new Error('sync error'); } });
    await q.whenIdle();
    expect(q.list().find((j) => j.id === job.id)).toMatchObject({ state: 'failed', error: 'sync error' });
  });
  it('handles a run that rejects with a non-Error value', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const job = q.enqueue({ key: 'k', label: 'a', run: async () => { throw 'string error'; } });
    await q.whenIdle();
    expect(q.list().find((j) => j.id === job.id)).toMatchObject({ state: 'failed', error: 'string error' });
  });
  it('handles onUpdate throwing without stranding the job', async () => {
    const updates: JobSummary[] = [];
    const q = new JobQueue({ concurrency: 1, onUpdate: (j) => {
      updates.push(j);
      if (j.state === 'running') throw new Error('listener error');
    } });
    const job = q.enqueue({ key: 'k', label: 'a', run: async () => {} });
    await q.whenIdle();
    expect(q.list().find((j) => j.id === job.id)).toMatchObject({ state: 'succeeded' });
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });
  it('a run that resolves normally succeeds even if the abort arrived after the work finished', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const d = deferred();
    const job = q.enqueue({ key: 'k', label: 'a', run: () => d.promise });
    await tick();
    q.cancel(job.id);
    d.resolve();
    await q.whenIdle();
    expect(q.list()[0]).toMatchObject({ state: 'succeeded' });
  });
  it('a run can resolve to "cancelled" to report an explicit cancellation', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const job = q.enqueue({
      key: 'k', label: 'a',
      run: (signal) => new Promise<'cancelled'>((res) => signal.addEventListener('abort', () => res('cancelled'))),
    });
    await tick();
    q.cancel(job.id);
    await q.whenIdle();
    expect(q.list()[0]).toMatchObject({ state: 'cancelled' });
  });
  it('clamps concurrency to 1..8 and ignores non-integers', async () => {
    const running = (q: JobQueue) => q.list().filter((j) => j.state === 'running').length;
    const q = new JobQueue({ concurrency: 2 });
    const ds = Array.from({ length: 10 }, () => deferred());
    ds.forEach((d, i) => q.enqueue({ key: `k${i}`, label: `${i}`, run: () => d.promise }));
    await tick();
    expect(running(q)).toBe(2);
    q.setConcurrency(Number.NaN);
    q.setConcurrency(100);
    await tick();
    expect(running(q)).toBe(8);
    q.setConcurrency(0);
    q.setConcurrency(2.5);
    ds.forEach((d) => d.resolve());
    await q.whenIdle();
    const q2 = new JobQueue({ concurrency: 0 });
    const d2 = deferred();
    q2.enqueue({ key: 'x', label: 'x', run: () => d2.promise });
    await tick();
    expect(running(q2)).toBe(1);
    d2.resolve();
    await q2.whenIdle();
  });
  it('patches the session id of a job and broadcasts it once', async () => {
    const updates: JobSummary[] = [];
    const q = new JobQueue({ concurrency: 1, onUpdate: (j) => updates.push(j) });
    const d = deferred();
    const job = q.enqueue({ key: 'k', label: 'a', run: () => d.promise });
    await tick();
    q.patch(job.id, { sessionId: 's1' });
    q.patch(job.id, { sessionId: 's1' });
    q.patch('unknown', { sessionId: 's2' });
    d.resolve();
    await q.whenIdle();
    expect(updates.map((u) => [u.state, u.sessionId])).toEqual([['queued', undefined], ['running', undefined], ['running', 's1'], ['succeeded', 's1']]);
  });
});
