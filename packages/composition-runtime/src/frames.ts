import type { Natives } from './clock.ts';

/** Thrown when no native animation frame arrives in render mode: capturing then would risk a stale frame. */
export class FrameTimeoutError extends Error {
  readonly code = 'frameTimeout';
  constructor(ms: number) { super(`no animation frame within ${ms} ms`); this.name = 'FrameTimeoutError'; }
}

/**
 * How to wait for frames:
 * - `preview`: a missing frame (a hidden or throttled frame produces none) is not an error; after `fallbackMs` of native
 *   time the wait ends anyway (the default, 100 ms);
 * - `render`: the wait is long (the seek timeout) and a missing frame rejects with `FrameTimeoutError`, which fails the
 *   seek, so the renderer never captures a frame that was not painted.
 */
export interface FrameWait { strict: boolean; timeoutMs: number }
export const PREVIEW_FRAME_WAIT: FrameWait = { strict: false, timeoutMs: 100 };

/**
 * Resolves on the next native animation frame (see `FrameWait` for when none comes). Always native: under the virtual
 * clock a frozen `requestAnimationFrame` would never fire, so waiting on it would deadlock the seek.
 */
export function nextFrame(n: Natives, wait: FrameWait = PREVIEW_FRAME_WAIT): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const id = n.setTimeout(() => {
      if (done) return;
      done = true;
      if (wait.strict) reject(new FrameTimeoutError(wait.timeoutMs)); else resolve();
    }, wait.timeoutMs);
    n.requestAnimationFrame(() => {
      if (done) return;
      done = true;
      n.clearTimeout(id);
      resolve();
    });
  });
}

/** Two animation frames: the first lets style and layout settle after a seek, the second guarantees a paint. */
export async function twoFrames(n: Natives, wait: FrameWait = PREVIEW_FRAME_WAIT): Promise<void> {
  await nextFrame(n, wait);
  await nextFrame(n, wait);
}

/** `p`, or a rejection with `message` after `ms` of native time. */
export function withTimeout<T>(p: Promise<T>, ms: number, n: Natives, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = n.setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { n.clearTimeout(id); resolve(v); }, (e: unknown) => { n.clearTimeout(id); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}
