// The subtitle editor's timeline (Task 13, spec §6.3): the audio mix's waveform on a canvas, a block per line over it. A
// block's edges (6 px handles) and its body drag with the pointer: each move is a `times` op marked `drag`, so the model
// snaps and clamps it and the whole drag is one undo step (`endDrag` closes it). The edges are sliders for the keyboard
// (← → 100 ms, ⇧ 1 s). A click on empty space seeks; ⌘-wheel (Ctrl elsewhere) zooms 1×–20× around the pointer.
import type { SubtitleCue } from '@motion-studio/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../../i18n.tsx';
import { isMac } from '../../platform.ts';
import { cx } from '../../ui/index.ts';
import { msText } from './CueList.tsx';
import type { EditorOp } from './subtitlesModel.ts';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;
/** The arrow keys move an edge by this much; with ⇧ by BIG_STEP_MS. */
export const STEP_MS = 100;
export const BIG_STEP_MS = 1000;
/** A body press that moves less than this is a click (select and seek), not a drag. */
const CLICK_SLOP_PX = 3;

export interface CueTimelineProps {
  cues: SubtitleCue[];
  /** The timeline's length (the model's: the video's, or the last line's end when later). */
  durationMs: number;
  /** The waveform's peaks (0..1); null while they load. */
  peaks: readonly number[] | null;
  /** The span the peaks cover (default `durationMs`). */
  peaksMs?: number;
  /** The playhead, in ms. */
  time: number;
  selected: string | null;
  /** The model's `dragging`: once it held the dragged line, a drag it no longer holds (⌘Z mid-drag) moves nothing more. */
  dragging?: string | null;
  dispatch: Dispatch<EditorOp>;
  onSeek(ms: number): void;
}

type Grab = { kind: 'start' | 'end' | 'move'; id: string; x0: number; start0: number; end0: number; moved: boolean; width: number; held: boolean } | { kind: 'seek' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Draws the visible part of the waveform on `c` (sized to `viewW` CSS pixels at the device's ratio, in the canvas's CSS
 * `color`): one bar every 2 px, the largest peak under it, mirrored around the middle. Self-contained (the Chrome layout
 * test runs its source in the page).
 */
export function drawWave(c: HTMLCanvasElement, o: { peaks: readonly number[]; cover: number; span: number; trackW: number; scrollX: number; viewW: number }): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const h = c.clientHeight || 1;
  c.width = Math.round(o.viewW * dpr);
  c.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, o.viewW, h);
  if (o.peaks.length === 0 || o.trackW <= 0) return;
  ctx.fillStyle = getComputedStyle(c).color;
  ctx.globalAlpha = 0.8;
  for (let x = 0; x < o.viewW; x += 2) {
    const a = ((o.scrollX + x) / o.trackW) * o.span, b = ((o.scrollX + x + 2) / o.trackW) * o.span;
    if (a >= o.cover) break;
    const i0 = Math.floor((a / o.cover) * o.peaks.length), i1 = Math.max(i0 + 1, Math.ceil((b / o.cover) * o.peaks.length));
    let v = 0;
    for (let i = i0; i < Math.min(i1, o.peaks.length); i++) v = Math.max(v, o.peaks[i] ?? 0);
    const bar = Math.max(0.04, v) * (h - 8);
    ctx.fillRect(x, (h - bar) / 2, 1.2, bar);
  }
}

