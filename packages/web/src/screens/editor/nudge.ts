// Alt+arrow nudging of the selected clip (Phase 10b, Task 8): whole composition pixels, one undo step per burst (the store
// joins edits with the same coalesce key within 500 ms), refused on a locked clip or track.
import type { EditResult } from '@motion-studio/shared';
import type { Draft, DraftActions } from './draftStore.ts';
import { findClip } from './Stage.tsx';

export type Nudge = { ok: false; reason: 'none' } | { ok: false; reason: 'locked' } | { ok: false; reason: 'refused'; result: Extract<EditResult, { ok: false }> } | { ok: true };

/** Whether the selection is a clip with a box (everything but audio). */
export function nudgeable(draft: Draft, selection: string | null): boolean {
  const f = findClip(draft.composition.tracks, selection);
  return Boolean(f && f.clip.type !== 'audio');
}

export function nudgeClip(draft: Draft, actions: DraftActions, selection: string | null, dx: number, dy: number): Nudge {
  const f = findClip(draft.composition.tracks, selection);
  if (!f || f.clip.type === 'audio') return { ok: false, reason: 'none' };
  if (f.locked) return { ok: false, reason: 'locked' };
  const p = (f.clip as { props?: { x?: number; y?: number } }).props ?? {};
  const r = actions.apply({ kind: 'clipProps', clipId: f.clip.id, props: { x: (p.x ?? 0) + dx, y: (p.y ?? 0) + dy } }, { coalesce: `nudge:${f.clip.id}` });
  return r.ok ? { ok: true } : { ok: false, reason: 'refused', result: r };
}
