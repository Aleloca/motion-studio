// The feedback frames of sent comments (Task 8, carry 9): the core keeps them in its protected cache and hands out short-lived
// signed URLs (`GET …/pin-frames/:n`); they are asked again before they expire, so a page left open keeps its thumbnails.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { REFRESH_BEFORE_MS } from '../components/compositionPreview.ts';

/** version n → file → signed URL, for the versions `ns` (a version without frames maps to an empty record). */
export function usePinFrames(slug: string, creative: string, ns: number[]): Record<number, Record<string, string>> {
  const [frames, setFrames] = useState<Record<number, Record<string, string>>>({});
  const key = [...new Set(ns)].sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const timers: number[] = [];
    const load = (n: number) => {
      Promise.resolve().then(() => api.getPinFrames(slug, creative, n)).then((r) => {
        if (!alive) return;
        setFrames((f) => ({ ...f, [n]: Object.fromEntries(r.frames.map((x) => [x.file, x.url])) }));
        const at = r.expiresAt ? Date.parse(r.expiresAt) : Number.NaN;
        if (Number.isFinite(at)) timers.push(window.setTimeout(() => { if (alive) load(n); }, Math.max(5000, at - Date.now() - REFRESH_BEFORE_MS)));
      }, () => { /* the comment shows without its frame */ });
    };
    for (const n of key.split(',').map(Number)) load(n);
    return () => { alive = false; timers.forEach((id) => window.clearTimeout(id)); };
  }, [slug, creative, key]);
  return frames;
}
