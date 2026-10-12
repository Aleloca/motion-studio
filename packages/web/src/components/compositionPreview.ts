// The live preview's session and the storyboards of a v2 version's format (Task 8), with the core's refusals turned into
// calm states:
// - a legacy version (preview-session 404) is no error: the caller shows its media (carry 6);
// - busy (429 `preview-busy`: the preview lane, carries 8 and 15) and a frame that never got ready (the desktop refuses a
//   composition server that moved until its next origin poll, carry 14) retry with a backoff, shown as "busy". Attached to
//   another instance, the desktop polls that origin every 5 s: after a restart on a new port previews fail closed for up to
//   5 s (the stall, then a fresh session in a new frame), and the old origin may stay allowed until the next good poll;
// - sessions and the storyboards' signed image URLs expire: both are asked again shortly before (carry 7), so a page left
//   open keeps working. A new session mounts a new frame (CompositionPlayer's `key`), never a new src.
import type { PreviewSessionInfo, StoryboardView } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { message } from '../errors.ts';

/** Ask again this long before an expiry. */
export const REFRESH_BEFORE_MS = 60_000;
/** Backoff of the retries: 1 s, 2 s, 4 s, 8 s, then every 10 s. */
export const backoffMs = (attempt: number) => Math.min(10_000, 1000 * 2 ** Math.max(0, attempt));
const MIN_REFRESH_MS = 5000;

const refreshIn = (expiresAt: string) => {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? Math.max(MIN_REFRESH_MS, at - Date.now() - REFRESH_BEFORE_MS) : null;
};
const status = (e: unknown) => (e instanceof ApiError ? e.status : (e as { status?: unknown })?.status);

export type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; session: PreviewSessionInfo }
  | { kind: 'busy' }
  | { kind: 'legacy' }
  | { kind: 'failed'; message: string };

export interface PreviewSessionOptions { slug: string; creative: string; n: number | null; format: string; enabled: boolean }

/** The live preview session of (version n, format) while `enabled` (minted only then: a board starts it on hover or click). */
export function usePreviewSession(o: PreviewSessionOptions): { state: PreviewState; stalled(): void; retry(): void } {
  const [state, setState] = useState<PreviewState>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const attempt = useRef(0);
  const key = o.enabled && o.n !== null ? `${o.slug}/${o.creative}/${o.n}/${o.format}` : null;
  const timer = useRef(0);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (key === null || o.n === null) { setState({ kind: 'idle' }); return; }
    let alive = true;
    const n = o.n;
    const later = (ms: number, f: () => void) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { if (alive) f(); }, ms); };
    const mint = (renewal: boolean) => {
      if (!renewal) setState((s) => (s.kind === 'busy' ? s : { kind: 'loading' }));
      Promise.resolve().then(() => api.previewSession(o.slug, o.creative, n, o.format, window.location.origin)).then((session) => {
        if (!alive) return;
        attempt.current = 0;
        setState({ kind: 'ready', session });
        const next = refreshIn(session.expiresAt);
        if (next !== null) later(next, () => mint(true));
      }, (e: unknown) => {
        if (!alive) return;
        const code = status(e);
        if (code === 404) { setState({ kind: 'legacy' }); return; }
        if (code === 429 || renewal) {
          // Busy, or a renewal that failed while the frame still plays: calm, and again after a while.
          if (!renewal) setState({ kind: 'busy' });
          later(backoffMs(attempt.current++), () => mint(renewal));
          return;
        }
        setState({ kind: 'failed', message: message(e) });
      });
    };
    // A stall (nonce > 0) waits the backoff first: the server needs a moment to be allowed again.
    if (nonce > 0) { setState({ kind: 'busy' }); later(backoffMs(attempt.current++), () => mint(false)); } else mint(false);
    return () => { alive = false; window.clearTimeout(timer.current); };
  }, [key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const stalled = useCallback(() => setNonce((x) => x + 1), []);
  const retry = useCallback(() => { attempt.current = 0; setNonce((x) => x + 1); }, []);
  return { state, stalled, retry };
}

export type StoryboardState = 'idle' | 'loading' | 'ready' | 'busy' | 'none';

/**
 * The storyboard of (version n, format) while `enabled`, asked again before its image URLs expire; `hash` (the
 * composition's) asks again when the version's composition is another one. `none`: there is none (no renderer, an
 * invalid composition, a legacy format).
 */
export function useStoryboard(o: { slug: string; creative: string; n: number | null; format: string; hash: string | null; enabled: boolean }): { storyboard: StoryboardView | null; state: StoryboardState } {
  const [storyboard, setStoryboard] = useState<StoryboardView | null>(null);
  const [state, setState] = useState<StoryboardState>('idle');
  const key = o.enabled && o.n !== null && o.hash !== null ? `${o.slug}/${o.creative}/${o.n}/${o.format}/${o.hash}` : null;
  useEffect(() => {
    if (key === null || o.n === null) { setStoryboard(null); setState('idle'); return; }
    let alive = true;
    let timer = 0;
    let attempt = 0;
    const n = o.n;
    const later = (ms: number, f: () => void) => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (alive) f(); }, ms); };
    const load = (first: boolean) => {
      if (first) setState('loading');
      Promise.resolve().then(() => api.getStoryboard(o.slug, o.creative, n, o.format)).then((sb) => {
        if (!alive) return;
        attempt = 0;
        setStoryboard(sb);
        setState('ready');
        const next = refreshIn(sb.expiresAt);
        if (next !== null) later(next, () => load(false));
      }, (e: unknown) => {
        if (!alive) return;
        if (status(e) === 429 || !first) {
          if (first) setState('busy');
          later(backoffMs(attempt++), () => load(first));
          return;
        }
        setStoryboard(null);
        setState('none');
      });
    };
    setStoryboard(null);
    load(true);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { storyboard, state };
}

/** The storyboard's poster frame (the frame at 1 s), else its first. */
export const posterOf = (sb: StoryboardView | null) => sb?.frames.find((f) => f.kind === 'poster') ?? sb?.frames[0] ?? null;
