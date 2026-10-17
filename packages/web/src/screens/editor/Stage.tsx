// The editor's stage overlay (Phase 10b, Task 6): a transparent layer over the player's frame that holds the selected clip's
// handles and the snap guides. Selection reaches the runtime (`select`) and its drawn box comes back (`clipBounds`); clicking
// the empty stage deselects. Hit testing clicks inside the sandboxed frame is out of scope (decisions log): a clip is picked
// in the timeline, the layers panel or the scenes column. The selected svg clip's own elements are the exception (SVG inner
// editor): its checked SVG is drawn under the handles (SvgOverlay), and a click on the clip that did not move it picks the
// element under the pointer, as the inspector's list does.
import type { Clip, Track } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cx } from '../../ui/index.ts';
import { useEditor } from './editorContext.ts';
import { Handles, type Guide } from './Handles.tsx';
import { resolveBox } from './stageMath.ts';
import { SvgOverlay, type SvgOverlayHandle } from './SvgOverlay.tsx';

/** A press and release closer than this (client pixels) is a click, not a drag of the clip. */
const CLICK_SLOP = 4;

/** The clip with this id and whether it (or its track) is locked. */
export function findClip(tracks: Track[], id: string | null): { clip: Clip; locked: boolean } | null {
  if (id === null) return null;
  for (const t of tracks) for (const c of t.clips) if (c.id === id) return { clip: c, locked: Boolean(c.locked || t.locked) };
  return null;
}

export function Stage({ className }: { className?: string }) {
  const { player, selection, select, draft, controls, svgElement, selectSvgElement } = useEditor();
  const layer = useRef<HTMLDivElement>(null);
  const [reported, setReported] = useState(() => player?.clipBounds ?? null);
  const [guides, setGuides] = useState<Guide[]>([]);

  // The selection goes to the runtime; what it draws comes back.
  useEffect(() => { player?.select(selection); }, [player, selection]);
  useEffect(() => {
    if (!player) { setReported(null); return; }
    const on = () => setReported(player.clipBounds ? { ...player.clipBounds } : null);
    player.addEventListener('clipbounds', on);
    on();
    return () => player.removeEventListener('clipbounds', on);
  }, [player]);

  const found = findClip(draft.composition.tracks, selection);
  const mine = reported && reported.clipId === selection ? reported : null;
  const origin = useCallback(() => layer.current?.getBoundingClientRect() ?? null, []);
  const scale = mine?.scale ?? 0;

  // The selected svg clip's elements: drawn only from the text the core checked, never while playing.
  const svgClip = found && found.clip.type === 'svg' ? found.clip : null;
  const svgText = svgClip ? draft.svgTexts.get(svgClip.src) : undefined;
  const overlayBox = svgClip && svgText !== undefined && !controls.playing && mine?.bounds && scale > 0 ? (() => {
    const live = resolveBox(svgClip.props, { width: draft.composition.width, height: draft.composition.height });
    const b = mine.bounds!;
    return { width: live.width * live.scale * scale, height: live.height * live.scale * scale, cx: b.x + b.width / 2, cy: b.y + b.height / 2, rotation: live.rotation };
  })() : null;
  const overlay = useRef<SvgOverlayHandle>(null);
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => { setHover(null); }, [selection, svgText]);
  const onMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!overlayBox || ev.buttons !== 0) return;
    const at = overlay.current?.hit(ev.clientX, ev.clientY) ?? null;
    if (at !== hover) setHover(at);
  };
  const onClick = (ev: ReactMouseEvent<HTMLDivElement>) => {
    const p = pressed.current;
    pressed.current = null;
    if (!overlayBox || !p || Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > CLICK_SLOP) return;
    const at = overlay.current?.hit(ev.clientX, ev.clientY) ?? null;
    if (at !== null) selectSvgElement(at);
  };

  return (
    <div ref={layer} className={cx('ms-stage-layer', className)} data-slot="stage-layer"
      onPointerDown={(ev) => { if (ev.target === ev.currentTarget && ev.button === 0) select(null); }}
      onPointerDownCapture={(ev) => { pressed.current = ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null; }}
      onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={onClick}>
      {svgClip && overlayBox && svgText !== undefined ? (
        <SvgOverlay key={svgClip.id} clip={svgClip} text={svgText} box={overlayBox} picked={svgElement} hover={hover} handle={overlay} />
      ) : null}
      {found && found.clip.type !== 'audio' ? (
        <Handles key={found.clip.id} clip={found.clip} locked={found.locked} bounds={mine?.bounds ?? null} scale={scale} origin={origin} onGuides={setGuides} />
      ) : null}
      {guides.map((g) => (
        <span key={`${g.axis}${g.at}`} className={cx('ms-stage-guide', g.axis === 'x' ? 'ms-gx' : 'ms-gy')} aria-hidden="true"
          style={g.axis === 'x' ? { left: g.at * scale } : { top: g.at * scale }} />
      ))}
    </div>
  );
}
