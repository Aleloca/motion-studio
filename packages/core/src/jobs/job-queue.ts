import { randomUUID } from 'node:crypto';
import type { JobKind, JobSummary, JobWaitReason } from '@motion-studio/shared';
import { t } from '../i18n.ts';

/**
 * A job with the same key is queued or running. The message is localized and never names the key (final review I3: a key
 * holds the workspace path); the key stays on the error for logs and callers.
 */
export class JobConflictError extends Error {
  constructor(readonly key: string) {
    super(t().jobs.conflict);
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
  /** The job's id, when the caller needs it before the job starts (Phase 13: a turn's user entry names it); default: a new UUID. */
  id?: string;
  key: string;
  kind: JobKind;
  label: string;
  /** The formats the job targets (creative turns, see JobSummary.formats); copied into the summary. */
  formats?: string[];
  /**
   * Outcome contract: resolving means the work completed ('succeeded'), even if an abort arrived late;
   * resolving to 'cancelled' reports an explicit cancellation; rejecting means 'failed', or 'cancelled'
   * when the signal was aborted (the rejection is taken to be caused by the abort) unless the error is a JobFailedError.
   */
  run: (signal: AbortSignal, jobId: string) => Promise<void | 'cancelled'>;
  /**
   * A separate lane with its own limit (`JobQueue` option `lanes`), e.g. `render`: its jobs never take the main slots, so a
   * long render never blocks an agent turn. Its queued jobs carry `queuePosition` (jobs of the lane ahead of them).
   */
  lane?: string;
  /** Called when the job is cancelled while still queued (run() never starts). Errors are swallowed. The queue is pumped after it settles; a whenIdle() called after the cancel may resolve before the hook finishes. */
  onCancelledBeforeStart?: () => void | Promise<void>;
  /**
   * Phase 15: an extra limit shared by the jobs of one `group` (the turns of a variant group, at most two at once): a queued
   * job starts only while fewer than `limit` jobs of its group run, whatever room the queue has, and meanwhile it carries
   * `reason` as its `waitReason`. A blocked job never holds a slot: the jobs queued after it may start first. Absent: no
   * extra limit (every job before phase 15).
   */
  slot?: { group: string; limit: number; reason: JobWaitReason };
  /**
   * Phase 15: the job is held: it stays queued, with this `waitReason`, until `setHold(id, null)` releases it (the turns of a
   * variant run wait for their directions and for the paid-services card). A held job never holds a slot.
   */
  hold?: JobWaitReason;
}

interface Entry { summary: JobSummary; spec: JobSpec; controller: AbortController; hold: JobWaitReason | null }

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
  private settleWaiters: Array<{ id: string; resolve: (job: JobSummary) => void }> = [];

  private readonly lanes: Record<string, number>;

  constructor(opts: { concurrency: number; onUpdate?: (job: JobSummary) => void; lanes?: Record<string, number> }) {
    this.concurrency = clampConcurrency(opts.concurrency, 1);
    this.onUpdate = opts.onUpdate;
    this.lanes = Object.fromEntries(Object.entries(opts.lanes ?? {}).map(([k, v]) => [k, clampConcurrency(v, 1)]));
  }

