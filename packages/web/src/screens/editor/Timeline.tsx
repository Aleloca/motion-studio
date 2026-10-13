// The editor's timeline (Phase 10b, Task 7): the transport (play, timecode, frame step, zoom, magnet, ripple), the ruler with
// the playhead and the comment markers, the scenes lane with storyboard thumbnails, and one lane per track, the schema's last
// (topmost) track first. Clips are bars: a click selects, the edges trim and the body moves through `clipTiming` (snapping
// to scene bounds, clip edges and the playhead within 8 px; Alt, or the magnet off, disables it; the ripple toggle sends
// `ripple: true`). Everything it changes goes through `actions.apply`, so locked clips, clamps and refusals are `applyEdit`'s.
//
// Notes:
// - Gestures read the state they STARTED with and the total pointer movement (timelineMath.ts); one is applied per
//   animation frame with a `drag:<clip>` coalescing key and closed with `endRun()`: a drag is one undo step.
// - Scrubbing the ruler sends `seek` coalesced per animation frame. The runtime can drop a seek that arrives after several
//   follow-up seeks during a re-mount, so the LAST position is always sent when the scrub ends (and once more shortly after).
// - Range comments (Task 10): the spans are drawn by the caller through `overlay`; a Shift + drag on the ruler picks a range
//   (shown while dragging) and hands it to `onRange`; the "Comment on clip" button calls `onCommentClip`. Neither touches the draft.
import { compositionProblem, editProblemText, snapTargets, type Clip, type Track } from '@motion-studio/shared';
import {
  forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref,
} from 'react';
import { useStoryboard } from '../../components/compositionPreview.ts';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { Button, Icon, Select, Slider, cx } from '../../ui/index.ts';
import { useClock } from '../../ui/clock.ts';
import { SPEEDS, timecode, type Mark, type Speed } from '../Transport.tsx';
import { ClipBar, type DragMode } from './ClipBar.tsx';
import { useEditor } from './editorContext.ts';
import {
  DRAG_SLOP, clampZoom, clipBounds, frameRound, moveTiming, pxPerSec, pxToTime, rulerTicks, sliderToZoom, snapEdges, timeToPx, trimTiming, zoomAt, zoomToSlider,
  type Timing,
} from './timelineMath.ts';
import { TrackHeader } from './TrackHeader.tsx';

/** Width of the lane headers. */
export const HEADER_W = 168;
/** What the viewport counts as before it is measured (and in environments without layout). */
const FALLBACK_VIEWPORT = 720;
/** The final scrub position is sent once more after this long, in case the runtime dropped the first. */
export const SCRUB_RESEND_MS = 120;
const ZOOM_WHEEL = 0.0015;
/** A refusal stays on screen this long. */
const NOTICE_MS = 6000;

const CLIP_KIND_KEY = { text: 'clipText', shape: 'clipShape', image: 'clipImage', svg: 'clipSvg', video: 'clipVideo', html: 'clipHtml', audio: 'clipAudio' } as const;

export interface TimelineProps {
  loop: boolean; onLoop(on: boolean): void; speed: Speed; onSpeed(s: Speed): void;
  /** The conversation's pins on this format and version (shown as markers on the ruler). */
  marks?: Mark[];
  /** Drawn over the lanes, in the time area (Task 10: range comments as shaded spans). */
  overlay?: (o: { pps: number }) => ReactNode;
  /** A Shift + drag on the ruler ended on this range (seconds, start < end). Absent: Shift + drag scrubs like any drag. */
  onRange?(r: { start: number; end: number }): void;
  /** The "Comment on clip" button (the `C` key does the same); `canCommentClip` is false with no clip selected. */
  onCommentClip?(): void;
  canCommentClip?: boolean;
}

const Ticks = memo(function Ticks({ pps, fps, t0, t1, seconds }: { pps: number; fps: number; t0: number; t1: number; seconds: (n: number) => string }) {
  const { major, frames } = rulerTicks(pps, fps, t0, t1);
  return (
    <>
      {frames.map((t) => <i key={`f${t}`} className="ms-tl-tick ms-f" style={{ left: timeToPx(t, pps) }} />)}
      {major.map((t) => <span key={t} className="ms-tl-tick ms-m" style={{ left: timeToPx(t, pps) }}><b>{seconds(t)}</b></span>)}
    </>
  );
});

