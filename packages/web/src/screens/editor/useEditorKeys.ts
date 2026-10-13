// The editor's keyboard map (Phase 10b): ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y outside macOS) undo and redo, Space plays
// and pauses, ← → step one frame, Delete explains that clips cannot be removed here, Esc deselects. Never while the user is
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
  usePageShortcut(root, (e) => plain(e) && e.key === 'Escape', () => handlers.current.deselect());
}
