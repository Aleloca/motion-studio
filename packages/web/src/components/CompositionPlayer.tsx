// The live composition player (Task 8, spec §5.2): the runtime page in an iframe on the composition server's own origin,
// `sandbox="allow-scripts"` only, driven by the postMessage protocol of @motion-studio/composition-runtime/protocol. It is
// exposed as a media element (`CompositionMedia`, the `SyncMedia` contract of ui/useSyncedMedia.ts), so the phase 7
// transport drives it as it drives a <video>: play and pause, scrub, frame step, loop, speed; Compare syncs two of them.
//
// Security (carries 1–3, 5):
// - Never `allow-same-origin`, `allow-popups` or `allow-top-navigation`: the frame is an opaque origin and cannot open
//   windows (the desktop's window-open handler relies on that) nor navigate the app.
// - A message counts only when `event.source` is this frame's window AND its origin is the frame's: "null" (the opaque
//   origin of the sandbox, what browsers report) or the composition server's (never seen with this sandbox; accepted so
//   the check stays right if the sandbox ever had to change). An html layer is a grandchild with its own window: refused.
//   Then `parseOutgoing` validates it.
// - Commands are validated with `parseIncoming` and posted to this frame's window only. The target origin is '*': an opaque
//   origin matches no named target, so a named one would never be delivered. Commands carry no secrets (times, a rate).
// - The frame's `src` is never changed: a new session (a renewal, the composition server restarted on another port) mounts
//   a new frame (React `key`), whose origin the desktop filter checks afresh.
// - Web residual (documented, carry 5): in a plain browser the preview's network is not locked down like a render's
//   (no request interception, no dead proxy); the CSP (`connect-src 'none'`) and the session token, which exposes only
//   that composition's files, are what confine it. The desktop app adds its frame filter (apps/desktop preview-filter.ts).
import { parseIncoming, parseOutgoing, RATE_MAX, RATE_MIN, type PreviewIncoming, type PreviewOutgoing, type RuntimeError, type RuntimeErrorCode } from '@motion-studio/composition-runtime/protocol';
import type { PreviewSessionInfo } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from '../ui/index.ts';
import type { SyncMedia } from '../ui/useSyncedMedia.ts';
import './player.css';

/** No `ready` from the runtime in this time: the frame is reported stalled (the caller mints a new session). */
export const READY_TIMEOUT_MS = 20_000;
/** Errors the runtime reports when the page cannot run at all (runtime-main `fail`). */
const FATAL: ReadonlySet<RuntimeErrorCode> = new Set(['compositionMissing', 'compositionInvalid', 'baseNotAllowed']);
/** Within half a frame of the end, a stop is the end. */
const END_EPS = 1 / 60;
/** Inline errors kept (the runtime may report many). */
const MAX_ERRORS = 20;

const clampRate = (r: number) => Math.min(RATE_MAX, Math.max(RATE_MIN, Number.isFinite(r) ? r : 1));

/**
 * The player as a media element. The time is the runtime's (`time` messages); `paused` is ours (what was asked last), so a
 * late `time` from before a pause never restarts it. Commands sent before `ready` wait: on `ready` the time is restored
 * (a remounted frame continues where the previous one was) and a pending play starts.
 *
 * Frames (final review A5, D1): a new session's frame is `expect`ed while the current one still plays; it takes over only
 * when it reports `ready` (then the player removes the old one). Until then commands and `time` messages stay with the
 * current frame, and a frame that is neither is ignored. After a `play` is sent, a "not playing" `time` (the end of the
 * seek that restored the time, possibly at the very end of a loop) never counts as the end: only once the runtime has
 * reported playing again.
 */
export class CompositionMedia implements SyncMedia {
  private readonly events = new EventTarget();
  private active: { id: string; send: (cmd: PreviewIncoming) => void } | null = null;
  private incoming: { id: string; send: (cmd: PreviewIncoming) => void } | null = null;
  /** A `play` was sent and the runtime has not reported playing since. */
  private awaitingPlay = false;
  private time = 0;
  private dur = Number.NaN;
  private isPaused = true;
  private rate = 1;
  defaultPlaybackRate = 1;
  /** The runtime loops by itself (the format view's Loop); Compare loops through useSyncedMedia instead. */
  loop = false;
  private isMuted = false;
  error: unknown = null;

