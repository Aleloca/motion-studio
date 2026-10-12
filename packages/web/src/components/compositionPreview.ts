// The live preview's session and the storyboards of a v2 version's format (Task 8), with the core's refusals turned into
// calm states:
// - a legacy version (preview-session 404) is no error: the caller shows its media (carry 6);
// - busy (429 `preview-busy`: the preview lane, carries 8 and 15) and a frame that never got ready (the desktop refuses a
//   composition server that moved until its next origin poll, carry 14) retry with a backoff, shown as "busy". Attached to
//   another instance, the desktop polls that origin every 5 s: after a restart on a new port previews fail closed for up to
//   5 s (the stall, then a fresh session in a new frame), and the old origin may stay allowed until the next good poll;
// - sessions and the storyboards' signed image URLs expire: both are asked again shortly before (carry 7), so a page left
//   open keeps working. A new session mounts a new frame (CompositionPlayer's `key`), never a new src.
//
// Sessions are shared and released (fix round 1, I2). The core keeps at most MAX_PREVIEW_SESSIONS live sessions and ends
// the oldest one past that, so hover previews must never pile up behind a player still in use:
// - one session per (creative, version, format) for the whole page, reused by every player of it (a board's hover, its
//   pinned preview, the format view, Compare) until it nears its expiry;
// - counted by its users: when the last one lets go it stays a short grace (the pointer coming back) and is then ended on
//   the core (`DELETE …/preview-session/:token`), its media lease returned;
// - a new session of another key ends every unused one at once, so at most one idle session lives at any time, and a
//   session in use (pinned, playing, open in the format view) is never ended by hovering over other boards.
import type { PreviewSessionInfo, StoryboardView } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { message } from '../errors.ts';

/** Ask again this long before an expiry. */
export const REFRESH_BEFORE_MS = 60_000;
/** Backoff of the retries: 1 s, 2 s, 4 s, 8 s, then every 10 s. */
export const backoffMs = (attempt: number) => Math.min(10_000, 1000 * 2 ** Math.max(0, attempt));
/** An unused session is ended this long after its last user let go (unless another key needs a session first). */
export const RELEASE_GRACE_MS = 5000;
/** A failed refresh of signed URLs is tried this many times, then the images are dropped (they are expiring). */
export const MAX_REFRESH_RETRIES = 5;
const MIN_REFRESH_MS = 5000;

const refreshIn = (expiresAt: string) => {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? Math.max(MIN_REFRESH_MS, at - Date.now() - REFRESH_BEFORE_MS) : null;
};
const status = (e: unknown) => (e instanceof ApiError ? e.status : (e as { status?: unknown })?.status);

// ---- the page's preview sessions ----

interface SessionEntry {
  key: string; slug: string; creative: string; n: number; format: string;
  session: PreviewSessionInfo | null;
  pending: Promise<PreviewSessionInfo> | null;
  users: number;
  idle: number;
}
const sessions = new Map<string, SessionEntry>();
/** Still usable: more than the refresh margin (and a second) before its expiry. */
const usable = (s: PreviewSessionInfo | null): s is PreviewSessionInfo => s !== null && Date.parse(s.expiresAt) - Date.now() > REFRESH_BEFORE_MS + 1000;

const revokeOnCore = (e: { slug: string; creative: string; n: number }, s: PreviewSessionInfo | null) => {
  if (!s?.token) return;
  Promise.resolve().then(() => api.revokePreview(e.slug, e.creative, e.n, s.token)).catch(() => { /* it expires by itself */ });
};
function end(e: SessionEntry): void {
  window.clearTimeout(e.idle);
  if (sessions.get(e.key) === e) sessions.delete(e.key);
  revokeOnCore(e, e.session);
  e.session = null;
}
/** Ends every session nobody uses, but `keep`'s. */
function endIdle(keep: string): void {
  for (const e of [...sessions.values()]) if (e.users === 0 && e.key !== keep) end(e);
}

function hold(o: { key: string; slug: string; creative: string; n: number; format: string }): SessionEntry {
  let e = sessions.get(o.key);
  if (!e) { e = { ...o, session: null, pending: null, users: 0, idle: 0 }; sessions.set(o.key, e); }
  window.clearTimeout(e.idle);
  e.users += 1;
  return e;
}
function letGo(e: SessionEntry): void {
  e.users = Math.max(0, e.users - 1);
  if (e.users > 0) return;
  window.clearTimeout(e.idle);
  e.idle = window.setTimeout(() => { if (e.users === 0) end(e); }, RELEASE_GRACE_MS);
}
/** The entry's session: the one held while usable, else a new one (shared by concurrent callers). */
function sessionOf(e: SessionEntry): Promise<PreviewSessionInfo> {
  if (usable(e.session)) return Promise.resolve(e.session);
  if (e.pending) return e.pending;
  endIdle(e.key);
  const p = Promise.resolve().then(() => api.previewSession(e.slug, e.creative, e.n, e.format, window.location.origin)).then((s) => {
    const old = e.session;
    e.pending = null;
    if (sessions.get(e.key) !== e) { revokeOnCore(e, s); throw new Error('released'); }
    e.session = s;
    // A renewed session: the players move to the new one at once; the old one is ended after the grace.
    if (old && old.token !== s.token) window.setTimeout(() => revokeOnCore(e, old), RELEASE_GRACE_MS);
    return s;
  }, (err: unknown) => { e.pending = null; throw err; });
  e.pending = p;
  return p;
}
/** A frame never got ready on this session: it is not reused. */
function drop(e: SessionEntry, s: PreviewSessionInfo): void {
  if (e.session?.token !== s.token) return;
  e.session = null;
  revokeOnCore(e, s);
}

