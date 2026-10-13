// The selected clip's box on the stage (Phase 10b, Task 6): move (drag inside), resize (four corners, Shift keeps the aspect),
// rotate (the handle above the top edge, Shift snaps to 15°). It is drawn over the player's frame, outside the sandboxed
// iframe, from the box the runtime reports (`clipBounds`, CSS pixels of the frame, animations included) and the clip's own
// rotation and scale. Everything a drag writes is computed by stageMath.ts from the props the gesture started with: base
// props only, nothing accumulates, and animations are never baked in.
//
// A drag applies one `clipProps` edit per animation frame under the key `drag:<clipId>` (one undo step: the store joins
// edits with the same key within 500 ms; a heartbeat keeps a held pointer inside that window and the end of the gesture
// closes the run so the next drag is a step of its own). The playhead is paused for the gesture. While it lasts the box
// is drawn from the draft's own props (the runtime re-mounts per edit and its bounds trail behind); afterwards it holds
// that position until the runtime's bounds catch up, so the box never jumps back.
import type { Clip } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../../i18n.tsx';
import { Icon, cx } from '../../ui/index.ts';
import type { DraftActions } from './draftStore.ts';
import { useEditor } from './editorContext.ts';
import {
  guideLines, movePatch, resizePatch, resolveBox, rotatePatch, sizeFromBounds, snapMove, snapResize, wrapAngle,
  type BoxProps, type Corner, type GuideLines, type Point, type Rect, type SafeZone,
} from './stageMath.ts';

export type Guide = { axis: 'x' | 'y'; at: number };

/** After a drag the box stays where the draft put it for at most this long while the runtime's bounds catch up. */
export const HOLD_MS = 600;
/** A held pointer re-sends its last edit this often, so the store keeps joining it into the drag's undo step (window: 500 ms). */
const HEARTBEAT_MS = 250;
const r2 = (n: number) => Math.round(n * 1e2) / 1e2;
const CORNERS: readonly Corner[] = ['nw', 'ne', 'se', 'sw'];

type Kind = { k: 'move' } | { k: 'resize'; corner: Corner } | { k: 'rotate' };
type Patch = Partial<BoxProps>;

interface Gesture {
  kind: Kind;
  clipId: string;
  start: BoxProps;
  /** Pointer at the start, client pixels. */
  from: Point;
  scale: number;
  /** The box centre at the start, client pixels (rotation turns about it). */
  centre: Point;
  /** Stage pixels: where the drawn centre is minus where the base props put it (an animation's offset). Constant for the drag. */
  off: Point;
  lines: GuideLines;
  pending: { x: number; y: number; shift: boolean } | null;
  last: Patch | null;
  lastAt: number;
  raf: number;
  heartbeat: number;
}

const frame = (f: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : window.setTimeout(f, 16));
const unframe = (id: number) => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); else window.clearTimeout(id); };

/** One step of a gesture: the edit for the pointer at `p`, applied to the draft (nothing for a click that did not move). */
function runGesture(g: Gesture, p: { x: number; y: number; shift: boolean }, L: { snap: boolean; actions: DraftActions; onGuides(g: Guide[]): void }): void {
  const dx = p.x - g.from.x, dy = p.y - g.from.y;
  let patch: Patch;
  let guides: Guide[] = [];
  if (g.kind.k === 'move') {
    const s = L.snap ? snapMove(g.start, dx, dy, g.scale, g.lines) : { dx, dy, guides: [] };
    patch = movePatch(g.start, s.dx, s.dy, g.scale);
    guides = s.guides;
  } else if (g.kind.k === 'resize') {
    const s = L.snap ? snapResize(g.start, g.kind.corner, dx, dy, g.scale, g.lines) : { dx, dy, guides: [] };
    patch = resizePatch(g.start, g.kind.corner, s.dx, s.dy, g.scale, { keepAspect: p.shift });
    guides = s.guides;
  } else {
    patch = rotatePatch(g.start, g.centre, g.from, { x: p.x, y: p.y }, { snap: p.shift });
  }
  L.onGuides(guides);
  // Compare with the start as it would be written (a rotation of 270 is stored as -90), and a rotate that did not move is a click.
  const was: BoxProps = { ...g.start, rotation: r2(wrapAngle(g.start.rotation)) };
  const unmoved = g.kind.k === 'rotate' && dx === 0 && dy === 0;
  const changed = !unmoved && (Object.keys(patch) as Array<keyof BoxProps>).some((k) => patch[k] !== was[k]);
  if (!changed && g.last === null) return; // a click is not an edit
  g.last = patch;
  g.lastAt = Date.now();
  L.actions.apply({ kind: 'clipProps', clipId: g.clipId, props: patch }, { coalesce: `drag:${g.clipId}` });
}

