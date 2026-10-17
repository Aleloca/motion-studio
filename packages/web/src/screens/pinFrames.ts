// The feedback frames of sent comments (Task 8, carry 9): the core keeps them in its protected cache and hands out short-lived
// signed URLs (`GET …/pin-frames/:n`); they are asked again before they expire, so a page left open keeps its thumbnails. A
// failed read is tried again with a backoff (at most MAX_REFRESH_RETRIES times in a row); one timer per version.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { backoffMs, MAX_REFRESH_RETRIES, refreshDelay } from '../components/compositionPreview.ts';

/** version n → file → signed URL, for the versions `ns` (a version without frames maps to an empty record). */
export function usePinFrames(slug: string, creative: string, ns: number[]): Record<number, Record<string, string>> {
  const [frames, setFrames] = useState<Record<number, Record<string, string>>>({});
  const key = [...new Set(ns)].sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const timers = new Map<number, number>();
    const later = (n: number, ms: number, f: () => void) => {
      window.clearTimeout(timers.get(n));
      timers.set(n, window.setTimeout(() => { if (alive) f(); }, ms));
    };
    const load = (n: number, failures: number) => {
      Promise.resolve().then(() => api.getPinFrames(slug, creative, n)).then((r) => {
        if (!alive) return;
        setFrames((f) => ({ ...f, [n]: Object.fromEntries(r.frames.map((x) => [x.file, x.url])) }));
        const at = r.expiresAt ? Date.parse(r.expiresAt) : Number.NaN;
        if (Number.isFinite(at)) later(n, refreshDelay(at), () => load(n, 0));
      }, () => {
        // The comment shows without its frame meanwhile; then the frame is asked again.
        if (alive && failures < MAX_REFRESH_RETRIES) later(n, backoffMs(failures), () => load(n, failures + 1));
      });
    };
    for (const n of key.split(',').map(Number)) load(n, 0);
    return () => { alive = false; timers.forEach((id) => window.clearTimeout(id)); };
  }, [slug, creative, key]);
  return frames;
}
