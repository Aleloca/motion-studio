import type { Readable, Writable } from 'node:stream';

/**
 * A zero-dependency Chrome DevTools Protocol client over `--remote-debugging-pipe` (spike §3: no puppeteer, no TCP port,
 * so no other local process can attach to the render browser).
 *
 * Framing: every message is one JSON object followed by a NUL byte, in both directions (Chrome writes to fd 4 and reads
 * fd 3). Every call has a timeout, so a hung browser can never hang the core. A frame larger than `maxMessageBytes`, or one
 * that is not JSON, closes the connection: the browser is then treated as broken.
 *
 * `CdpClient` is the transport-neutral interface the render page logic uses; Task 7's Electron provider implements it
 * over `webContents.debugger`.
 */

export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId?: string }

export interface CdpSendOptions { sessionId?: string; timeoutMs?: number }

export interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: object, o?: CdpSendOptions): Promise<T>;
  /** Subscribes to every event; returns the unsubscribe. */
  onEvent(listener: (e: CdpEvent) => void): () => void;
  /** Called once when the connection ends (browser exit, broken pipe, `close()`); returns the unsubscribe. */
  onClose(listener: (err: Error) => void): () => void;
  /** Why the connection ended, or null while it is open. */
  readonly closed: Error | null;
}

export class CdpError extends Error {
  constructor(message: string, readonly code: 'timeout' | 'closed' | 'protocol' | 'remote') {
    super(message);
    this.name = 'CdpError';
  }
}

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout; sessionId?: string }

export const CDP_DEFAULT_TIMEOUT_MS = 30_000;
/** A 8192×8192 PNG screenshot in base64 stays well below this. */
export const CDP_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

export class CdpPipe implements CdpClient {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private chunks: Buffer[] = [];
  private buffered = 0;
  private listeners = new Set<(e: CdpEvent) => void>();
  private closeListeners = new Set<(err: Error) => void>();
  closed: Error | null = null;
  private readonly defaultTimeoutMs: number;
  private readonly maxMessageBytes: number;

  constructor(private readonly out: Writable, private readonly input: Readable, o: { defaultTimeoutMs?: number; maxMessageBytes?: number } = {}) {
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? CDP_DEFAULT_TIMEOUT_MS;
    this.maxMessageBytes = o.maxMessageBytes ?? CDP_MAX_MESSAGE_BYTES;
    out.on('error', (e: Error) => this.close(new CdpError(`pipe write failed: ${e.message}`, 'closed')));
    input.on('error', (e: Error) => this.close(new CdpError(`pipe read failed: ${e.message}`, 'closed')));
    input.on('data', (d: Buffer) => this.onData(d));
    input.on('end', () => this.close(new CdpError('browser closed the pipe', 'closed')));
    input.on('close', () => this.close(new CdpError('browser closed the pipe', 'closed')));
  }

  private onData(d: Buffer): void {
    if (this.closed) return;
    let start = 0;
    for (;;) {
      const nul = d.indexOf(0, start);
      if (nul < 0) break;
      const part = d.subarray(start, nul);
      const frame = this.chunks.length === 0 ? part : Buffer.concat([...this.chunks, part]);
      this.chunks = [];
      this.buffered = 0;
      start = nul + 1;
      if (frame.length > this.maxMessageBytes) return this.close(new CdpError('CDP message too large', 'protocol'));
      this.dispatch(frame);
      if (this.closed) return;
    }
    if (start < d.length) {
      const rest = d.subarray(start);
      this.buffered += rest.length;
      if (this.buffered > this.maxMessageBytes) return this.close(new CdpError('CDP message too large', 'protocol'));
      this.chunks.push(rest);
    }
  }

  private dispatch(frame: Buffer): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown; error?: { message?: unknown }; result?: unknown };
    try { msg = JSON.parse(frame.toString('utf8')) as typeof msg; } catch { return this.close(new CdpError('malformed CDP message', 'protocol')); }
    if (typeof msg !== 'object' || msg === null) return this.close(new CdpError('malformed CDP message', 'protocol'));
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return; // answered after its timeout
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${String(msg.error.message ?? 'error')}`, 'remote'));
      else p.resolve((typeof msg.result === 'object' && msg.result !== null ? msg.result : {}) as Record<string, unknown>);
      return;
    }
    if (typeof msg.method === 'string') {
      // A session that went away (its target closed or crashed) never answers: fail its calls now, not at their timeout.
      if (msg.method === 'Target.detachedFromTarget' && typeof (msg.params as { sessionId?: unknown } | undefined)?.sessionId === 'string') {
        const gone = (msg.params as { sessionId: string }).sessionId;
        for (const [id, p] of this.pending) {
          if (p.sessionId !== gone) continue;
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new CdpError(`${p.method}: the target was detached`, 'closed'));
        }
      }
      const e: CdpEvent = {
        method: msg.method,
        params: (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>,
        ...(typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}),
      };
      for (const l of [...this.listeners]) {
        try { l(e); } catch { /* a listener bug must not break the pipe */ }
      }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, o: CdpSendOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: ${this.closed.message}`, 'closed'));
    const id = ++this.nextId;
    const timeoutMs = o.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, method, timer, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
      const frame = JSON.stringify({ id, method, params, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
      try {
        this.out.write(Buffer.concat([Buffer.from(frame, 'utf8'), Buffer.from([0])]));
      } catch (e) {
        this.close(new CdpError(`pipe write failed: ${(e as Error).message}`, 'closed'));
      }
    });
  }

  onEvent(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onClose(listener: (err: Error) => void): () => void {
    if (this.closed) { listener(this.closed); return () => {}; }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  /** Ends the connection: every pending call rejects with `err`. Idempotent. */
  close(err: Error = new CdpError('connection closed', 'closed')): void {
    if (this.closed) return;
    this.closed = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError(`${p.method}: ${err.message}`, 'closed'));
    }
    this.pending.clear();
    this.chunks = [];
    this.listeners.clear();
    for (const l of [...this.closeListeners]) { try { l(err); } catch { /* ignore */ } }
    this.closeListeners.clear();
    try { this.out.end(); } catch { /* already gone */ }
  }
}

/** Waits for one event matching `pred` on `client`, with a timeout and an optional abort signal. */
export function waitForEvent(client: CdpClient, method: string, o: { sessionId?: string; timeoutMs: number; signal?: AbortSignal; pred?: (p: Record<string, unknown>) => boolean }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (f: () => void) => { if (done) return; done = true; clearTimeout(timer); off(); offClose(); o.signal?.removeEventListener('abort', onAbort); f(); };
    const off = client.onEvent((e) => {
      if (e.method !== method || (o.sessionId !== undefined && e.sessionId !== o.sessionId)) return;
      if (o.pred && !o.pred(e.params)) return;
      finish(() => resolve(e.params));
    });
    const offClose = client.onClose((err) => finish(() => reject(new CdpError(`waiting for ${method}: ${err.message}`, 'closed'))));
    const timer = setTimeout(() => finish(() => reject(new CdpError(`timed out waiting for ${method}`, 'timeout'))), o.timeoutMs);
    const onAbort = () => finish(() => reject(o.signal!.reason instanceof Error ? o.signal!.reason : new Error('aborted')));
    if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
