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
// - The editor's draft (`setComposition`, Phase 10b) goes the same way: validated by `parseIncoming` (structure and size),
//   posted to this frame only, at most once per animation frame. The runtime accepts it only from its parent, in preview.
// - The subtitle editor's lines (`setSubtitles`, subtitles Task 22) go the same way: validated by `parseIncoming`, posted to
//   this frame only; the runtime draws them with the composition's own subtitles style.
// - The frame's `src` is never changed: a new session (a renewal, the composition server restarted on another port) mounts
//   a new frame (React `key`), whose origin the desktop filter checks afresh.
// - Web residual (documented, carry 5): in a plain browser the preview's network is not locked down like a render's
//   (no request interception, no dead proxy); the CSP (`connect-src 'none'`) and the session token, which exposes only
//   that composition's files, are what confine it. The desktop app adds its frame filter (apps/desktop preview-filter.ts).
import { parseIncoming, parseOutgoing, RATE_MAX, RATE_MIN, SEQ_MAX, type PreviewIncoming, type PreviewOutgoing, type RuntimeError, type RuntimeErrorCode } from '@motion-studio/composition-runtime/protocol';
import { parseDraft } from '@motion-studio/composition-runtime/draft';
import type { Composition, PreviewSessionInfo, StagedVideoMedia } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from '../ui/index.ts';
import type { SyncMedia } from '../ui/useSyncedMedia.ts';
import './player.css';

/** The subtitles the runtime draws in preview (`setSubtitles`): null draws none. */
export type PreviewSubtitles = Extract<PreviewIncoming, { type: 'setSubtitles' }>['subtitles'];

/** No `ready` from the runtime in this time: the frame is reported stalled (the caller mints a new session). */
export const READY_TIMEOUT_MS = 20_000;
/** Errors the runtime reports when the page cannot run at all (runtime-main `fail`). */
const FATAL: ReadonlySet<RuntimeErrorCode> = new Set(['compositionMissing', 'compositionInvalid', 'baseNotAllowed']);
/** Within half a frame of the end, a stop is the end. */
const END_EPS = 1 / 60;
/** Inline errors kept (the runtime may report many). */
const MAX_ERRORS = 20;

