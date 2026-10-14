/**
 * The preview lane (Task 5b): storyboard thumbnails and the agent's `preview_frames` run here, NOT in the render lane of the
 * job queue. A render can take minutes; a preview is a few seconds and an agent turn waits for it, so it must never queue
 * behind a long render. It is still bounded: at most `slots` previews run at once (each one is a short-lived Chromium),
 * at most `maxWaiting` wait (more are refused at once with `busy`), and each one has a time limit (its run is aborted, which
 * kills its browser group). `close()` aborts everything (app quit).
 */
export class PreviewLaneBusyError extends Error {
  constructor() { super('preview lane busy'); this.name = 'PreviewLaneBusyError'; }
}

export interface PreviewLaneOptions {
  /** Previews at once (default 2). */
  slots?: number;
  /** Previews waiting for a slot before new ones are refused (default 8). */
  maxWaiting?: number;
  /** Time limit of one preview from its start, ms (default 180 s). */
  timeLimitMs?: number;
}

export class PreviewLane {
  private readonly slots: number;
  private readonly maxWaiting: number;
  private readonly timeLimitMs: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly running = new Set<AbortController>();
  private closed = false;

  constructor(o: PreviewLaneOptions = {}) {
    this.slots = Math.max(1, Math.floor(o.slots ?? 2));
    this.maxWaiting = Math.max(0, Math.floor(o.maxWaiting ?? 8));
    this.timeLimitMs = o.timeLimitMs ?? 180_000;
  }

  /** Previews running and waiting now (tests, diagnostics). */
  get load(): { active: number; waiting: number } { return { active: this.active, waiting: this.waiting.length }; }

  /**
   * Runs `fn` in a slot; its signal aborts on `signal`, on the time limit and on `close()`. Throws `PreviewLaneBusyError` when
   * full, or at once when no slot is free and `o.noWait` is set (a caller that must not wait: the text measure under a lock).
   */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, o: { noWait?: boolean } = {}): Promise<T> {
    if (this.closed) throw new Error('preview lane closed');
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
    if (this.active < this.slots) this.active++;
    else {
      if (o.noWait || this.waiting.length >= this.maxWaiting) throw new PreviewLaneBusyError();
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
        const onAbort = () => {
          const i = this.waiting.indexOf(go);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal!.reason instanceof Error ? signal!.reason : new Error('cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(go);
      });
    }
    const ctl = new AbortController();
    if (this.closed) ctl.abort(new Error('closed')); // closed while it waited: it runs aborted and ends at once
    this.running.add(ctl);
    const onOuter = () => ctl.abort(signal!.reason);
    signal?.addEventListener('abort', onOuter, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error('preview time limit')), this.timeLimitMs);
    try {
      return await fn(ctl.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
      this.running.delete(ctl);
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }

  /** Aborts every running preview and refuses new ones. */
  close(): void {
    this.closed = true;
    for (const c of this.running) c.abort(new Error('closed'));
  }
}
