import type { RuntimeMode } from './protocol.ts';
import { readRuntimeSubtitles, type RuntimeSubtitles } from './subtitles.ts';

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
  /** Render mode: how long the layer waits for each native animation frame after a seek before failing it. */
  frameTimeoutMs?: number;
  /**
   * A subtitles template (subtitles Task 17): the subtitle set, as `window.msSubtitles` (frozen), with `window.msActiveCue`.
   * Times in composition milliseconds, which are also the layer's (a `subtitles` clip runs from 0 to the end).
   */
  subtitles?: RuntimeSubtitles;
}

export type LayerRequest = { id: number; op: 'ready' } | { id: number; op: 'seek'; t: number } | { op: 'tick'; t: number };
/**
 * A failed request's cause, when it has one: `frameTimeout` when no frame was painted after a render seek; `layerStalled`
 * when `msReady` or `msSeek` waited on a timer the frozen render clock never fires (decision 709; its own code from
 * Phase 14 task 0). Additive: an older runtime ignores a reply with an unknown code and times the request out.
 */
export type LayerFailureCode = 'frameTimeout' | 'layerStalled';
const LAYER_FAILURE_CODES: ReadonlySet<unknown> = new Set<LayerFailureCode>(['frameTimeout', 'layerStalled']);
export interface LayerResult { id: number; ok: boolean; error?: string; code?: LayerFailureCode; warnings?: string[] }

/** Caps on what a layer may send back (a layer is untrusted code). */
export const LAYER_REPLY_LIMITS = { warnings: 20, text: 300 } as const;

/**
 * Validates a reply from a layer: a hello, or `{ id, ok: boolean, error?: string, code?: LayerFailureCode, warnings?: string[] }`.
 * Strings are cut to `LAYER_REPLY_LIMITS.text`; more than `LAYER_REPLY_LIMITS.warnings` warnings, a wrong type or an
 * unknown shape gives null (the reply is ignored and the request times out like an unanswered one).
 */
export function parseLayerReply(d: unknown): LayerReply | null {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  if (o.type === 'hello') return typeof o.v === 'number' ? { type: 'hello', v: o.v } : null;
  if (typeof o.id !== 'number' || !Number.isInteger(o.id) || typeof o.ok !== 'boolean') return null;
  if (o.error !== undefined && typeof o.error !== 'string') return null;
  if (o.code !== undefined && !LAYER_FAILURE_CODES.has(o.code)) return null;
  if (o.warnings !== undefined && !(Array.isArray(o.warnings) && o.warnings.length <= LAYER_REPLY_LIMITS.warnings && o.warnings.every((w) => typeof w === 'string'))) return null;
  const cut = (s: string) => s.slice(0, LAYER_REPLY_LIMITS.text);
  return {
    id: o.id, ok: o.ok,
    ...(typeof o.error === 'string' ? { error: cut(o.error) } : {}),
    ...(o.code !== undefined ? { code: o.code as LayerFailureCode } : {}),
    ...(Array.isArray(o.warnings) ? { warnings: (o.warnings as string[]).map(cut) } : {}),
  };
}
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
    const frameTimeoutMs = typeof v.frameTimeoutMs === 'number' && v.frameTimeoutMs > 0 ? v.frameTimeoutMs : undefined;
    // Checked again like the page's (a bad block is left out: the template then sees no subtitles).
    const subs = v.subtitles !== undefined ? readRuntimeSubtitles(v.subtitles) : null;
    return {
      v: LAYER_PROTOCOL_VERSION, mode: v.mode, clipId: v.clipId, params, fonts, ...(frameTimeoutMs ? { frameTimeoutMs } : {}),
      ...(subs?.ok ? { subtitles: subs.subtitles } : {}),
    };
  } catch {
    return null;
  }
}