export interface HandlesProps {
  clip: Clip;
  locked: boolean;
  /** Where the runtime draws the clip (frame CSS pixels), null when it is not visible now. */
  bounds: Rect | null;
  /** Frame pixels per composition pixel (`clipBounds.scale`). */
  scale: number;
  /** The overlay's client rectangle (to turn pointer positions into stage ones). */
  origin(): DOMRect | null;
  onGuides(guides: Guide[]): void;
}

export function Handles({ clip, locked, bounds, scale, origin, onGuides }: HandlesProps) {
  const t = useT();
  const e = t.web.editor;
  const { draft, actions, controls, snap } = useEditor();
  const comp = draft.composition;
  const props = ((clip as { props?: Partial<BoxProps> }).props ?? {}) as Partial<BoxProps>;

  // The box of the draft's props; a box without a size (a text) takes it from what the runtime draws.
  const fallback = useCallback((b: Rect | null): { width: number; height: number } => {
    if (clip.type !== 'text') return { width: comp.width, height: comp.height };
    const rot = props.rotation ?? 0;
    const s = props.scale ?? 1;
    const sized = b && scale > 0 && s > 0 ? sizeFromBounds(b, rot) ?? { width: b.width, height: b.height } : null;
    return sized ? { width: sized.width / (scale * s), height: sized.height / (scale * s) } : { width: 0, height: 0 };
  }, [clip.type, comp.width, comp.height, props.rotation, props.scale, scale]);
  const live: BoxProps = resolveBox(props, fallback(bounds));

  // The drawn centre (frame pixels): the runtime's, or - during a drag and just after - the draft's own plus the offset.
  const [hold, setHold] = useState<Point | null>(null);
  const holdTimer = useRef(0);
  const drag = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const centreOfBounds = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : null;
  const fromDraft = (off: Point): Point => ({ x: (live.x + live.width / 2) * scale + off.x, y: (live.y + live.height / 2) * scale + off.y });
  const centre = hold ? fromDraft(hold) : centreOfBounds;
  // The runtime caught up with the draft: the drawn centre is where the held one is.
  useEffect(() => {
    if (!hold || dragging || !centreOfBounds) return;
    const c = fromDraft(hold);
    if (Math.abs(c.x - centreOfBounds.x) < 1.5 && Math.abs(c.y - centreOfBounds.y) < 1.5) { window.clearTimeout(holdTimer.current); setHold(null); }
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { window.clearTimeout(holdTimer.current); }, []);

  // The latest values the gesture reads when it runs (it outlives the render that started it).
  const latest = useRef({ live, scale, snap, comp, safe: (draft.preset as { safeZone?: SafeZone }).safeZone, actions, controls, onGuides });
  latest.current = { live, scale, snap, comp, safe: (draft.preset as { safeZone?: SafeZone }).safeZone, actions, controls, onGuides };
  const clipId = clip.id;

  // The gesture's listeners live on the window and outlive renders: one stable pair, reading `latest` and the `drag` ref.
  const handlers = useRef<{ move(ev: PointerEvent): void; end(ev: PointerEvent): void; stop(): void } | null>(null);
  if (!handlers.current) {
    const stop = () => {
      const g = drag.current;
      if (!g) return null;
      drag.current = null;
      window.removeEventListener('pointermove', h.move);
      window.removeEventListener('pointerup', h.end);
      window.removeEventListener('pointercancel', h.end);
      unframe(g.raf);
      window.clearInterval(g.heartbeat);
      return g;
    };
    const h = {
      move(ev: PointerEvent) {
        const g = drag.current;
        if (!g) return;
        g.pending = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey };
        if (g.raf) return;
        g.raf = frame(() => { g.raf = 0; const p = g.pending; if (p && drag.current === g) runGesture(g, p, latest.current); });
      },
      end(ev: PointerEvent) {
        const g = stop();
        if (!g) return;
        // The last position counts, even when the frame for it has not run yet.
        if (ev.type === 'pointerup') runGesture(g, { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey }, latest.current);
        else if (g.pending) runGesture(g, g.pending, latest.current);
        latest.current.actions.endRun();
        latest.current.onGuides([]);
        setDragging(false);
        if (g.last) {
          setHold(g.off);
          window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => setHold(null), HOLD_MS);
        }
      },
      // The editor goes away in the middle of a drag: nothing outlives it.
      stop() { if (stop()) latest.current.actions.endRun(); },
    };
    handlers.current = h;
  }
  useEffect(() => () => { handlers.current?.stop(); }, []);

  const begin = (kind: Kind) => (ev: ReactPointerEvent<HTMLElement>) => {
    if (ev.button !== 0 || !centre) return;
    ev.stopPropagation();
    ev.preventDefault();
    if (locked) return;
    const L = latest.current;
    const o = origin();
    if (!o || !(L.scale > 0)) return;
    L.controls.pause();
    try { ev.currentTarget.setPointerCapture?.(ev.pointerId); } catch { /* the window listeners still get the gesture */ }
    const start = L.live;
    const base: Point = { x: (start.x + start.width / 2) * L.scale, y: (start.y + start.height / 2) * L.scale };
    const g: Gesture = {
      kind, clipId, start, from: { x: ev.clientX, y: ev.clientY }, scale: L.scale,
      centre: { x: o.left + centre.x, y: o.top + centre.y }, off: { x: centre.x - base.x, y: centre.y - base.y },
      lines: guideLines(L.comp.width, L.comp.height, L.safe), pending: null, last: null, lastAt: 0, raf: 0, heartbeat: 0,
    };
    g.heartbeat = window.setInterval(() => {
      if (g.last && Date.now() - g.lastAt >= HEARTBEAT_MS) {
        g.lastAt = Date.now();
        L.actions.apply({ kind: 'clipProps', clipId: g.clipId, props: g.last }, { coalesce: `drag:${g.clipId}` });
      }
    }, HEARTBEAT_MS);
    window.clearTimeout(holdTimer.current);
    setHold(null);
    drag.current = g;
    setDragging(true);
    window.addEventListener('pointermove', handlers.current!.move);
    window.addEventListener('pointerup', handlers.current!.end);
    window.addEventListener('pointercancel', handlers.current!.end);
  };

  if (!centre || !(scale > 0)) return null;
  const w = live.width * live.scale * scale, h = live.height * live.scale * scale;
  // The rotate handle sits 24 px above the top edge; with no room above (the clip at the top of the frame) it goes below.
  const flip = centre.y - (h / 2 + 30) * Math.cos((live.rotation * Math.PI) / 180) < 4;
  const label = e.coords({ x: String(Math.round(live.x)), y: String(Math.round(live.y)), w: String(Math.round(live.width)), h: String(Math.round(live.height)) });
  const cornerLabel: Record<Corner, string> = { nw: e.resizeNw, ne: e.resizeNe, se: e.resizeSe, sw: e.resizeSw };
  return (
    <>
      <div
        className={cx('ms-stage-box', locked && 'ms-locked', dragging && 'ms-dragging', flip && 'ms-flip')} data-clip={clipId} role="group" aria-label={e.selectionBox({ clip: clip.name ?? clipId })}
        title={locked ? e.locked : undefined} aria-disabled={locked || undefined}
        style={{ width: w, height: h, transform: `translate(${centre.x - w / 2}px, ${centre.y - h / 2}px) rotate(${live.rotation}deg)` }}
        onPointerDown={begin({ k: 'move' })}
      >
        <span className="ms-stage-move" aria-label={e.moveHandle} />
        {CORNERS.map((c) => (
          <span key={c} className={cx('ms-stage-handle', `ms-h-${c}`)} data-handle={c} aria-hidden="true" aria-label={cornerLabel[c]}
            title={locked ? e.locked : undefined} onPointerDown={begin({ k: 'resize', corner: c })} />
        ))}
        <span className="ms-stage-stem" aria-hidden="true" />
        <span className="ms-stage-handle ms-h-rot" data-handle="rotate" aria-hidden="true" aria-label={e.rotateHandle}
          title={locked ? e.locked : undefined} onPointerDown={begin({ k: 'rotate' })}><Icon name="rotate" size={11} /></span>
      </div>
      <div className={cx('ms-stage-label', locked && 'ms-locked')} role="status" style={{ left: centre.x, top: centre.y + Math.max(w, h) / 2 + 14 }}>
        {locked ? <><Icon name="lock" size={11} />{e.locked}</> : label}
      </div>
    </>
  );
}
