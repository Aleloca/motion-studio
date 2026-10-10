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
  /** Render mode: no animation frame was painted after a seek; the seek fails rather than capture a stale frame. */
  'frameTimeout',
  /**
   * Render mode, a warning (untrusted sources only, the lenient rule): a video showed a frame whose own timestamp and
   * duration do not cover the target (a wrong container duration, or a target before the source starts), drawn once its
   * timestamp was stable. The renderer does not fail on it.
   */
  'videoFrameMismatch',
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

/** Caps on what `parseOutgoing` accepts (the UI side never trusts sizes blindly). */
export const OUTGOING_LIMITS = { message: 2000, id: 64, name: 200, scenes: 200, errors: 200 } as const;

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const rect = (v: unknown): Rect | null => (isObj(v) && finite(v.x) && finite(v.y) && finite(v.width) && finite(v.height)
  ? { x: v.x, y: v.y, width: v.width, height: v.height } : null);
const runtimeError = (v: unknown): RuntimeError | null => {
  if (!isObj(v) || !(RUNTIME_ERROR_CODES as readonly unknown[]).includes(v.code) || typeof v.message !== 'string') return null;
  if (v.clipId !== undefined && !str(v.clipId, OUTGOING_LIMITS.id)) return null;
  return { code: v.code as RuntimeErrorCode, message: v.message.slice(0, OUTGOING_LIMITS.message), ...(v.clipId !== undefined ? { clipId: v.clipId } : {}) };
};
const scene = (v: unknown): SceneInfo | null => {
  if (!isObj(v) || !str(v.id, OUTGOING_LIMITS.id) || !finite(v.start) || !finite(v.duration)) return null;
  if (v.name !== undefined && !str(v.name, OUTGOING_LIMITS.name)) return null;
  return { id: v.id, ...(v.name !== undefined ? { name: v.name } : {}), start: v.start, duration: v.duration };
};
/** Maps every element with `f`; null when the value is not an array, is longer than `max`, or any element is invalid. */
function all<T>(v: unknown, max: number, f: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) { const y = f(x); if (y === null) return null; out.push(y); }
  return out;
}

/**
 * Validates a message from the runtime (for the UI side) and returns a clean copy: unknown keys are dropped, strings are
 * type-checked and bounded (an error message is cut to `OUTGOING_LIMITS.message`; an over-long id or name rejects the
 * message). Null when it is not a well-formed outgoing message.
 */
export function parseOutgoing(data: unknown): PreviewOutgoing | null {
  if (!isObj(data)) return null;
  switch (data.type) {
    case 'ready': {
      if (data.version !== PREVIEW_PROTOCOL_VERSION || !finite(data.duration) || !finite(data.fps) || !finite(data.width) || !finite(data.height)) return null;
      const scenes = all(data.scenes, OUTGOING_LIMITS.scenes, scene);
      const errors = all(data.errors, OUTGOING_LIMITS.errors, runtimeError);
      if (!scenes || !errors) return null;
      return { type: 'ready', version: PREVIEW_PROTOCOL_VERSION, duration: data.duration, fps: data.fps, width: data.width, height: data.height, scenes, errors };
    }
    case 'time':
      return finite(data.t) && typeof data.playing === 'boolean' ? { type: 'time', t: data.t, playing: data.playing } : null;
    case 'error': {
      const error = runtimeError(data.error);
      return error ? { type: 'error', error } : null;
    }
    case 'clipBounds': {
      if (!(data.clipId === null || str(data.clipId, OUTGOING_LIMITS.id)) || !finite(data.scale)) return null;
      const bounds = data.bounds === null ? null : rect(data.bounds);
      if (data.bounds !== null && !bounds) return null;
      return { type: 'clipBounds', clipId: data.clipId, bounds, scale: data.scale };
    }
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
