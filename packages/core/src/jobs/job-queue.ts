import { randomUUID } from 'node:crypto';
import type { JobSummary } from '@motion-studio/shared';

export class JobConflictError extends Error {
  constructor(key: string) {
    super(`C'è già un lavoro attivo per ${key}`);
    this.name = 'JobConflictError';
  }
}

export interface JobSpec {
  key: string;
  label: string;
  run: (signal: AbortSignal, jobId: string) => Promise<void>;
}

interface Entry { summary: JobSummary; spec: JobSpec; controller: AbortController }

const MAX_KEPT = 100;
const ACTIVE = new Set(['queued', 'running']);

export class JobQueue {
  private concurrency: number;
  private readonly onUpdate?: (job: JobSummary) => void;
  private readonly entries: Entry[] = [];
  private idleWaiters: Array<() => void> = [];

  constructor(opts: { concurrency: number; onUpdate?: (job: JobSummary) => void }) {
    this.concurrency = opts.concurrency;
    this.onUpdate = opts.onUpdate;
  }

  enqueue(spec: JobSpec): JobSummary {
    if (this.entries.some((e) => e.spec.key === spec.key && ACTIVE.has(e.summary.state))) throw new JobConflictError(spec.key);
    const entry: Entry = {
      spec,
      controller: new AbortController(),
      summary: { id: randomUUID(), key: spec.key, label: spec.label, state: 'queued', createdAt: new Date().toISOString() },
    };
    this.entries.unshift(entry);
    this.trim();
    this.update(entry);
    this.pump();
    return { ...entry.summary };
  }

  cancel(id: string): boolean {
    const entry = this.entries.find((e) => e.summary.id === id);
    if (!entry || !ACTIVE.has(entry.summary.state)) return false;
    if (entry.summary.state === 'queued') {
      this.finish(entry, 'cancelled');
      this.pump();
    } else {
      entry.controller.abort();
    }
    return true;
  }

  list(): JobSummary[] { return this.entries.map((e) => ({ ...e.summary })); }

  setConcurrency(n: number): void {
    this.concurrency = n;
    this.pump();
  }

  whenIdle(): Promise<void> {
    if (!this.entries.some((e) => ACTIVE.has(e.summary.state))) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    const running = this.entries.filter((e) => e.summary.state === 'running').length;
    const waiting = this.entries.filter((e) => e.summary.state === 'queued').reverse();
    for (const entry of waiting.slice(0, Math.max(0, this.concurrency - running))) this.start(entry);
    if (!this.entries.some((e) => ACTIVE.has(e.summary.state))) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private start(entry: Entry): void {
    entry.summary.state = 'running';
    entry.summary.startedAt = new Date().toISOString();
    this.update(entry);
    entry.spec.run(entry.controller.signal, entry.summary.id).then(
      () => this.finish(entry, entry.controller.signal.aborted ? 'cancelled' : 'succeeded'),
      (err: Error) => this.finish(entry, entry.controller.signal.aborted ? 'cancelled' : 'failed', err.message),
    ).finally(() => this.pump());
  }

  private finish(entry: Entry, state: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    entry.summary.state = state;
    entry.summary.finishedAt = new Date().toISOString();
    if (error && state === 'failed') entry.summary.error = error;
    this.update(entry);
  }

  private update(entry: Entry): void { this.onUpdate?.({ ...entry.summary }); }

  private trim(): void {
    for (let i = this.entries.length - 1; i >= 0 && this.entries.length > MAX_KEPT; i--) {
      if (!ACTIVE.has(this.entries[i]!.summary.state)) this.entries.splice(i, 1);
    }
  }
}