function Readout({ clock }: { clock: ReturnType<typeof useEditor>['controls']['clock'] }) {
  const { time } = useClock(clock);
  return <>{timecode(time)}</>;
}
/** The ruler: the slider assistive technology reads the settled time from (only this re-renders on a seek). */
function Ruler({ clock, duration, label, disabled, width, onPointerDown, onKeyDown, children }: {
  clock: ReturnType<typeof useEditor>['controls']['clock']; duration: number; label: string; disabled: boolean; width: number;
  onPointerDown(ev: ReactPointerEvent<HTMLElement>): void; onKeyDown(ev: ReactKeyboardEvent<HTMLElement>): void; children: ReactNode;
}, ref: Ref<HTMLDivElement>) {
  const f = useT().web.formatView;
  const { settled } = useClock(clock);
  return (
    <div ref={ref} className="ms-tl-ruler" role="slider" tabIndex={disabled ? -1 : 0} aria-label={label} aria-disabled={disabled || undefined}
      aria-valuemin={0} aria-valuemax={Math.round(duration * 1000) / 1000} aria-valuenow={Math.round(settled * 1000) / 1000}
      aria-valuetext={f.positionText({ time: timecode(settled), total: timecode(duration) })} style={{ width }} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
const RulerRef = forwardRef(Ruler);

function Playhead({ clock, pps }: { clock: ReturnType<typeof useEditor>['controls']['clock']; pps: number }) {
  const { time } = useClock(clock);
  return <span className="ms-tl-playhead" style={{ left: HEADER_W + timeToPx(time, pps) }} aria-hidden="true" />;
}

export function Timeline({ loop, onLoop, speed, onSpeed, marks = [], overlay, onRange, onCommentClip, canCommentClip = true }: TimelineProps) {
  const t = useT();
  const e = t.web.editor;
  const f = t.web.formatView;
  const e2 = t.web.conversation;
  const r = t.web.render;
  const locale = useLocale();
  const { slug, creative, primary, draft, actions, controls, selection, select, snap, setSnap } = useEditor();
  const comp = draft.composition;
  const fps = comp.fps;
  const scenes = useMemo(() => [...comp.scenes].sort((a, b) => a.start - b.start), [comp.scenes]);
  const lanes = useMemo(() => [...comp.tracks].reverse(), [comp.tracks]);

  const [zoom, setZoom] = useState(1);
  const [ripple, setRipple] = useState(false);
  const [notice, setNotice] = useState('');
  const [guide, setGuide] = useState<number | null>(null);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [scrollLeft, setScrollLeft] = useState(0);
  /** The range being picked with Shift + drag on the ruler. */
  const [picking, setPicking] = useState<{ a: number; b: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const pps = pxPerSec(viewport, comp.duration, zoom);
  const contentW = Math.ceil(comp.duration * pps);

  // The live values a gesture reads each frame (they can change under it: the magnet, the ripple toggle, the zoom).
  const live = useRef({ snap, ripple, pps, comp, fps, controls, actions, onRange });
  live.current = { snap, ripple, pps, comp, fps, controls, actions, onRange };

  // Viewport width: the scroller without the lane headers.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => { const w = el.clientWidth - HEADER_W; setViewport(w > 0 ? w : FALLBACK_VIEWPORT); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zoom anchored at a viewport pixel: the scroll that keeps the time under it is set once the content has its new width.
  const pendingScroll = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  const geometry = useRef({ viewport, duration: comp.duration });
  geometry.current = { viewport, duration: comp.duration };
  // Reads the zoom and scroll of the LAST call (not of the last render): several wheel events or slider moves in a frame chain.
  const setZoomAt = useCallback((next: number, anchorPx: number) => {
    const el = scroller.current;
    if (clampZoom(next) === zoomRef.current) return;
    const out = zoomAt({ zoom: zoomRef.current, next, scrollLeft: pendingScroll.current ?? el?.scrollLeft ?? 0, anchorPx, viewportPx: geometry.current.viewport, duration: geometry.current.duration });
    pendingScroll.current = out.scrollLeft;
    zoomRef.current = out.zoom;
    setZoom(out.zoom);
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current === null || !scroller.current) return;
    scroller.current.scrollLeft = pendingScroll.current;
    setScrollLeft(scroller.current.scrollLeft);
    pendingScroll.current = null;
  }, [zoom]);
  // ⌘ / Ctrl + wheel zooms at the pointer (a native listener: React's is passive and could not stop the page zoom).
  const wheelRef = useRef(setZoomAt);
  wheelRef.current = setZoomAt;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (!(ev.metaKey || ev.ctrlKey)) return;
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      wheelRef.current(clampZoom(zoomRef.current * Math.exp(-ev.deltaY * ZOOM_WHEEL)), ev.clientX - rect.left - HEADER_W);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Thumbnails of the scenes lane: the opened version's storyboard.
  const { storyboard } = useStoryboard({ slug, creative, n: draft.base.n, format: primary, hash: draft.base.hash, enabled: true });
  const thumbOf = (id: string, name?: string) => storyboard?.frames.find((fr) => fr.kind === 'scene' && (fr.scene === id || fr.scene === name)) ?? null;

  const kindName = (kind: Track['kind']) => ({ visual: e.kindVisual, video: e.kindVideo, text: e.kindText, audio: e.kindAudio })[kind];
  const trackName = (track: Track) => track.name ?? e.trackName({ kind: kindName(track.kind), n: comp.tracks.filter((x) => x.kind === track.kind).indexOf(track) + 1 });
  const sceneName = (s: { name?: string }, i: number) => s.name ?? r.scene({ n: i + 1 });

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);
  const refuse = useCallback((problem: Parameters<typeof editProblemText>[0]) => setNotice(editProblemText(problem, locale)), [locale]);
  const timing = useCallback((clipId: string, to: Timing, coalesce?: string): boolean => {
    const { actions: a, ripple: rip } = live.current;
    const res = a.apply({ kind: 'clipTiming', clipId, start: to.start, duration: to.duration, ripple: rip }, coalesce ? { coalesce } : undefined);
    if (res.ok) setNotice(''); else refuse(res.problem);
    return res.ok;
  }, [refuse]);
  const lockedProblem = (clip: Clip) => compositionProblem('editor.locked', { clip: clip.id });

  // ---- clip gestures
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const playheadNow = () => frameRound(live.current.controls.clock.get().time, live.current.fps);

  const beginDrag = (clip: Clip, track: Track, mode: DragMode, ev: ReactPointerEvent<HTMLElement>) => {
    if (ev.button !== 0) return;
    select(clip.id);
    if (clip.locked || track.locked) { refuse(lockedProblem(clip)); return; }
    if (live.current.comp.duration === 0) return;
    cleanup.current();
    const from: Timing = { start: clip.start, duration: clip.duration };
    const x0 = ev.clientX;
    let latest = { x: x0, alt: ev.altKey };
    let moved = false;
    let raf = 0;
    const flush = () => {
      raf = 0;
      const { pps: p, ripple: rip, snap: magnet, comp: c, fps: rate } = live.current;
      const bounds = clipBounds(c, clip, rip);
      // Fresh each frame: with ripple the scene boundaries and later clips move during the drag.
      const targets = [...new Set([...snapTargets(c, clip.id), playheadNow()])].sort((a, b) => a - b);
      const dt = (latest.x - x0) / p;
      const on = magnet && !latest.alt;
      let to: Timing;
      if (mode === 'move') {
        const s = snapEdges([from.start + dt, from.start + dt + from.duration], targets, p, on);
        to = moveTiming(from, from.start + dt + s.delta, bounds);
        setGuide(s.snappedTo);
      } else if (mode === 'start') {
        const s = snapEdges([from.start + dt], targets, p, on);
        to = trimTiming(from, 'start', from.start + dt + s.delta, bounds, rate);
        setGuide(s.snappedTo);
      } else {
        const end = from.start + from.duration;
        const s = snapEdges([end + dt], targets, p, on);
        to = trimTiming(from, 'end', end + dt + s.delta, bounds, rate);
        setGuide(s.snappedTo);
      }
      timing(clip.id, to, `drag:${clip.id}`);
    };
    const move = (m: PointerEvent) => {
      latest = { x: m.clientX, alt: m.altKey };
      if (!moved && Math.abs(m.clientX - x0) < DRAG_SLOP) return;
      moved = true;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const end = (m: PointerEvent) => {
      if (m.type === 'pointerup') latest = { x: m.clientX, alt: m.altKey };
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (moved) { flush(); live.current.actions.endRun(); }
      cleanup.current();
    };
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (raf) cancelAnimationFrame(raf);
      setGuide(null);
      cleanup.current = () => {};
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const clipKey = (clip: Clip, track: Track) => (ev: ReactKeyboardEvent<HTMLElement>) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.nativeEvent.isComposing) return;
    const arrow = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(clip.id); return; }
    if (!arrow && ev.key !== '[' && ev.key !== ']') return;
    // Handled here, so the editor's frame step (←/→ with no clip focused) does not also run.
    ev.preventDefault();
    select(clip.id);
    if (clip.locked || track.locked) { refuse(lockedProblem(clip)); return; }
    const c = live.current.comp;
    const bounds = clipBounds(c, clip, live.current.ripple);
    const from: Timing = { start: clip.start, duration: clip.duration };
    if (arrow) {
      const step = ev.shiftKey ? 1 : 1 / fps;
      const want = frameRound(clip.start + (ev.key === 'ArrowRight' ? step : -step), fps);
      timing(clip.id, moveTiming(from, want, bounds));
      return;
    }
    const now = playheadNow();
    const edge = ev.key === '[' ? 'start' : 'end';
    timing(clip.id, trimTiming(from, edge, now, bounds, fps));
  };

  // ---- ruler: scrub
  const scrub = useRef<{ last: number; sent: number | null; raf: number; resume: boolean; resend: number; seq: number }>({ last: 0, sent: null, raf: 0, resume: false, resend: 0, seq: 0 });
  const timeAt = (clientX: number): number => {
    const rect = area.current?.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0);
    return Math.min(live.current.comp.duration, Math.max(0, pxToTime(x, live.current.pps)));
  };
  /** Shift + drag on the ruler: a range comment. Nothing seeks; the range is picked frame by frame and handed over on release. */
  const beginRange = (ev: ReactPointerEvent<HTMLElement>) => {
    cleanup.current();
    const a = frameRound(timeAt(ev.clientX), live.current.fps);
    let b = a;
    setPicking({ a, b });
    const move = (m: PointerEvent) => { b = frameRound(timeAt(m.clientX), live.current.fps); setPicking({ a, b }); };
    const end = (m: PointerEvent) => {
      if (m.type === 'pointerup') b = frameRound(timeAt(m.clientX), live.current.fps);
      cleanup.current();
      if (m.type === 'pointerup' && Math.abs(b - a) >= 0.1) live.current.onRange?.({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setPicking(null);
      cleanup.current = () => {};
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const beginScrub = (ev: ReactPointerEvent<HTMLElement>) => {
    if (ev.button !== 0 || !controls.ready) return;
    if (ev.shiftKey && live.current.onRange) { beginRange(ev); return; }
    cleanup.current();
    const s = scrub.current;
    window.clearTimeout(s.resend);
    s.seq += 1;
    s.resume = controls.playing;
    if (controls.playing) controls.pause();
    s.last = timeAt(ev.clientX);
    s.sent = s.last;
    controls.seek(s.last);
    const send = () => { s.raf = 0; if (s.sent !== s.last) { s.sent = s.last; live.current.controls.seek(s.last); } };
    const move = (m: PointerEvent) => { s.last = timeAt(m.clientX); if (!s.raf) s.raf = requestAnimationFrame(send); };
    const end = (m: PointerEvent) => {
      if (m.type === 'pointerup') s.last = timeAt(m.clientX);
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      cleanup.current();
      // The last position always goes out, whatever was sent before, and once more a moment later.
      const final = s.last;
      s.sent = final;
      live.current.controls.seek(final);
      const mine = ++s.seq;
      s.resend = window.setTimeout(() => { if (s.seq === mine && !live.current.controls.playing) live.current.controls.seek(final); }, SCRUB_RESEND_MS);
      if (s.resume) live.current.controls.toggle();
    };
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      cleanup.current = () => {};
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  useEffect(() => () => window.clearTimeout(scrub.current.resend), []);
  const rulerKeys = (ev: ReactKeyboardEvent<HTMLElement>) => {
    if (!controls.ready) return;
    if (ev.key === 'Home') { ev.preventDefault(); controls.seek(0); }
    if (ev.key === 'End') { ev.preventDefault(); controls.seek(comp.duration); }
    if (ev.key === 'PageUp' || ev.key === 'PageDown') { ev.preventDefault(); controls.seek(controls.clock.get().time + (ev.key === 'PageUp' ? 1 : -1)); }
  };

  const flag = (track: Track) => (key: 'hidden' | 'locked' | 'muted', value: boolean) => {
    const res = actions.apply({ kind: 'trackFlags', trackId: track.id, [key]: value });
    if (res.ok) setNotice(''); else refuse(res.problem);
  };

  const t0 = pxToTime(scrollLeft, pps);
  const t1 = pxToTime(scrollLeft + viewport, pps);
  const seconds = useCallback((n: number) => t.web.canvas.seconds({ n: formatNumber(locale, n) }), [t, locale]);
  const disabled = !controls.ready;
  const timelineW = HEADER_W + contentW;

  return (
    <div className="ms-tl">
      <div className="ms-tl-bar">
        <button type="button" className="ms-fv-play" aria-label={controls.playing ? f.pause : f.play} aria-keyshortcuts="Space" disabled={disabled} onClick={controls.toggle}>
          <Icon name={controls.playing ? 'pause' : 'play'} size={13} fill={!controls.playing} strokeWidth={controls.playing ? 2 : 1.4} />
        </button>
        <span className="ms-fv-tc"><Readout clock={controls.clock} /><span className="ms-faint"> / {timecode(controls.duration)}</span></span>
        <Button size="sm" variant="outline" icon aria-label={f.prevFrame} title={f.prevFrame} aria-keyshortcuts="ArrowLeft" disabled={disabled} onClick={() => controls.step(-1)}><Icon name="back" size={13} /></Button>
        <Button size="sm" variant="outline" icon aria-label={f.nextFrame} title={f.nextFrame} aria-keyshortcuts="ArrowRight" disabled={disabled} onClick={() => controls.step(1)}><Icon name="forward" size={13} /></Button>
        <span className="ms-fv-sep" aria-hidden="true" />
        <Button size="sm" variant="outline" icon className={cx('ms-fv-loop', loop && 'ms-on')} aria-label={f.loop} title={f.loop} aria-pressed={loop} onClick={() => onLoop(!loop)}><Icon name="refresh" size={13} /></Button>
        <Select className="ms-fv-speed" variant="pill" label={f.speed} value={speed} onChange={onSpeed}
          options={SPEEDS.map((v) => ({ value: v, label: f.speedValue({ n: formatNumber(locale, Number(v)) }) }))} />
        <span className="ms-fv-sep" aria-hidden="true" />
        <Button size="sm" variant="outline" icon className={cx('ms-tl-toggle', snap && 'ms-on')} aria-label={e.snap} title={e.snap} aria-pressed={snap} onClick={() => setSnap(!snap)}><Icon name="magnet" size={13} /></Button>
        <Button size="sm" variant="outline" icon className={cx('ms-tl-toggle', ripple && 'ms-on')} aria-label={e.tlRipple} title={e.tlRipple} aria-pressed={ripple} onClick={() => setRipple(!ripple)}><Icon name="link" size={13} /></Button>
        {onCommentClip ? (
          <>
            <span className="ms-fv-sep" aria-hidden="true" />
            <Button size="sm" variant="outline" className="ms-tl-comment" aria-keyshortcuts="C" title={canCommentClip ? e2.rangeHint : e2.clipCommentNeeds}
              disabled={!canCommentClip} onClick={onCommentClip}><Icon name="comment" size={13} />{e2.clipComment}</Button>
          </>
        ) : null}
        <span className="ms-grow" />
        {notice ? <span className="ms-tl-notice" role="alert">{notice}</span> : null}
        <span className="ms-tl-zoom">
          <Icon name="search" size={13} />
          <Slider label={e.tlZoom} min={0} max={100} step={1} value={zoomToSlider(zoom)} valueText={e.tlZoomValue({ n: formatNumber(locale, zoom, { maximumFractionDigits: 1 }) })}
            onChange={(v) => setZoomAt(sliderToZoom(v), viewport / 2)} />
        </span>
      </div>

      <div ref={scroller} className="ms-tl-scroll" data-zoom={zoom} onScroll={(ev) => setScrollLeft(ev.currentTarget.scrollLeft)}>
        <div className="ms-tl-inner" style={{ width: timelineW }}>
          {/* ruler */}
          <div className="ms-tl-row ms-tl-rulerrow">
            <div className="ms-tl-corner" />
            <RulerRef ref={area} clock={controls.clock} duration={comp.duration} label={e.tlRuler} disabled={disabled} width={contentW} onPointerDown={beginScrub} onKeyDown={rulerKeys}>
              <Ticks pps={pps} fps={fps} t0={t0} t1={t1} seconds={seconds} />
              {picking ? <span className="ms-tl-picking" aria-hidden="true" style={{ left: timeToPx(Math.min(picking.a, picking.b), pps), width: timeToPx(Math.abs(picking.b - picking.a), pps) }} /> : null}
              {marks.filter((m) => m.pin.timeSec !== null).map(({ pin, number }) => (
                <button key={number} type="button" className="ms-tl-mark" style={{ left: timeToPx(pin.timeSec!, pps) }} title={pin.note} disabled={disabled}
                  aria-label={f.marker({ n: number, time: timecode(pin.timeSec!) })}
                  onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { if (controls.playing) controls.pause(); controls.seek(pin.timeSec!); }}>{number}</button>
              ))}
            </RulerRef>
          </div>

          {/* scenes */}
          <div className="ms-tl-row ms-tl-scenes" role="group" aria-label={e.scenes}>
            <div className="ms-tl-head"><Icon name="grid" size={13} /><span className="ms-tl-name">{e.scenes}</span></div>
            <div className="ms-tl-lane" style={{ width: contentW }}>
              {scenes.map((s, i) => {
                const fr = thumbOf(s.id, s.name);
                const name = sceneName(s, i);
                return (
                  <button key={s.id} type="button" className="ms-tl-scene" data-scene={s.id} disabled={disabled} title={name}
                    aria-label={e.tlSceneAt({ name, time: timecode(s.start) })} style={{ left: timeToPx(s.start, pps), width: timeToPx(s.duration, pps) }}
                    onClick={() => controls.seek(s.start)}>
                    {fr ? <img src={fr.url} alt="" draggable={false} /> : null}
                    <span>{name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* tracks, the topmost first */}
          <div role="group" aria-label={e.tlTracks}>
            {lanes.map((track) => (
              <div key={track.id} className="ms-tl-row ms-tl-track" data-track={track.id}>
                <TrackHeader track={track} name={trackName(track)} onFlag={flag(track)} />
                <div className={cx('ms-tl-lane', track.hidden && 'ms-dim', track.locked && 'ms-locked')} style={{ width: contentW }}>
                  {track.clips.map((clip) => {
                    const kind = e[CLIP_KIND_KEY[clip.type]];
                    const lockedClip = Boolean(clip.locked || track.locked);
                    const label = e.clipBar({ name: clip.name ?? clip.id, kind, start: timecode(clip.start), end: timecode(clip.start + clip.duration) })
                      + (lockedClip ? `, ${e.locked.toLowerCase()}` : '') + (clip.hidden || track.hidden ? `, ${e.clipBarHidden}` : '');
                    return (
                      <ClipBar key={clip.id} clip={clip} left={timeToPx(clip.start, pps)} width={Math.max(2, timeToPx(clip.duration, pps))}
                        selected={selection === clip.id} locked={lockedClip} hidden={Boolean(clip.hidden || track.hidden)} label={label}
                        onDrag={(mode, ev) => beginDrag(clip, track, mode, ev)} onKey={clipKey(clip, track)} />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {guide !== null ? <span className="ms-tl-guide" style={{ left: HEADER_W + timeToPx(guide, pps) }} aria-hidden="true" /> : null}
          {overlay ? <div className="ms-tl-overlay" style={{ left: HEADER_W }}>{overlay({ pps })}</div> : null}
          <Playhead clock={controls.clock} pps={pps} />
        </div>
      </div>
    </div>
  );
}