/** Tests: forget every session (nothing is sent). */
export function __resetPreviewSessions(): void {
  for (const e of sessions.values()) window.clearTimeout(e.idle);
  sessions.clear();
}

export type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; session: PreviewSessionInfo }
  | { kind: 'busy' }
  | { kind: 'legacy' }
  | { kind: 'failed'; message: string };

export interface PreviewSessionOptions { slug: string; creative: string; n: number | null; format: string; enabled: boolean }

/** The live preview session of (version n, format) while `enabled` (held only then: a board takes it on hover or click). */
export function usePreviewSession(o: PreviewSessionOptions): { state: PreviewState; stalled(): void; retry(): void } {
  const [state, setState] = useState<PreviewState>({ kind: 'idle' });
  const key = o.enabled && o.n !== null ? `${o.slug}/${o.creative}/${o.n}/${o.format}` : null;
  // A run of the effect: `wait` after a stall (the server needs a moment to be allowed again); a retry starts at once.
  const [run, setRun] = useState<{ key: string | null; n: number; wait: boolean }>({ key: null, n: 0, wait: false });
  const attempt = useRef({ key: null as string | null, n: 0 });
  const current = useRef<PreviewSessionInfo | null>(null);
  const entry = useRef<SessionEntry | null>(null);

  // Held while enabled; let go (and ended after the grace when nobody else uses it) when disabled or unmounted.
  useEffect(() => {
    if (key === null || o.n === null) { entry.current = null; return; }
    const e = hold({ key, slug: o.slug, creative: o.creative, n: o.n, format: o.format });
    entry.current = e;
    return () => { if (entry.current === e) entry.current = null; letGo(e); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (attempt.current.key !== key) attempt.current = { key, n: 0 };
    const e = entry.current;
    if (key === null || !e) { setState({ kind: 'idle' }); current.current = null; return; }
    let alive = true;
    let timer = 0;
    const later = (ms: number, f: () => void) => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (alive) f(); }, ms); };
    const get = (renewal: boolean) => {
      if (!renewal) setState((s) => (s.kind === 'busy' || (s.kind === 'ready' && usable(s.session)) ? s : { kind: 'loading' }));
      sessionOf(e).then((session) => {
        if (!alive) return;
        attempt.current.n = 0;
        current.current = session;
        setState((s) => (s.kind === 'ready' && s.session.token === session.token ? s : { kind: 'ready', session }));
        const next = refreshIn(session.expiresAt);
        if (next !== null) later(next, () => get(true));
      }, (err: unknown) => {
        if (!alive) return;
        const code = status(err);
        if (code === 404) { setState({ kind: 'legacy' }); return; }
        if (code === 429 || renewal) {
          // Busy, or a renewal that failed while the frame still plays: calm, and again after a while.
          if (!renewal) setState({ kind: 'busy' });
          later(backoffMs(attempt.current.n++), () => get(renewal));
          return;
        }
        setState({ kind: 'failed', message: message(err) });
      });
    };
    if (run.wait && run.key === key) { setState({ kind: 'busy' }); later(backoffMs(attempt.current.n++), () => get(false)); } else get(false);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [key, run]); // eslint-disable-line react-hooks/exhaustive-deps

  const stalled = useCallback(() => {
    const e = entry.current;
    if (e && current.current) drop(e, current.current);
    setRun((r) => ({ key, n: r.n + 1, wait: true }));
  }, [key]);
  const retry = useCallback(() => { attempt.current.n = 0; setRun((r) => ({ key, n: r.n + 1, wait: false })); }, [key]);
  return { state, stalled, retry };
}

export type StoryboardState = 'idle' | 'loading' | 'ready' | 'busy' | 'none';

/**
 * The storyboard of (version n, format) while `enabled`, asked again before its image URLs expire; `hash` (the
 * composition's) asks again when the version's composition is another one. `none`: there is none (no renderer, an
 * invalid composition, a legacy format). A refresh that keeps failing is tried MAX_REFRESH_RETRIES times, then the
 * images (expiring by then) are dropped.
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
    // `first`: the first load (loading); `retry`: after a busy answer (stays busy until it works); `refresh`: new URLs.
    const load = (mode: 'first' | 'retry' | 'refresh') => {
      Promise.resolve().then(() => api.getStoryboard(o.slug, o.creative, n, o.format)).then((sb) => {
        if (!alive) return;
        attempt = 0;
        setStoryboard(sb);
        setState('ready');
        const next = refreshIn(sb.expiresAt);
        if (next !== null) later(next, () => load('refresh'));
      }, (e: unknown) => {
        if (!alive) return;
        if (mode === 'refresh') {
          if (attempt >= MAX_REFRESH_RETRIES) { setStoryboard(null); setState('none'); return; }
          later(backoffMs(attempt++), () => load('refresh'));
          return;
        }
        if (status(e) === 429) {
          setState('busy');
          later(backoffMs(attempt++), () => load('retry'));
          return;
        }
        setStoryboard(null);
        setState('none');
      });
    };
    setStoryboard(null);
    setState('loading');
    load('first');
    return () => { alive = false; window.clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { storyboard, state };
}

/** The storyboard's poster frame (the frame at 1 s), else its first. */
export const posterOf = (sb: StoryboardView | null) => sb?.frames.find((f) => f.kind === 'poster') ?? sb?.frames[0] ?? null;
