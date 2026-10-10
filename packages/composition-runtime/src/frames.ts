import type { Natives } from './clock.ts';

/**
 * Resolves on the next native animation frame, or after `fallbackMs` of native time when no frame comes (a hidden or
 * throttled frame produces none). Always native: under the virtual clock a frozen `requestAnimationFrame` would never
 * fire, so waiting on it would deadlock the seek.
 */
export function nextFrame(n: Natives, fallbackMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    n.requestAnimationFrame(finish);
    n.setTimeout(finish, fallbackMs);
  });
}

/** Two animation frames: the first lets style and layout settle after a seek, the second guarantees a paint. */
export async function twoFrames(n: Natives, fallbackMs = 100): Promise<void> {
  await nextFrame(n, fallbackMs);
  await nextFrame(n, fallbackMs);
}

/** `p`, or a rejection with `message` after `ms` of native time. */
export function withTimeout<T>(p: Promise<T>, ms: number, n: Natives, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = n.setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { n.clearTimeout(id); resolve(v); }, (e: unknown) => { n.clearTimeout(id); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}
