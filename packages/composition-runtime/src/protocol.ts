/**
 * Live preview protocol between the runtime (inside the sandboxed preview iframe) and the UI that embeds it (Task 8).
 * The web imports these types and validators from `@motion-studio/composition-runtime/protocol`. Pure TypeScript:
 * no DOM, no Node.
 *
 * - The UI passes its own origin in the page URL (`?mode=preview&parentOrigin=<origin>`).
 * - The runtime posts only to `window.parent` with that exact `targetOrigin`, and accepts a message only when
 *   `event.origin === parentOrigin` and `event.source === window.parent`.
 * - The runtime's own origin is opaque (`sandbox="allow-scripts"` without `allow-same-origin`), so the UI sees
 *   `event.origin === "null"` and must check `event.source === iframe.contentWindow` instead (an html layer is a
 *   grandchild with its own opaque origin and could post to the top window too), then `parseOutgoing(event.data)`.
 * - Commands go to the iframe with `iframe.contentWindow.postMessage(cmd, '*')` (the only possible target for an opaque
 *   origin; commands carry no secrets).
 */

export const PREVIEW_PROTOCOL_VERSION = 1;

/** Query parameters of the runtime page. */
export const RUNTIME_QUERY = { mode: 'mode', parentOrigin: 'parentOrigin' } as const;
export type RuntimeMode = 'preview' | 'render';

export const RUNTIME_ERROR_CODES = [
  'compositionMissing', 'compositionInvalid', 'baseNotAllowed', 'assetPathRejected', 'assetLoadFailed', 'fontMissing',
  'fontLoadFailed', 'videoSeekTimeout', 'layerTimeout', 'layerError', 'badAnimation', 'audioBlocked', 'unknownClipType',
] as const;
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];
/** A problem the runtime met. `message` is a developer detail in English; the UI shows its own text for `code`. */
export interface RuntimeError { code: RuntimeErrorCode; message: string; clipId?: string }

export interface Rect { x: number; y: number; width: number; height: number }
export interface SceneInfo { id: string; name?: string; start: number; duration: number }

/** Runtime → UI. */
export type PreviewOutgoing =
  /** Mounted, fonts and media loaded, first frame (t = 0) shown. `errors` lists what went wrong while loading. */
  | { type: 'ready'; version: typeof PREVIEW_PROTOCOL_VERSION; duration: number; fps: number; width: number; height: number; scenes: SceneInfo[]; errors: RuntimeError[] }
  /** The time shown: every animation frame while playing, and once after each seek or pause. */
  | { type: 'time'; t: number; playing: boolean }
  | { type: 'error'; error: RuntimeError }
  /**
   * Where the selected clip is drawn, in CSS pixels of the iframe viewport (its rendered box, transforms and animations
   * included), or null when nothing is selected or the clip is not visible at the current time. Sent after `select`,
   * after a seek or pause, and when the scale or the viewport changes.
   */
  | { type: 'clipBounds'; clipId: string | null; bounds: Rect | null; scale: number };

/** UI → runtime: the only commands the runtime accepts. */
export type PreviewIncoming =
  /** Seconds, clamped to the composition. Pauses playback first. */
  | { type: 'seek'; t: number }
  /** Real-time playback from the current time; `loop` defaults to true, `rate` (0.1 to 4) to 1. */
  | { type: 'play'; loop?: boolean; rate?: number }
  | { type: 'pause' }
  | { type: 'select'; clipId: string | null }
  /** `fit` (default) letterboxes the composition in the viewport; a number is a fixed zoom (0.01 to 8). */
  | { type: 'setScale'; scale: number | 'fit' };

export const RATE_MIN = 0.1;
export const RATE_MAX = 4;
export const SCALE_MIN = 0.01;
export const SCALE_MAX = 8;
const MAX_TIME = 36_000;
const CLIP_ID_MAX = 64;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysWithin = (o: Obj, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isClipId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= CLIP_ID_MAX;

/** Validates a message from the UI. Anything else (unknown type, extra field, bad value) gives null and is ignored. */
export function parseIncoming(data: unknown): PreviewIncoming | null {
  if (!isObj(data)) return null;
  switch (data.type) {
    case 'seek':
      return keysWithin(data, ['type', 't']) && finite(data.t) && data.t >= 0 && data.t <= MAX_TIME ? { type: 'seek', t: data.t } : null;
    case 'play': {
      if (!keysWithin(data, ['type', 'loop', 'rate'])) return null;
      if (data.loop !== undefined && typeof data.loop !== 'boolean') return null;
      if (data.rate !== undefined && !(finite(data.rate) && data.rate >= RATE_MIN && data.rate <= RATE_MAX)) return null;
      return { type: 'play', ...(data.loop !== undefined ? { loop: data.loop } : {}), ...(data.rate !== undefined ? { rate: data.rate } : {}) };
    }
    case 'pause':
      return keysWithin(data, ['type']) ? { type: 'pause' } : null;
    case 'select':
      return keysWithin(data, ['type', 'clipId']) && (data.clipId === null || isClipId(data.clipId)) ? { type: 'select', clipId: data.clipId } : null;
    case 'setScale':
      return keysWithin(data, ['type', 'scale']) && (data.scale === 'fit' || (finite(data.scale) && data.scale >= SCALE_MIN && data.scale <= SCALE_MAX))
        ? { type: 'setScale', scale: data.scale } : null;
    default:
      return null;
  }
}

const isRect = (v: unknown): v is Rect => isObj(v) && finite(v.x) && finite(v.y) && finite(v.width) && finite(v.height);
const isError = (v: unknown): v is RuntimeError => isObj(v) && (RUNTIME_ERROR_CODES as readonly unknown[]).includes(v.code) && typeof v.message === 'string'
  && (v.clipId === undefined || typeof v.clipId === 'string');
const isScene = (v: unknown): v is SceneInfo => isObj(v) && typeof v.id === 'string' && finite(v.start) && finite(v.duration);

/** Validates a message from the runtime (for the UI side). Null when it is not a well-formed outgoing message. */
export function parseOutgoing(data: unknown): PreviewOutgoing | null {
  if (!isObj(data)) return null;
  switch (data.type) {
    case 'ready':
      return data.version === PREVIEW_PROTOCOL_VERSION && finite(data.duration) && finite(data.fps) && finite(data.width) && finite(data.height)
        && Array.isArray(data.scenes) && data.scenes.every(isScene) && Array.isArray(data.errors) && data.errors.every(isError)
        ? data as PreviewOutgoing : null;
    case 'time':
      return finite(data.t) && typeof data.playing === 'boolean' ? { type: 'time', t: data.t, playing: data.playing } : null;
    case 'error':
      return isError(data.error) ? data as PreviewOutgoing : null;
    case 'clipBounds':
      return (data.clipId === null || typeof data.clipId === 'string') && (data.bounds === null || isRect(data.bounds)) && finite(data.scale)
        ? data as PreviewOutgoing : null;
    default:
      return null;
  }
}

/** The parent origin from the page URL: an exact serialized http(s) origin, or null (no messaging at all). */
export function parseParentOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.origin === value ? value : null;
}
