// Reports 45/47: a still of a version's composition, for the thumbnails outside the canvas (creative cards, project covers,
// "Jump back in", the export dialogs, the version menus) when the version has no render file (decision 974). It is the
// canvas's own picture: the storyboard's poster frame, from the core's storyboard route (same cache under
// `.studio/cache/storyboards`, same hash checks, short-lived signed image URLs).
//
// The Projects page and the Creatives list may ask for many at once, and a storyboard not made yet needs Chromium, so:
// - asked only once the thumbnail has been on screen (`useSeen`; without IntersectionObserver, at once);
// - at most MAX_STILLS_AT_ONCE requests run at a time on the whole page, the others wait in line (the core's preview lane
//   has two slots: more would only be refused as busy);
// - one request per (creative, version, format, hash) for the whole page, its answer kept until its URLs near expiry;
// - no renderer (404) or an error gives `none`: the caller keeps today's placeholder. A busy core (429) is asked again a
//   few times with a backoff, then `none`.
import type { CompositionStill, StoryboardView } from '@motion-studio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { backoffMs, posterOf, refreshDelay, REFRESH_BEFORE_MS } from './compositionPreview.ts';

export const MAX_STILLS_AT_ONCE = 2;
/** A busy answer is asked again this many times, then the thumbnail keeps its placeholder. */
export const MAX_BUSY_RETRIES = 4;
/** A still that could not be made is not asked again for this long (no renderer: every card would ask again). */
export const NONE_TTL_MS = 60_000;

export type StillRef = CompositionStill & { slug: string; creative: string };
export type StillState = 'idle' | 'loading' | 'ready' | 'none';

type Entry = { view: StoryboardView | null; until: number };
const answers = new Map<string, Entry>();
const pending = new Map<string, Promise<StoryboardView | null>>();
const line: Array<() => void> = [];
let running = 0;

const keyOf = (s: StillRef) => `${s.slug}/${s.creative}/${s.n}/${s.format}/${s.hash}`;
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : (e as { status?: unknown })?.status);
const wait = (ms: number) => new Promise<void>((r) => { window.setTimeout(r, ms); });

/** Runs `job` when one of the MAX_STILLS_AT_ONCE slots is free. */
function inLine<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      Promise.resolve().then(job).then(resolve, reject).finally(() => {
        running -= 1;
        line.shift()?.();
      });
    };
    if (running < MAX_STILLS_AT_ONCE) start(); else line.push(start);
  });
}

async function ask(s: StillRef): Promise<StoryboardView | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await inLine(() => api.getStoryboard(s.slug, s.creative, s.n, s.format));
    } catch (e) {
      if (statusOf(e) !== 429 || attempt >= MAX_BUSY_RETRIES) return null;
      await wait(backoffMs(attempt));
    }
  }
}

/** The storyboard of `s` (shared by every thumbnail of it on the page); null when there is none. */
export function fetchStill(s: StillRef): Promise<StoryboardView | null> {
  const key = keyOf(s);
  const have = answers.get(key);
  if (have && have.until > Date.now()) return Promise.resolve(have.view);
  const going = pending.get(key);
  if (going) return going;
  const p = ask(s).then((view) => {
    const at = view ? Date.parse(view.expiresAt) : NaN;
    answers.set(key, { view, until: view ? (Number.isFinite(at) ? at - REFRESH_BEFORE_MS - 1000 : 0) : Date.now() + NONE_TTL_MS });
    return view;
  }).finally(() => { pending.delete(key); });
  pending.set(key, p);
  return p;
}

/** Tests: forget every answer and the line. */
export function __resetStills(): void {
  answers.clear();
  pending.clear();
  line.length = 0;
  running = 0;
}

/** A callback ref and whether its element has been on screen (it stays true; without IntersectionObserver: at once). */
export function useSeen<T extends Element>(): { ref(el: T | null): void; seen: boolean } {
  const [el, setEl] = useState<T | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !el) return;
    const io = new IntersectionObserver((list) => { if (list.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  const ref = useCallback((x: T | null) => setEl(x), []);
  return { ref, seen };
}

/**
 * The poster frame URL of `still` once `enabled` (on screen), asked again before its signed URL expires while mounted.
 * `none`: there is none (the caller keeps its placeholder).
 */
export function useCompositionStill(still: StillRef | null, enabled: boolean): { url: string | null; state: StillState } {
  const [got, setGot] = useState<{ key: string; url: string | null; state: StillState }>({ key: '', url: null, state: 'idle' });
  const key = still ? keyOf(still) : null;
  useEffect(() => {
    if (!still || !key || !enabled) return;
    let alive = true;
    let timer = 0;
    const load = () => {
      void fetchStill(still).then((view) => {
        if (!alive) return;
        const url = posterOf(view)?.url ?? null;
        setGot({ key, url, state: url ? 'ready' : 'none' });
        const at = view ? Date.parse(view.expiresAt) : NaN;
        if (url && Number.isFinite(at)) timer = window.setTimeout(load, refreshDelay(at));
      });
    };
    setGot((g) => (g.key === key ? g : { key, url: null, state: 'loading' }));
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!still) return { url: null, state: 'none' };
  return got.key === key ? { url: got.url, state: got.state } : { url: null, state: enabled ? 'loading' : 'idle' };
}
