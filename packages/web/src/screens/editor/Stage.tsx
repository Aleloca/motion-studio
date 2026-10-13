// The editor's stage overlay (Phase 10b, Task 6): a transparent layer over the player's frame that holds the selected clip's
// handles and the snap guides. Selection reaches the runtime (`select`) and its drawn box comes back (`clipBounds`); clicking
// the empty stage deselects. Hit testing clicks inside the sandboxed frame is out of scope (decisions log): a clip is picked
// in the timeline, the layers panel or the scenes column.
import type { Clip, Track } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../../ui/index.ts';
import { useEditor } from './editorContext.ts';
import { Handles, type Guide } from './Handles.tsx';

/** The clip with this id and whether it (or its track) is locked. */
export function findClip(tracks: Track[], id: string | null): { clip: Clip; locked: boolean } | null {
  if (id === null) return null;
  for (const t of tracks) for (const c of t.clips) if (c.id === id) return { clip: c, locked: Boolean(c.locked || t.locked) };
  return null;
}

export function Stage({ className }: { className?: string }) {
  const { player, selection, select, draft } = useEditor();
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

  return (
    <div ref={layer} className={cx('ms-stage-layer', className)} data-slot="stage-layer"
      onPointerDown={(ev) => { if (ev.target === ev.currentTarget && ev.button === 0) select(null); }}>
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