export function CueTimeline({ cues, durationMs, peaks, peaksMs, time, selected, dragging = null, dispatch, onSeek }: CueTimelineProps) {
  const t = useT();
  const s = t.subtitles;
  const view = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab | null>(null);
  const draggingNow = useRef(dragging);
  draggingNow.current = dragging;
  const [zoom, setZoom] = useState(1);
  const [viewW, setViewW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [theme, setTheme] = useState(0);
  const span = Math.max(1, durationMs);

  const msAt = (clientX: number): number | null => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    return Math.round(clamp(((clientX - r.left) / r.width) * span, 0, span));
  };

  // The viewport's width (the canvas covers only what shows) and its scroll.
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    const measure = () => { setViewW(el.clientWidth); setScrollX(el.scrollLeft); };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => { ro?.disconnect(); el.removeEventListener('scroll', measure); };
  }, []);
  // The theme's colours change with the app's theme or the system's: drawn again.
  useEffect(() => {
    const bump = () => setTheme((n) => n + 1);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(bump) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', bump);
    return () => { mo?.disconnect(); mq?.removeEventListener?.('change', bump); };
  }, []);

  // ⌘-wheel (Ctrl elsewhere, and a trackpad pinch) zooms around the pointer: a listener of its own, not passive.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const z0 = zoomRef.current;
      const z1 = clamp(z0 * Math.exp(-e.deltaY * 0.002), MIN_ZOOM, MAX_ZOOM);
      if (z1 === z0) return;
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const at = (el.scrollLeft + x) / (el.clientWidth * z0);
      setZoom(z1);
      // After the wider track is laid out: the point under the pointer stays under it.
      requestAnimationFrame(() => { el.scrollLeft = at * el.clientWidth * z1 - x; });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // The waveform: the visible part only, one bar per CSS pixel, mirrored around the middle (PlayerControls' look).
  const drawn = useRef(false);
  useEffect(() => {
    const c = canvas.current;
    const some = peaks !== null && peaks.length > 0;
    if (!c || viewW <= 0 || (!some && !drawn.current)) return;
    drawn.current = some;
    drawWave(c, { peaks: peaks ?? [], cover: Math.max(1, peaksMs ?? span), span, trackW: viewW * zoom, scrollX, viewW });
  }, [peaks, peaksMs, span, zoom, viewW, scrollX, theme]);

  // While zoomed and playing on, the view follows the playhead when it leaves it.
  useEffect(() => {
    const el = view.current;
    if (!el || zoom <= 1 || grab.current || viewW <= 0) return;
    const px = (time / span) * viewW * zoom;
    if (px < el.scrollLeft || px > el.scrollLeft + viewW) el.scrollLeft = Math.max(0, px - viewW * 0.1);
  }, [time, zoom, span, viewW]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const block = target.closest<HTMLElement>('.ms-subtl-cue');
    const cue = block ? cues.find((c) => c.id === block.dataset.cue) : undefined;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (!cue) {
      grab.current = { kind: 'seek' };
      const at = msAt(e.clientX);
      if (at !== null) onSeek(at);
      return;
    }
    const edge = target.closest<HTMLElement>('.ms-subtl-edge');
    const width = track.current?.getBoundingClientRect().width ?? 0;
    grab.current = { kind: edge ? (edge.classList.contains('ms-start') ? 'start' : 'end') : 'move', id: cue.id, x0: e.clientX, start0: cue.start, end0: cue.end, moved: false, width, held: false };
    if (cue.id !== selected) dispatch({ type: 'select', id: cue.id });
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    // No button held any more (a release the timeline never saw): the gesture is over, hovering moves nothing.
    if ((e.buttons & 1) === 0) { cancel(); return; }
    if (g.kind === 'seek') { const at = msAt(e.clientX); if (at !== null) onSeek(at); return; }
    // The model let go of this drag (undo mid-drag): the rest of the gesture moves nothing.
    if (draggingNow.current === g.id) g.held = true;
    else if (g.held) { grab.current = null; return; }
    const dx = e.clientX - g.x0;
    if (!g.moved && Math.abs(dx) < CLICK_SLOP_PX) return;
    if (!g.width) return;
    g.moved = true;
    const d = Math.round((dx / g.width) * span);
    if (g.kind === 'start') dispatch({ type: 'times', id: g.id, start: g.start0 + d, drag: true });
    else if (g.kind === 'end') dispatch({ type: 'times', id: g.id, end: g.end0 + d, drag: true });
    else dispatch({ type: 'times', id: g.id, start: g.start0 + d, end: g.end0 + d, drag: true });
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    grab.current = null;
    if (!g || g.kind === 'seek') return;
    if (g.moved) { dispatch({ type: 'endDrag' }); return; }
    // A click on a line: selected (on the press), and the playhead goes where it was clicked.
    const at = msAt(e.clientX);
    if (at !== null) onSeek(at);
  };
  const cancel = () => {
    const g = grab.current;
    grab.current = null;
    if (g && g.kind !== 'seek' && g.moved) dispatch({ type: 'endDrag' });
  };

  // The blocks change with the lines, not with the playhead: kept between the frames of playback.
  const tabbable = selected !== null && cues.some((c) => c.id === selected) ? selected : cues[0]?.id ?? null;
  const blocks = useMemo(() => cues.map((c, i) => {
    const key = (edge: 'start' | 'end') => (e: KeyboardEvent<HTMLSpanElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? BIG_STEP_MS : STEP_MS);
      dispatch(edge === 'start' ? { type: 'times', id: c.id, start: Math.max(0, c.start + d) } : { type: 'times', id: c.id, end: c.end + d });
    };
    const edge = (which: 'start' | 'end') => {
      const v = which === 'start' ? c.start : c.end;
      return (
        <span className={cx('ms-subtl-edge', which === 'start' ? 'ms-start' : 'ms-end')} role="slider" tabIndex={c.id === tabbable ? 0 : -1}
          aria-label={which === 'start' ? s.start({ n: i + 1 }) : s.end({ n: i + 1 })} aria-valuemin={0} aria-valuemax={span} aria-valuenow={v}
          aria-valuetext={msText(v)} onKeyDown={key(which)} />
      );
    };
    return (
      <div key={c.id} className={cx('ms-subtl-cue', c.id === selected && 'ms-on')} data-cue={c.id}
        style={{ left: `${(c.start / span) * 100}%`, width: `${(Math.max(0, c.end - c.start) / span) * 100}%` }}>
        {edge('start')}
        <span className="ms-subtl-text" aria-hidden="true">{c.text.split('\n')[0]}</span>
        {edge('end')}
      </div>
    );
  }), [cues, selected, tabbable, span, dispatch, s]);

  return (
    <section className="ms-subs-timeline" aria-label={s.timeline}>
      <div className="ms-subtl-head">
        <span className="ms-subtl-hint">{s.timelineHint({ mod: isMac() ? '⌘' : 'Ctrl' })}</span>
        {peaks === null ? <span className="ms-subtl-loading" role="status">{s.waveformLoading}</span> : null}
        {zoom > 1 ? <span className="ms-subtl-zoom">{`${Math.round(zoom * 10) / 10}×`}</span> : null}
      </div>
      <div ref={view} className="ms-subtl-view">
        <div ref={track} className="ms-subtl-track" style={{ width: `${zoom * 100}%` }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
          <canvas ref={canvas} className="ms-subtl-wave" aria-hidden="true" style={{ left: scrollX, width: viewW || '100%' }} />
          {blocks}
          <span className="ms-subtl-playhead" aria-hidden="true" style={{ left: `${clamp(time / span, 0, 1) * 100}%` }} />
        </div>
      </div>
    </section>
  );
}
