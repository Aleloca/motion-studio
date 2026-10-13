// A clip as a bar on its lane (Phase 10b, Task 7): focusable, named by clip, kind and times. The body moves it, the edges trim
// it (pointer only, aria-hidden like the stage handles; the keyboard trims with [ and ] and moves with the arrows, handled by
// the timeline). Positioned by the timeline in pixels.
import type { Clip } from '@motion-studio/shared';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Icon, cx } from '../../ui/index.ts';

export type DragMode = 'move' | 'start' | 'end';

export function ClipBar({ clip, left, width, selected, locked, hidden, label, onDrag, onKey }: {
  clip: Clip; left: number; width: number; selected: boolean; locked: boolean; hidden: boolean; label: string;
  onDrag(mode: DragMode, ev: ReactPointerEvent<HTMLElement>): void;
  onKey(ev: ReactKeyboardEvent<HTMLElement>): void;
}) {
  const edge = (mode: 'start' | 'end') => (ev: ReactPointerEvent<HTMLElement>) => { ev.stopPropagation(); onDrag(mode, ev); };
  return (
    <div className={cx('ms-tl-clip', `ms-k-${clip.type}`, selected && 'ms-on', locked && 'ms-locked', hidden && 'ms-dim')} role="button" tabIndex={0}
      aria-pressed={selected} aria-label={label} aria-keyshortcuts="ArrowLeft ArrowRight [ ]" data-clip={clip.id} style={{ left, width }}
      onPointerDown={(ev) => onDrag('move', ev)} onKeyDown={onKey}>
      <span className="ms-tl-edge ms-e-start" data-edge="start" aria-hidden="true" onPointerDown={edge('start')} />
      {locked ? <Icon name="lock" size={11} /> : null}
      <span className="ms-tl-clip-name">{clip.name ?? clip.id}</span>
      <span className="ms-tl-edge ms-e-end" data-edge="end" aria-hidden="true" onPointerDown={edge('end')} />
    </div>
  );
}
