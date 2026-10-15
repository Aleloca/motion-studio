// The scene rows of a composition and their thumbnails (UX feedback 1, Task 2): the format view's Scenes column and the
// editor's are built at once from the composition JSON (name, start, duration, one row per scene in time order); the
// storyboard's thumbnails only fill the rows in when they arrive, so the list never waits for the core's renderer. A row
// shows a pulsing skeleton while the storyboard is on its way and a quiet placeholder when there is none.
import type { Composition, Scene, StoryboardView } from '@motion-studio/shared';
import { Icon, cx } from '../ui/index.ts';
import type { StoryboardState } from './compositionPreview.ts';
import '../screens/format.css';

/** One row of the Scenes column: a scene, or the whole video (`id` null) when the composition has no scenes. */
export interface SceneRow { id: string | null; name: string; start: number; duration: number }

/** The rows of a composition: its scenes in time order (unnamed ones numbered), else one "whole video" row. */
export function sceneRows(c: Pick<Composition, 'scenes' | 'duration'>, label: { scene(p: { n: number }): string; wholeVideo: string }): SceneRow[] {
  const scenes = [...c.scenes].sort((a, b) => a.start - b.start);
  if (scenes.length === 0) return [{ id: null, name: label.wholeVideo, start: 0, duration: c.duration }];
  return scenes.map((s: Scene, i) => ({ id: s.id, name: s.name ?? label.scene({ n: i + 1 }), start: s.start, duration: s.duration }));
}

const EPS = 1e-6;
/**
 * The index of the row the playhead is in: the last row (in time order) that starts at or before `t`, so a gap between
 * scenes keeps the scene before it and the time before the first scene marks the first row (fix round 1). 0 when empty.
 */
export function rowAt(rows: Array<Pick<SceneRow, 'start'>>, t: number): number {
  let at = 0;
  rows.forEach((r, i) => { if (r.start <= t + EPS) at = i; });
  return at;
}

type Frame = StoryboardView['frames'][number];
/** The storyboard frame of a row: its scene's (by id, or by name for older indexes), the poster for the whole video. */
export function frameFor(storyboard: StoryboardView | null, row: Pick<SceneRow, 'id' | 'name'>): Frame | null {
  const frames = storyboard?.frames ?? [];
  if (row.id === null) return frames.find((f) => f.kind === 'poster') ?? frames[0] ?? null;
  return frames.find((f) => f.kind === 'scene' && (f.scene === row.id || f.scene === row.name)) ?? null;
}

/**
 * A row's thumbnail box, sized by the composition's proportions (at most 64 px either way, so nothing moves when the
 * image arrives): the frame, a skeleton while the storyboard loads (or is busy), else a placeholder. Decorative: the row's
 * button carries the name.
 */
export function SceneThumb({ frame, state, width, height }: { frame: Frame | null; state: StoryboardState; width: number; height: number }) {
  const portrait = height > width;
  const style = { aspectRatio: `${width} / ${height}`, ...(portrait ? { height: 64 } : { width: 64 }) };
  const waiting = state === 'loading' || state === 'busy';
  return (
    <span className={cx('ms-fv-sb-thumb', !frame && waiting && 'ms-loading')} style={style} aria-hidden="true" data-thumb={frame ? 'frame' : waiting ? 'loading' : 'none'}>
      {frame ? <img src={frame.url} alt="" draggable={false} /> : waiting ? null : <Icon name="image" size={14} />}
    </span>
  );
}
