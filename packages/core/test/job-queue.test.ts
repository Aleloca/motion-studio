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
});
