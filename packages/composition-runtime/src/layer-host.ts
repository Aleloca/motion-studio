import type { Natives } from './clock.ts';
import { withTimeout } from './frames.ts';
import { LAYER_PROTOCOL_VERSION, parseLayerReply, type LayerResult } from './layer-protocol.ts';

/** A failed layer request; `code` is `frameTimeout` when the layer painted no frame after a render-mode seek. */
export class LayerRequestError extends Error {
  constructor(message: string, readonly code?: 'frameTimeout') { super(message); this.name = 'LayerRequestError'; }
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
}

export function connectLayer(frame: HTMLIFrameElement, natives: Natives, timeoutMs: number): LayerHost {
  let port: MessagePort | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: LayerResult) => void }>();
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
    await connected;
    const id = nextId++;
    const reply = new Promise<LayerResult>((resolve) => { pending.set(id, { resolve }); });
    port!.postMessage(op === 'seek' ? { id, op, t } : { id, op });
    const r = await withTimeout(reply, timeoutMs, natives, `layer ${op} timed out`).finally(() => pending.delete(id));
    if (!r.ok) throw new LayerRequestError(r.error ?? `layer ${op} failed`, r.code);
    return r;
  };

  return {
    connected,
    async ready() { const r = await request('ready'); return r.warnings ?? []; },
    async seek(t: number) { await request('seek', t); },
    tick(t: number) { port?.postMessage({ op: 'tick', t }); },
  };
}
