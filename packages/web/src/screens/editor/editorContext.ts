// What the editor's panels share (Phase 10b): the draft and its actions, the stage player and its controls, the selected
// clip, and staging. Tasks 6 to 9 (stage handles, timeline, inspector, layers) read it with `useEditor()`.
import type { StagedAsset, StagedSvgEdit, StageRequest } from '@motion-studio/shared';
import type { SvgEditFrom } from '../../api.ts';
import { createContext, useContext } from 'react';
import type { CompositionMedia } from '../../components/CompositionPlayer.tsx';
import type { Draft, DraftActions } from './draftStore.ts';
import type { PlayerControls } from './usePlayerControls.ts';

export interface EditorState {
  slug: string;
  creative: string;
  /** The format the editor was opened from, and the primary whose composition is edited (the same unless a follower). */
  format: string;
  primary: string;
  draft: Draft;
  actions: DraftActions;
  /** The stage player's media handle (null until the frame is mounted). */
  player: CompositionMedia | null;
  controls: PlayerControls;
  /** The selected clip id (or null). */
  selection: string | null;
  select(id: string | null): void;
  /** Snap to guides (the stage) and to clip edges and scene bounds (the timeline): the magnet button. Per editor, not saved. */
  snap: boolean;
  setSnap(on: boolean): void;
  /** The live preview session's token, which owns the staging (the latest, after a renewal). */
  token: string | null;
  /**
   * Stages a library asset or a brand font for the draft. Large videos answer once normalised (`staging` says so meanwhile).
   * Resolves to the staged file, or null after showing the translated error.
   */
  stageAsset(from: StageRequest['from']): Promise<StagedAsset | null>;
  staging: boolean;
  /**
   * SVG inner editor: stages an edited SVG for the draft (the core checks it). Rejects with the core's error (`ApiError`,
   * its `problems` the check's reasons) for the caller to show where the edit was made.
   */
  stageSvg(from: SvgEditFrom): Promise<StagedSvgEdit>;
  /** Why nothing may be written from this editor (a discarded variant, phase 15), or null. */
  readOnly: string | null;
  /** SVG inner editor: the element of the selected svg clip chosen in the list or on the stage (its path), or null. */
  svgElement: string | null;
  selectSvgElement(path: string | null): void;
}

export const EditorContext = createContext<EditorState | null>(null);

export function useEditor(): EditorState {
  const e = useContext(EditorContext);
  if (!e) throw new Error('useEditor outside the editor');
  return e;
}