  get currentTime(): number { return this.time; }
  set currentTime(t: number) {
    if (!Number.isFinite(t)) return;
    const max = Number.isFinite(this.dur) ? this.dur : Number.POSITIVE_INFINITY;
    this.time = Math.min(max, Math.max(0, t));
    this.post({ type: 'seek', t: this.time });
    // As a <video>: a seek while playing goes on playing (the runtime's seek pauses).
    if (!this.isPaused) this.post(this.playCommand());
  }
  get duration(): number { return this.dur; }
  /** As `<video>.muted`: every sound of the preview silenced (Compare's second player); sent again to a new frame. */
  get muted(): boolean { return this.isMuted; }
  set muted(m: boolean) {
    if (m === this.isMuted) return;
    this.isMuted = m;
    this.post({ type: 'mute', muted: m });
  }
  get paused(): boolean { return this.isPaused; }
  get playbackRate(): number { return this.rate; }
  set playbackRate(r: number) {
    this.rate = clampRate(r);
    if (!this.isPaused) this.post(this.playCommand());
  }

  play(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.isPaused) {
      this.isPaused = false;
      this.post(this.playCommand());
      this.emit('play');
    }
    return Promise.resolve();
  }
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.post({ type: 'pause' });
    this.emit('pause');
  }
  addEventListener(type: string, listener: EventListener): void { this.events.addEventListener(type, listener); }
  removeEventListener(type: string, listener: EventListener): void { this.events.removeEventListener(type, listener); }

  /** A new frame `id` is mounted (`send` posts to it): it takes over when it reports `ready`. */
  expect(id: string, send: (cmd: PreviewIncoming) => void): void { this.incoming = { id, send }; }
  /** Frame `id` is gone. */
  release(id: string): void {
    if (this.active?.id === id) this.active = null;
    if (this.incoming?.id === id) this.incoming = null;
  }
  /** Whether frame `id` is the one played (or, before any is, the one loading): its messages count. */
  counts(id: string): boolean { return this.active ? this.active.id === id : this.incoming?.id === id; }
  /** Every frame is gone (the player unmounts). */
  detach(): void { this.active = null; this.incoming = null; }

  /** A validated runtime message of frame `id`. Returns true when that frame has just taken over (`ready`). */
  receive(msg: PreviewOutgoing, id: string): boolean {
    if (msg.type === 'ready') {
      if (this.incoming?.id !== id) return false;
      const previous = this.active;
      this.active = this.incoming;
      this.incoming = null;
      // The old frame is removed by the player; it must not keep playing (or sounding) meanwhile.
      if (previous && previous.id !== id) previous.send({ type: 'pause' });
      this.dur = msg.duration;
      this.error = null;
      if (this.isMuted) this.post({ type: 'mute', muted: true });
      if (this.time > 0) this.post({ type: 'seek', t: Math.min(this.time, msg.duration) });
      if (!this.isPaused) this.post(this.playCommand());
      this.emit('loadedmetadata');
      this.emit('durationchange');
      return true;
    }
    if (msg.type === 'error') {
      // A page that cannot run at all, before any frame of this player ran.
      if (this.active === null && this.incoming?.id === id && FATAL.has(msg.error.code)) {
        this.error = msg.error;
        this.isPaused = true;
        this.emit('error');
      }
      return false;
    }
    if (msg.type !== 'time' || this.active?.id !== id) return false;
    if (msg.playing) this.awaitingPlay = false;
    // While paused, a late "playing" (sent before the pause) is ignored: it must never restart the transport.
    if (msg.playing && this.isPaused) return false;
    // While playing, a "not playing" from before the runtime played again (the end of a restoring seek) only moves the time.
    const ended = !msg.playing && !this.isPaused && !this.awaitingPlay && Number.isFinite(this.dur) && msg.t >= this.dur - END_EPS;
    this.time = msg.t;
    this.emit('timeupdate');
    if (ended) {
      this.isPaused = true;
      this.emit('pause');
      this.emit('ended');
    }
    return false;
  }

  private playCommand(): PreviewIncoming {
    return { type: 'play', loop: this.loop, rate: this.rate };
  }
  private post(cmd: PreviewIncoming): void {
    // Only the protocol's commands ever leave (a malformed one is a bug here: dropped).
    if (!this.active || !parseIncoming(cmd)) return;
    if (cmd.type === 'play') this.awaitingPlay = true;
    this.active.send(cmd);
  }
  private emit(type: string): void {
    this.events.dispatchEvent(new Event(type));
  }
}

export interface CompositionPlayerProps {
  session: PreviewSessionInfo;
  /** The frame's accessible name, e.g. "Reel v2". */
  title: string;
  /** The media handle: the same object for the player's whole life (across new sessions); null when it unmounts. */
  onMedia?(media: CompositionMedia | null): void;
  /** No `ready` within READY_TIMEOUT_MS (e.g. the desktop still refuses a composition server that moved). */
  onStall?(): void;
  /** The session whose frame is shown (ready), null when none: `usePreviewSession().showing` (A5). */
  onShowing?(token: string | null): void;
  /** Plays (looping) as soon as it is ready: the canvas boards' preview. */
  autoPlay?: boolean;
  /** No sound (Compare's second player, as its <video> was). */
  muted?: boolean;
  className?: string;
}

