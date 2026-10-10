import type { RuntimeMode } from './protocol.ts';

/**
 * Runtime ↔ html layer. A layer is an `<iframe sandbox="allow-scripts">`, so it has its own opaque origin in both modes
 * and the runtime never touches its document. The core injects `layer.js` as the layer's first script (see page.ts);
 * it reads its configuration from `window.name` (the iframe's `name` attribute, readable before any layer script runs)
 * and talks to the runtime over a private MessagePort:
 *
 * 1. after the iframe's `load`, the runtime posts `{ type: 'ms-layer-connect', v: 1 }` to the layer window with a
 *    transferred port (target `*`: the layer origin is opaque; the message carries no data);
 * 2. layer.js accepts it only from `window.parent`, and answers `{ type: 'hello', v: 1 }` on the port;
 * 3. requests `{ id, op: 'ready' | 'seek', t? }` get `{ id, ok, error?, warnings? }`; `{ op: 'tick', t }` (preview
 *    playback, every animation frame) gets no answer.
 */

export const LAYER_NAME_PREFIX = 'ms-layer:';
export const LAYER_PROTOCOL_VERSION = 1;

export interface LayerFont { family: string; url: string; weight?: string; style?: string }
export interface LayerConfig {
  v: typeof LAYER_PROTOCOL_VERSION;
  mode: RuntimeMode;
  clipId: string;
  /** `window.msParams`: each declared param's value; an `image` param is an absolute URL inside the composition. */
  params: Record<string, string | number>;
  /** The composition's fonts, preloaded into the layer with `FontFace.load()`. */
  fonts: LayerFont[];
}

export type LayerRequest = { id: number; op: 'ready' } | { id: number; op: 'seek'; t: number } | { op: 'tick'; t: number };
export interface LayerResult { id: number; ok: boolean; error?: string; warnings?: string[] }
export type LayerReply = { type: 'hello'; v: number } | LayerResult;

export function encodeLayerConfig(c: LayerConfig): string {
  return LAYER_NAME_PREFIX + JSON.stringify(c);
}

export function decodeLayerConfig(name: string): LayerConfig | null {
  if (typeof name !== 'string' || !name.startsWith(LAYER_NAME_PREFIX)) return null;
  try {
    const v = JSON.parse(name.slice(LAYER_NAME_PREFIX.length)) as Partial<LayerConfig>;
    if (v.v !== LAYER_PROTOCOL_VERSION || (v.mode !== 'render' && v.mode !== 'preview') || typeof v.clipId !== 'string') return null;
    const params = typeof v.params === 'object' && v.params !== null ? v.params : {};
    const fonts = Array.isArray(v.fonts) ? v.fonts.filter((f) => f && typeof f.family === 'string' && typeof f.url === 'string') : [];
    return { v: LAYER_PROTOCOL_VERSION, mode: v.mode, clipId: v.clipId, params, fonts };
  } catch {
    return null;
  }
}
