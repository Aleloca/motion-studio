// The editor's keyboard map (Phase 10b): ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y outside macOS) undo and redo, Space plays
// and pauses, ← → step one frame, Delete explains that clips cannot be removed here, Esc deselects, C comments on the selected clip, R on a time range,
// P on a spot of the frame. Never while the user is
// typing in a field, never from a modal or popover on top, never from a page that is leaving (usePageShortcut).
import { useRef, type RefObject } from 'react';
import { usePageShortcut } from '../../motion/index.ts';
import { isMac } from '../../platform.ts';
import { PLAYER_CONTROLS } from '../Transport.tsx';
import { activatesControl, bare, inOverlay, isTyping } from '../keys.ts';

export interface EditorKeyHandlers {
  undo(): void;
  redo(): void;
  toggle(): void;
  step(dir: 1 | -1): void;
  deselect(): void;
  /** Delete / Backspace on the stage: clips cannot be removed here. */
  remove(): void;
  /** `C`: comment on the selected clip (Task 10). Absent: the key is left alone. */
  commentClip?(): void;
  /** `R`: comment on a time range, typed in a dialog (the keyboard path of Shift + drag). */
  commentRange?(): void;
  /** `P`: comment on a spot of the frame (the next click on the picture places it). */
  commentSpot?(): void;
}

/** ⌘ on macOS, Ctrl elsewhere (the same rule as ⌘K in App). */
const mod = (e: KeyboardEvent): boolean => (isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

export function useEditorKeys(root: RefObject<Element | null>, enabled: boolean, h: EditorKeyHandlers): void {
  const handlers = useRef(h);
  handlers.current = h;
  const free = (e: KeyboardEvent) => enabled && !e.isComposing && !e.altKey && !isTyping(e) && !inOverlay(e);
  const letter = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;
  usePageShortcut(root, (e) => free(e) && mod(e) && !e.shiftKey && letter(e, 'z'), () => handlers.current.undo());
  usePageShortcut(root, (e) => free(e) && ((mod(e) && e.shiftKey && letter(e, 'z')) || (!isMac() && e.ctrlKey && !e.metaKey && !e.shiftKey && letter(e, 'y'))), () => handlers.current.redo());
  const plain = (e: KeyboardEvent) => free(e) && bare(e) && !e.shiftKey;
  usePageShortcut(root, (e) => plain(e) && (e.key === ' ' || e.code === 'Space') && !activatesControl(e, PLAYER_CONTROLS), () => handlers.current.toggle());
  usePageShortcut(root, (e) => plain(e) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !activatesControl(e, PLAYER_CONTROLS), (e) => handlers.current.step(e.key === 'ArrowRight' ? 1 : -1));
  usePageShortcut(root, (e) => plain(e) && (e.key === 'Delete' || e.key === 'Backspace'), () => handlers.current.remove());
  usePageShortcut(root, (e) => plain(e) && letter(e, 'c') && !activatesControl(e) && Boolean(handlers.current.commentClip), () => handlers.current.commentClip?.());
  usePageShortcut(root, (e) => plain(e) && letter(e, 'r') && !activatesControl(e) && Boolean(handlers.current.commentRange), () => handlers.current.commentRange?.());
  usePageShortcut(root, (e) => plain(e) && letter(e, 'p') && !activatesControl(e) && Boolean(handlers.current.commentSpot), () => handlers.current.commentSpot?.());
  usePageShortcut(root, (e) => plain(e) && e.key === 'Escape', () => handlers.current.deselect());
}

export interface NudgeHandlers {
  /** Whether a boxed clip is selected (otherwise the keys are left alone). */
  can(): boolean;
  /** Moves the selected clip by whole composition pixels. */
  nudge(dx: number, dy: number): void;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Alt+arrows nudge the selected clip by 1 composition pixel, Alt+Shift+arrows by 10. Plain arrows stay frame-step. Never while
 * typing, never from a modal or popover on top. The caller coalesces a burst into one undo step and refuses locked clips.
 */
export function useNudgeKeys(root: RefObject<Element | null>, enabled: boolean, h: NudgeHandlers): void {
  const handlers = useRef(h);
  handlers.current = h;
  usePageShortcut(
    root,
    (e) => enabled && e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing && Object.hasOwn(ARROWS, e.key) && !isTyping(e) && !inOverlay(e) && handlers.current.can(),
    (e) => {
      const [dx, dy] = ARROWS[e.key]!;
      const n = e.shiftKey ? 10 : 1;
      handlers.current.nudge(dx * n, dy * n);
    },
  );
}
