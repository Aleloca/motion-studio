import type { Natives } from './clock.ts';
import { withTimeout } from './frames.ts';
import { LAYER_PROTOCOL_VERSION, parseLayerReply, type LayerFailureCode, type LayerResult } from './layer-protocol.ts';

/**
 * A failed layer request; `code` is `frameTimeout` when the layer painted no frame after a render-mode seek, `layerStalled`
 * when its `msReady` or `msSeek` waited on the frozen render clock (decision 709).
 */
export class LayerRequestError extends Error {
  constructor(message: string, readonly code?: LayerFailureCode) { super(message); this.name = 'LayerRequestError'; }
}

/**
 * A request refused or dropped because the layer was disposed (the mount torn down, or a subtitle template replaced): never
 * a failure of the layer, so callers do not report it.
 */
export class LayerDisposedError extends LayerRequestError {
  constructor(op: string) { super(`layer ${op} dropped: the layer was removed`); this.name = 'LayerDisposedError'; }
}

/** The runtime side of one html layer (see layer-protocol.ts). */
export interface LayerHost {
  /** Resolves once the layer answered the connect handshake (layer.js present). */
  readonly connected: Promise<void>;
  /** Fonts loaded and `msReady` awaited inside the layer. Resolves with the layer's warnings. */
  ready(): Promise<string[]>;
  /** Layer local time `t` applied and painted (two animation frames inside the layer). */
  seek(t: number): Promise<void>;
  /** Preview playback: applies `t` without waiting. */
  tick(t: number): void;
  /**
   * Closes the channel; every pending request and every later one rejects at once with a `LayerDisposedError` (a caller
   * awaiting a seek of a layer just replaced is never held for the layer timeout).
   */
  dispose(): void;
}

/**
 * `failFast` (render mode, M3): once a request got no reply within `timeoutMs`, the layer is dead and every later request
 * fails at once instead of waiting again; the caller still reports each failure, so the render fails at its end as before.
 */
export function connectLayer(frame: HTMLIFrameElement, natives: Natives, timeoutMs: number, o: { failFast?: boolean } = {}): LayerHost {
  let port: MessagePort | null = null;
  let dead: string | null = null;
  let disposedNow = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: LayerResult) => void; reject: (e: Error) => void; op: string }>();
  let onDispose: (() => void) | null = null;
  const disposed = new Promise<never>((_, reject) => { onDispose = () => reject(new LayerDisposedError('request')); });
  disposed.catch(() => {});
  let onHello: (() => void) | null = null;
  const helloSeen = new Promise<void>((r) => { onHello = r; });

  const connect = () => {
    const w = frame.contentWindow;
    if (!w) return;
    const channel = new MessageChannel();
    port?.close();
    port = channel.port1;
    port.onmessage = (m: MessageEvent) => {
      const d = parseLayerReply(m.data);
      if (!d) return; // malformed (a layer is untrusted): ignored, the request times out
      if ('type' in d) { if (d.v === LAYER_PROTOCOL_VERSION) onHello?.(); return; }
      const p = pending.get(d.id); pending.delete(d.id); p?.resolve(d);
    };
    w.postMessage({ type: 'ms-layer-connect', v: LAYER_PROTOCOL_VERSION }, '*', [channel.port2]);
  };
  frame.addEventListener('load', connect);

  const connected = withTimeout(helloSeen, timeoutMs, natives, 'layer.js did not answer (bootstrap missing?)');
  connected.catch(() => {});

  const request = async (op: 'ready' | 'seek', t?: number) => {
    if (disposedNow) throw new LayerDisposedError(op);
    if (dead !== null) throw new LayerRequestError(`layer ${op} skipped: ${dead}`);
    await Promise.race([connected, disposed]).catch((e: unknown) => { throw e instanceof LayerDisposedError ? new LayerDisposedError(op) : e; });
    if (disposedNow) throw new LayerDisposedError(op);
    const id = nextId++;
    const reply = new Promise<LayerResult>((resolve, reject) => { pending.set(id, { resolve, reject, op }); });
    port!.postMessage(op === 'seek' ? { id, op, t } : { id, op });
    const r = await withTimeout(reply, timeoutMs, natives, `layer ${op} timed out`)
      .catch((e: unknown) => { if (e instanceof LayerDisposedError) throw e; if (o.failFast) dead = `the layer did not answer a ${op} within ${timeoutMs} ms`; throw e; })
      .finally(() => pending.delete(id));
    if (!r.ok) throw new LayerRequestError(r.error ?? `layer ${op} failed`, r.code);
    return r;
  };

  return {
    connected,
    async ready() { const r = await request('ready'); return r.warnings ?? []; },
    async seek(t: number) { await request('seek', t); },
    tick(t: number) { port?.postMessage({ op: 'tick', t }); },
    dispose() {
      if (disposedNow) return;
      disposedNow = true;
      dead = 'the layer was removed';
      onDispose?.();
      for (const p of pending.values()) p.reject(new LayerDisposedError(p.op));
      pending.clear();
      frame.removeEventListener('load', connect);
      if (port) { port.onmessage = null; port.close(); port = null; }
    },
  };
}