/** The session's URL, when it is an http(s) URL on the session's own origin; else null (nothing is loaded). */
function frameUrl(s: PreviewSessionInfo): string | null {
  try {
    const u = new URL(s.url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === s.origin ? u.href : null;
  } catch {
    return null;
  }
}

export function CompositionPlayer({ session, title, onMedia, onStall, onShowing, autoPlay, muted = false, className }: CompositionPlayerProps) {
  const t = useT();
  const r = t.web.render;
  const [media] = useState(() => new CompositionMedia());
  const [errors, setErrors] = useState<RuntimeError[]>([]);
  // The frame shown (ready) while a newer session's frame loads underneath it (A5): swapped when the new one is ready.
  const [shown, setShown] = useState<PreviewSessionInfo | null>(null);
  const url = frameUrl(session);
  const callbacks = useRef({ onMedia, onStall, onShowing });
  callbacks.current = { onMedia, onStall, onShowing };

  useEffect(() => {
    callbacks.current.onMedia?.(media);
    return () => { media.pause(); media.detach(); callbacks.current.onMedia?.(null); callbacks.current.onShowing?.(null); };
  }, [media]);
  useEffect(() => { media.muted = muted; }, [muted, media]);
  useEffect(() => {
    if (autoPlay) { media.loop = true; void media.play().catch(() => {}); }
  }, [autoPlay, media]);

  if (!url) return <div className={cx('ms-cplayer', className)}><p className="ms-cplayer-note" role="alert">{r.failed({ detail: session.url })}</p></div>;
  const shownUrl = shown ? frameUrl(shown) : null;
  // The latest session's frame, and below it (until that one is ready) the one still shown.
  const frames: Array<{ s: PreviewSessionInfo; u: string; next: boolean }> = [];
  if (shown && shownUrl && shownUrl !== url) frames.push({ s: shown, u: shownUrl, next: false });
  frames.push({ s: session, u: url, next: frames.length > 0 });
  const text = (e: RuntimeError) => {
    const base = r.runtimeError[e.code] ?? e.code;
    return e.clipId ? r.errorClip({ text: base, clip: e.clipId }) : base;
  };
  return (
    <div className={cx('ms-cplayer', className)}>
      {frames.map((f) => (
        <RuntimeFrame key={f.u} url={f.u} session={f.s} title={title} media={media} next={f.next}
          onReady={(errs) => { setShown(f.s); setErrors(errs.slice(0, MAX_ERRORS)); callbacks.current.onShowing?.(f.s.token); }}
          onError={(e) => setErrors((list) => (list.length >= MAX_ERRORS ? list : [...list, e]))}
          onStall={() => callbacks.current.onStall?.()} />
      ))}
      {errors.length ? (
        <ul className="ms-cplayer-errors" role="status" aria-label={r.runtimeIssues}>
          {[...new Set(errors.map(text))].map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One runtime frame (one session URL, React `key`): listens to it alone, posts to it alone, reports it stalled without
 * `ready`. `next`: a newer session's frame loading below the one shown (never hidden: a hidden cross-origin frame may get
 * no animation frames, and the runtime's ready needs them).
 */
function RuntimeFrame({ url, session, title, media, next, onReady, onError, onStall }: {
  url: string; session: PreviewSessionInfo; title: string; media: CompositionMedia; next: boolean;
  onReady(errors: RuntimeError[]): void; onError(e: RuntimeError): void; onStall(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const cb = useRef({ onReady, onError, onStall });
  cb.current = { onReady, onError, onStall };
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let ready = false;
    media.expect(url, (cmd) => { el.contentWindow?.postMessage(cmd, '*'); });
    const onMessage = (ev: MessageEvent) => {
      if (!el.contentWindow || ev.source !== el.contentWindow) return;
      if (ev.origin !== 'null' && ev.origin !== session.origin) return;
      const msg = parseOutgoing(ev.data);
      if (!msg) return;
      if (msg.type === 'error' && media.counts(url)) cb.current.onError(msg.error);
      if (media.receive(msg, url) && msg.type === 'ready') { ready = true; cb.current.onReady(msg.errors); }
    };
    window.addEventListener('message', onMessage);
    const stall = window.setTimeout(() => { if (!ready) cb.current.onStall(); }, READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(stall);
      media.release(url);
    };
  }, [url, session.origin, media]);
  return <iframe ref={frame} className={cx('ms-cplayer-frame', next && 'ms-next')} src={url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="autoplay"
    {...(next ? { 'aria-hidden': true, tabIndex: -1 } : {})} />;
}
