import { randomUUID } from 'node:crypto';
import type { JobKind, JobSummary } from '@motion-studio/shared';
import { t } from '../i18n.ts';

export class JobConflictError extends Error {
  constructor(key: string) {
    super(t().jobs.conflict({ key }));
    this.name = 'JobConflictError';
  }
}

/** A rejection with this error is always 'failed', even when the job's signal was aborted. */
export class JobFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobFailedError';
  }
}

export interface JobSpec {
  key: string;
  kind: JobKind;
  label: string;
  /**
   * Outcome contract: resolving means the work completed ('succeeded'), even if an abort arrived late;
   * resolving to 'cancelled' reports an explicit cancellation; rejecting means 'failed', or 'cancelled'
   * when the signal was aborted (the rejection is taken to be caused by the abort) unless the error is a JobFailedError.
   */
  run: (signal: AbortSignal, jobId: string) => Promise<void | 'cancelled'>;
  /** Called when the job is cancelled while still queued (run() never starts). Errors are swallowed. The queue is pumped after it settles; a whenIdle() called after the cancel may resolve before the hook finishes. */
  onCancelledBeforeStart?: () => void | Promise<void>;
}

interface Entry { summary: JobSummary; spec: JobSpec; controller: AbortController }

const MAX_KEPT = 100;
const ACTIVE = new Set(['queued', 'running']);
const MAX_CONCURRENCY = 8;

/** Integer in 1..8; a non-finite value keeps the previous one. */
function clampConcurrency(n: number, previous: number): number {
  if (!Number.isFinite(n)) return previous;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(n)));
}

export class JobQueue {
  private concurrency: number;
  private readonly onUpdate?: (job: JobSummary) => void;
  private readonly entries: Entry[] = [];
  private idleWaiters: Array<() => void> = [];

  constructor(opts: { concurrency: number; onUpdate?: (job: JobSummary) => void }) {
    this.concurrency = clampConcurrency(opts.concurrency, 1);
    this.onUpdate = opts.onUpdate;
  }

  enqueue(spec: JobSpec): JobSummary {
    if (this.entries.some((e) => e.spec.key === spec.key && ACTIVE.has(e.summary.state))) throw new JobConflictError(spec.key);
    const entry: Entry = {
      spec,
      controller: new AbortController(),
      summary: { id: randomUUID(), key: spec.key, kind: spec.kind, label: spec.label, state: 'queued', createdAt: new Date().toISOString() },
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
      Promise.resolve().then(() => entry.spec.onCancelledBeforeStart?.()).catch(() => {}).finally(() => this.pump());
    } else {
      entry.controller.abort();
    }
    return true;
  }

  /** Records agent-neutral details learnt while the job runs (e.g. the session id) and broadcasts them. */
  patch(id: string, fields: Partial<Pick<JobSummary, 'sessionId' | 'notes'>>): void {
    const entry = this.entries.find((e) => e.summary.id === id);
    if (!entry || (Object.keys(fields) as Array<keyof typeof fields>).every((k) => entry.summary[k] === fields[k])) return;
    Object.assign(entry.summary, fields);
    this.update(entry);
  }

  list(): JobSummary[] { return this.entries.map((e) => ({ ...e.summary })); }

  setConcurrency(n: number): void {
    this.concurrency = clampConcurrency(n, this.concurrency);
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
    Promise.resolve().then(() => entry.spec.run(entry.controller.signal, entry.summary.id)).then(
      (outcome) => this.finish(entry, outcome === 'cancelled' ? 'cancelled' : 'succeeded'),
      (err: unknown) => this.finish(entry, entry.controller.signal.aborted && !(err instanceof JobFailedError) ? 'cancelled' : 'failed', err instanceof Error ? err.message : String(err)),
    ).finally(() => this.pump());
  }

  private finish(entry: Entry, state: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    entry.summary.state = state;
    entry.summary.finishedAt = new Date().toISOString();
    if (error && state === 'failed') entry.summary.error = error;
    this.update(entry);
  }

  private update(entry: Entry): void {
    try {
      this.onUpdate?.({ ...entry.summary });
    } catch {
      // Swallow listener errors to prevent stranding the queue
    }
  }

  private trim(): void {
    for (let i = this.entries.length - 1; i >= 0 && this.entries.length > MAX_KEPT; i--) {
      if (!ACTIVE.has(this.entries[i]!.summary.state)) this.entries.splice(i, 1);
    }
  }
}