  enqueue(spec: JobSpec): JobSummary {
    if (this.entries.some((e) => e.spec.key === spec.key && ACTIVE.has(e.summary.state))) throw new JobConflictError(spec.key);
    const entry: Entry = {
      spec,
      hold: spec.hold ?? null,
      controller: new AbortController(),
      summary: {
        id: spec.id ?? randomUUID(), key: spec.key, kind: spec.kind, label: spec.label, state: 'queued', createdAt: new Date().toISOString(),
        ...(spec.formats ? { formats: [...spec.formats] } : {}),
      },
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

  /**
   * Phase 15: holds a queued job with `reason` (it does not start, and says why), or releases it (`null`): it then starts as
   * soon as the queue and its slot group allow. False for an unknown job or one no longer queued.
   */
  setHold(id: string, reason: JobWaitReason | null): boolean {
    const entry = this.entries.find((e) => e.summary.id === id);
    if (!entry || entry.summary.state !== 'queued') return false;
    entry.hold = reason;
    if (reason && entry.summary.waitReason !== reason) { entry.summary.waitReason = reason; this.update(entry); }
    this.pump();
    return true;
  }

  /** Records agent-neutral details learnt while the job runs (e.g. the session id) and broadcasts them. */
  patch(id: string, fields: Partial<Pick<JobSummary, 'sessionId' | 'notes' | 'formats' | 'progress' | 'liveMessages' | 'export'>>): void {
    const entry = this.entries.find((e) => e.summary.id === id);
    const same = (k: keyof typeof fields) => JSON.stringify(entry!.summary[k]) === JSON.stringify(fields[k]);
    if (!entry || (Object.keys(fields) as Array<keyof typeof fields>).every(same)) return;
    Object.assign(entry.summary, fields);
    // An absent value is removed, never kept as `undefined` (the summary's fields are optional).
    for (const k of Object.keys(fields) as Array<keyof typeof fields>) if (fields[k] === undefined) delete entry.summary[k];
    this.update(entry);
  }

  list(): JobSummary[] { return this.entries.map((e) => ({ ...e.summary })); }

  setConcurrency(n: number): void {
    this.concurrency = clampConcurrency(n, this.concurrency);
    this.pump();
  }

  /** The job's final summary once it is no longer queued or running (at once when it already ended); null for an unknown id. */
  whenSettled(id: string): Promise<JobSummary | null> {
    const entry = this.entries.find((e) => e.summary.id === id);
    if (!entry) return Promise.resolve(null);
    if (!ACTIVE.has(entry.summary.state)) return Promise.resolve({ ...entry.summary });
    return new Promise((resolve) => this.settleWaiters.push({ id, resolve }));
  }

  /**
   * Resolves when no job is queued or running. A HELD job (`hold`) is queued: it waits for its release (or a cancel), so this
   * does not resolve while one is held. The one caller that needs to end (the server's close) cancels every job first.
   */
  whenIdle(): Promise<void> {
    if (!this.entries.some((e) => ACTIVE.has(e.summary.state))) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private laneOf(e: Entry): string | null { return e.spec.lane !== undefined && Object.hasOwn(this.lanes, e.spec.lane) ? e.spec.lane : null; }

  private pump(): void {
    for (const lane of [null, ...Object.keys(this.lanes)]) {
      const mine = this.entries.filter((e) => this.laneOf(e) === lane);
      const running = mine.filter((e) => e.summary.state === 'running').length;
      const waiting = mine.filter((e) => e.summary.state === 'queued').reverse();
      const limit = lane === null ? this.concurrency : this.lanes[lane]!;
      // Oldest first, as many as the lane has room for; a job whose group is full stays queued with its reason (phase 15).
      let free = Math.max(0, limit - running);
      const groups = new Map<string, number>();
      for (const e of this.entries) if (e.spec.slot && e.summary.state === 'running') groups.set(e.spec.slot.group, (groups.get(e.spec.slot.group) ?? 0) + 1);
      for (const entry of waiting) {
        const slot = entry.spec.slot;
        const blocked = slot !== undefined && (groups.get(slot.group) ?? 0) >= slot.limit;
        if (entry.hold) {
          if (entry.summary.waitReason !== entry.hold) { entry.summary.waitReason = entry.hold; this.update(entry); }
          continue;
        }
        if (!blocked && free > 0) {
          free--;
          if (slot) groups.set(slot.group, (groups.get(slot.group) ?? 0) + 1);
          this.start(entry);
          continue;
        }
        const reason = blocked ? slot!.reason : undefined;
        if (entry.summary.waitReason === reason) continue;
        if (reason) entry.summary.waitReason = reason;
        else delete entry.summary.waitReason;
        this.update(entry);
      }
      if (lane === null) continue;
      // Queued jobs of a lane: how many of its jobs are ahead (running, or queued earlier).
      const ahead = mine.filter((e) => e.summary.state === 'running').length;
      waiting.filter((e) => e.summary.state === 'queued').forEach((e, i) => {
        if (e.summary.queuePosition === ahead + i) return;
        e.summary.queuePosition = ahead + i;
        this.update(e);
      });
    }
    if (!this.entries.some((e) => ACTIVE.has(e.summary.state))) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private start(entry: Entry): void {
    entry.summary.state = 'running';
    delete entry.summary.queuePosition;
    delete entry.summary.waitReason;
    entry.summary.startedAt = new Date().toISOString();
    this.update(entry);
    Promise.resolve().then(() => entry.spec.run(entry.controller.signal, entry.summary.id)).then(
      (outcome) => this.finish(entry, outcome === 'cancelled' ? 'cancelled' : 'succeeded'),
      (err: unknown) => this.finish(entry, entry.controller.signal.aborted && !(err instanceof JobFailedError) ? 'cancelled' : 'failed', err instanceof Error ? err.message : String(err)),
    ).finally(() => this.pump());
  }

  private finish(entry: Entry, state: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    entry.summary.state = state;
    delete entry.summary.queuePosition;
    delete entry.summary.waitReason;
    entry.summary.finishedAt = new Date().toISOString();
    if (error && state === 'failed') entry.summary.error = error;
    this.update(entry);
    const mine = this.settleWaiters.filter((w) => w.id === entry.summary.id);
    if (mine.length > 0) {
      this.settleWaiters = this.settleWaiters.filter((w) => w.id !== entry.summary.id);
      for (const w of mine) w.resolve({ ...entry.summary });
    }
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