const clampRate = (r: number) => Math.min(RATE_MAX, Math.max(RATE_MIN, Number.isFinite(r) ? r : 1));
/** The next animation frame (a timer where there is none). */
const onNextFrame = (f: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => f()); else setTimeout(f, 16);
};

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
  /** The editor's draft (Phase 10b): the latest one, its `seq`, sent once per animation frame and again to a new frame. */
  private draft: { composition: Composition; seq: number } | null = null;
  /** Staged videos' session media, by source (sent to each new frame before the draft). */
  private readonly sessionMedia = new Map<string, { token: string; cmd: PreviewIncoming }>();
  private seq = 0;
  /** The subtitles last given (`setSubtitles`), sent again to a new frame; undefined: never given (the page's own are drawn). */
  private subtitles: PreviewSubtitles | undefined = undefined;
  /** The `seq` last sent to the active frame (none: -1). */
  private sentSeq = -1;
  private flushQueued = false;
  /** The runtime's answer to the latest draft it applied: its `seq` and load problems. */
  applied: { seq: number; errors: RuntimeError[] } | null = null;
  /** The clip the editor selected (sent to a new frame once ready), and where the runtime last drew it (event `clipbounds`). */
  private selectedId: string | null = null;
  /** `bounds`: the drawn box in CSS pixels of the frame (transforms and animations included), null when not visible; `scale`: frame pixels per composition pixel. */
  clipBounds: { clipId: string | null; bounds: { x: number; y: number; width: number; height: number } | null; scale: number } | null = null;

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
  /**
   * Shows `composition` (the editor's draft) in place of the session's, keeping the time. Coalesced: at most one message
   * per animation frame, the latest wins; a frame mounted later (a renewal) gets it once ready. Returns its `seq`, which
   * `applied` (event `compositionapplied`) names once the runtime shows it. A draft the protocol refuses is never sent: it is
   * answered at once, locally, with a `compositionInvalid` error.
   */
  setComposition(composition: Composition): number {
    this.seq = this.seq >= SEQ_MAX ? 1 : this.seq + 1;
    this.draft = { composition, seq: this.seq };
    if (!this.flushQueued) {
      this.flushQueued = true;
      onNextFrame(() => { this.flushQueued = false; this.flushDraft(); });
    }
    return this.seq;
  }
  /**
   * Subtitles Task 22: the lines the runtime draws in place of those inlined in the page (null: none), at once at the current
   * time, and again on each new frame (before the draft). A block the protocol refuses is not sent.
   */
  setSubtitles(subtitles: PreviewSubtitles): void {
    this.subtitles = subtitles;
    this.post({ type: 'setSubtitles', subtitles });
  }
  /** Forgets the lines given (the caller stopped sending them): a new frame then draws its page's own. Sends nothing. */
  clearSubtitles(): void { this.subtitles = undefined; }
  /** Selects a clip in the runtime (its drawn box comes back as `clipBounds`, event `clipbounds`); null clears. */
  select(clipId: string | null): void {
    this.selectedId = clipId;
    if (clipId === null && this.clipBounds?.clipId) { this.clipBounds = { ...this.clipBounds, clipId: null, bounds: null }; this.emit('clipbounds'); }
    this.post({ type: 'select', clipId });
  }
  /** Forgets the draft (the editor closed): a new frame shows the session's own composition. Sends nothing. */
  clearDraft(): void { this.draft = null; this.sessionMedia.clear(); }
  /**
   * A staged video's normalised file in the session shown (`StagedAsset.media`, Phase 10b): a draft clip naming `src` plays
   * it. Sent now, and again to a new frame of the same session (before the draft), so call it before the draft that uses
   * it. Never sent to another session (its media indices are its own). False when no frame is shown or the protocol
   * refuses it (it is then not kept).
   */
  addSessionMedia(src: string, media: StagedVideoMedia): boolean {
    const cmd: PreviewIncoming = { type: 'sessionMedia', src, ...media };
    if (!this.active || !parseIncoming(cmd)) return false;
    this.sessionMedia.set(src, { token: sessionTokenOf(this.active.id), cmd });
    this.post(cmd);
    return true;
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
      this.sentSeq = -1;
      // A new session has media of its own: what was added to another one is dropped, never sent.
      const token = sessionTokenOf(id);
      for (const [src, m] of this.sessionMedia) if (m.token !== token) this.sessionMedia.delete(src); else this.post(m.cmd);
      if (this.selectedId !== null) this.post({ type: 'select', clipId: this.selectedId });
      if (this.subtitles !== undefined) this.post({ type: 'setSubtitles', subtitles: this.subtitles });
      this.flushDraft(); // after the restoring seek: the draft keeps that time
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
    if (msg.type === 'compositionApplied') {
      if (this.active?.id !== id) return false;
      this.applied = { seq: msg.seq, errors: msg.errors };
      // A draft that could not be mounted leaves the previous one shown: its duration does not count (M1).
      const shown = !msg.errors.some((e) => e.code === 'compositionInvalid');
      if (shown && this.draft && msg.seq === this.draft.seq) {
        const d = this.draft.composition.duration > 0 ? this.draft.composition.duration : 0;
        if (d !== this.dur) { this.dur = d; this.emit('durationchange'); }
      }
      this.emit('compositionapplied');
      return false;
    }
    if (msg.type === 'clipBounds') {
      if (this.active?.id !== id) return false;
      this.clipBounds = { clipId: msg.clipId, bounds: msg.bounds, scale: msg.scale };
      this.emit('clipbounds');
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

  private flushDraft(): void {
    if (!this.draft || !this.active || this.draft.seq === this.sentSeq) return;
    const { composition, seq } = this.draft;
    this.sentSeq = seq;
    if (!this.post({ type: 'setComposition', composition, keepTime: true, seq })) {
      // Refused here (structure or size): the runtime would refuse it too. The caller hears it as its answer (M4).
      this.applied = { seq, errors: [{ code: 'compositionInvalid', message: 'the draft was refused by the preview protocol (structure or size)' }] };
      this.emit('compositionapplied');
    }
  }
  private playCommand(): PreviewIncoming {
    return { type: 'play', loop: this.loop, rate: this.rate };
  }
  /** Whether `cmd` was sent: only the protocol's commands ever leave (a malformed one is a bug here, or a refused draft). */
  private post(cmd: PreviewIncoming): boolean {
    if (!this.active || !parseIncoming(cmd, parseDraft)) return false;
    if (cmd.type === 'play') this.awaitingPlay = true;
    this.active.send(cmd);
    return true;
  }
  private emit(type: string): void {
    this.events.dispatchEvent(new Event(type));
  }
}

/** The session token of a frame id (the runtime page URL, `<origin>/<token>/runtime/index.html?…`); the id itself otherwise. */
function sessionTokenOf(id: string): string {
  try { return new URL(id).pathname.split('/')[1] || id; } catch { return id; }
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
  /**
   * Subtitles Task 22: the lines the composition's subtitles track draws (the subtitle editor's, sent as `setSubtitles` on each
   * change; the caller debounces them). Absent: the page's own, as staged by the core.
   */
  subtitles?: PreviewSubtitles;
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

export function CompositionPlayer({ session, title, onMedia, onStall, onShowing, autoPlay, muted = false, subtitles, className }: CompositionPlayerProps) {
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
  useEffect(() => { if (subtitles !== undefined) media.setSubtitles(subtitles); else media.clearSubtitles(); }, [subtitles, media]);
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
          onApplied={(errs) => setErrors(errs.slice(0, MAX_ERRORS))}
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
function RuntimeFrame({ url, session, title, media, next, onReady, onError, onApplied, onStall }: {
  url: string; session: PreviewSessionInfo; title: string; media: CompositionMedia; next: boolean;
  onReady(errors: RuntimeError[]): void; onError(e: RuntimeError): void; onApplied(errors: RuntimeError[]): void; onStall(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const cb = useRef({ onReady, onError, onApplied, onStall });
  cb.current = { onReady, onError, onApplied, onStall };
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
      // The draft's own problems replace the list (a fixed draft clears them).
      if (msg.type === 'compositionApplied' && media.counts(url)) cb.current.onApplied(msg.errors);
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
