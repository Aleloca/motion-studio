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
// - no renderer or an invalid composition (404/422) gives `none`: the caller keeps today's placeholder; another error (or a
//   busy core, 429, still busy after a few tries with a backoff) gives `failed`, asked again after NONE_TTL_MS;
// - a thumbnail that leaves (the page unmounts) before its request reached the core takes it out of the line (review 2).
import type { CompositionStill, StoryboardView } from '@motion-studio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { backoffMs, posterOf, refreshDelay, REFRESH_BEFORE_MS } from './compositionPreview.ts';

export const MAX_STILLS_AT_ONCE = 2;
/** A busy answer is asked again this many times, then the thumbnail keeps its placeholder. */
export const MAX_BUSY_RETRIES = 4;
/** A still that could not be had is not asked again for this long (no renderer: every card would ask again). */
export const NONE_TTL_MS = 60_000;

export type StillRef = CompositionStill & { slug: string; creative: string };
export type StillState = 'idle' | 'loading' | 'ready' | 'none' | 'failed';

/** What a still request gave: the storyboard, `none` (there is none: 404/422) or `failed` (another error: asked again later). */
export type StillAnswer = StoryboardView | 'none' | 'failed';
type Entry = { answer: StillAnswer; until: number };
/** A request of one key: the thumbnails waiting for it; `cancel` drops it while it has not reached the core yet. */
type Pending = { promise: Promise<StillAnswer>; waiters: number; cancel(): void };
const answers = new Map<string, Entry>();
const pending = new Map<string, Pending>();
type Ticket = { start(): void; drop(): void };
const line: Ticket[] = [];
let running = 0;

const keyOf = (s: StillRef) => `${s.slug}/${s.creative}/${s.n}/${s.format}/${s.hash}`;
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : (e as { status?: unknown })?.status);
const CANCELLED = Symbol('cancelled');

/**
 * Runs `job` when one of the MAX_STILLS_AT_ONCE slots is free. `onTicket` gets the ticket while it waits in line: dropping it
 * takes it out of the line (it rejects with CANCELLED) and leaves the slots to others (review 2).
 */
function inLine<T>(job: () => Promise<T>, onTicket: (t: Ticket | null) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ticket: Ticket = {
      start: () => {
        onTicket(null);
        running += 1;
        Promise.resolve().then(job).then(resolve, reject).finally(() => {
          running -= 1;
          line.shift()?.start();
        });
      },
      drop: () => {
        const i = line.indexOf(ticket);
        if (i < 0) return;
        line.splice(i, 1);
        onTicket(null);
        reject(CANCELLED);
      },
    };
    if (running < MAX_STILLS_AT_ONCE) ticket.start();
    else { line.push(ticket); onTicket(ticket); }
  });
}

/** One request of `s` (a busy core is asked again with a backoff); CANCELLED when every thumbnail left first. */
function request(s: StillRef): Pending {
  let cancelled = false;
  let ticket: Ticket | null = null;
  let timer = 0;
  let wake: (() => void) | null = null;
  const run = async (): Promise<StillAnswer> => {
    for (let attempt = 0; ; attempt++) {
      if (cancelled) throw CANCELLED;
      try {
        return await inLine(() => api.getStoryboard(s.slug, s.creative, s.n, s.format), (t) => { ticket = t; });
      } catch (e) {
        if (e === CANCELLED || cancelled) throw CANCELLED;
        const code = statusOf(e);
        if (code === 404 || code === 422) return 'none';
        if (code !== 429 || attempt >= MAX_BUSY_RETRIES) return 'failed';
        await new Promise<void>((r) => { wake = r; timer = window.setTimeout(r, backoffMs(attempt)); });
        wake = null;
      }
    }
  };
  return {
    promise: run(), waiters: 0,
    cancel: () => {
      cancelled = true;
      ticket?.drop();
      window.clearTimeout(timer);
      (wake as (() => void) | null)?.();
    },
  };
}

/**
 * The storyboard of `s`, shared by every thumbnail of it on the page. With `signal`, the caller may leave: when every
 * caller of a key has left before its request reached the core, the request is dropped (resolves `failed`, not kept).
 */
export function fetchStill(s: StillRef, signal?: AbortSignal): Promise<StillAnswer> {
  const key = keyOf(s);
  const have = answers.get(key);
  if (have && have.until > Date.now()) return Promise.resolve(have.answer);
  let p = pending.get(key);
  if (!p) {
    const made = request(s);
    made.promise = made.promise.then((answer) => {
      const at = typeof answer === 'object' ? Date.parse(answer.expiresAt) : NaN;
      answers.set(key, { answer, until: typeof answer === 'object' ? (Number.isFinite(at) ? at - REFRESH_BEFORE_MS - 1000 : 0) : Date.now() + NONE_TTL_MS });
      return answer;
    }, (e: unknown) => { if (e === CANCELLED) return 'failed' as const; throw e; }).finally(() => { if (pending.get(key) === made) pending.delete(key); });
    pending.set(key, made);
    p = made;
  }
  const mine = p;
  mine.waiters += 1;
  signal?.addEventListener('abort', () => {
    mine.waiters -= 1;
    if (mine.waiters === 0) { if (pending.get(key) === mine) pending.delete(key); mine.cancel(); }
  }, { once: true });
  return mine.promise;
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
 * `none`: there is none (404/422: the caller keeps its placeholder); `failed`: it could not be had now, asked again after
 * NONE_TTL_MS while mounted. Unmounted before its turn, the request is dropped (review 2).
 */
export function useCompositionStill(still: StillRef | null, enabled: boolean): { url: string | null; state: StillState } {
  const [got, setGot] = useState<{ key: string; url: string | null; state: StillState }>({ key: '', url: null, state: 'idle' });
  const key = still ? keyOf(still) : null;
  useEffect(() => {
    if (!still || !key || !enabled) return;
    const leave = new AbortController();
    let timer = 0;
    const load = () => {
      void fetchStill(still, leave.signal).then((answer) => {
        if (leave.signal.aborted) return;
        const view = typeof answer === 'object' ? answer : null;
        const url = posterOf(view)?.url ?? null;
        setGot({ key, url, state: url ? 'ready' : answer === 'failed' ? 'failed' : 'none' });
        const at = view ? Date.parse(view.expiresAt) : NaN;
        if (url && Number.isFinite(at)) timer = window.setTimeout(load, refreshDelay(at));
        else if (answer === 'failed') timer = window.setTimeout(load, NONE_TTL_MS);
      });
    };
    setGot((g) => (g.key === key ? g : { key, url: null, state: 'loading' }));
    load();
    return () => { leave.abort(); window.clearTimeout(timer); };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!still) return { url: null, state: 'none' };
  return got.key === key ? { url: got.url, state: got.state } : { url: null, state: enabled ? 'loading' : 'idle' };
}
