// The editor's draft (Phase 10b): the composition being edited, its undo / redo history and the problems
// `validateComposition` finds in it. A module store like pendingPins.ts, keyed by project/creative/format: it survives a
// route change inside the app (the page unmounts, the draft stays) and not a reload. Every `apply` goes through
// `applyEdit` (the one rule set shared with the core) and re-validates with the files of the composition folder plus the
// files staged for this draft, so Save can be disabled with the first problem's text while the core refuses the same.
import {
  applyEdit, compositionProblem, validateComposition,
  type Composition, type CompositionProblem, type EditOp, type EditorCompositionView, type EditResult, type FormatPreset, type StagedAsset,
} from '@motion-studio/shared';
import { useMemo, useSyncExternalStore } from 'react';

/** Undo steps kept (the oldest is dropped). */
export const HISTORY_MAX = 200;
/**
 * Edits with the same `coalesce` key this close together are one undo step (typing, a slider). A pointer gesture passes
 * `hold`: its edits join whatever the time between them (a drag held still), until `endRun()` closes it.
 */
export const COALESCE_MS = 500;

/** One point of the history: what an undo restores. Staged files are not part of it (they stay in the session). */
export type Snapshot = { composition: Composition; ops: EditOp[] };

export type Draft = {
  key: string;
  base: { n: number; format: string; hash: string };
  /** The composition as it was opened: what the player is told to show again after a discard. */
  baseComposition: Composition;
  composition: Composition;
  /** Every file of the composition folder plus the staged ones, by composition-relative path. */
  files: Map<string, { size: number }>;
  staged: StagedAsset[];
  ops: EditOp[];
  past: Snapshot[];
  future: Snapshot[];
  problems: CompositionProblem[];
  /** The format the composition belongs to (a follower edits its primary's). */
  primaryFormat: string;
  /** The format the editor was opened from. */
  format: string;
  fonts: EditorCompositionView['fonts'];
  preset: FormatPreset;
};

export type DraftActions = {
  /** Starts a draft from the editor's view of a version. An existing draft with edits is kept as it is (never lost). */
  open(view: EditorCompositionView, preset?: FormatPreset): void;
  apply(op: EditOp, opts?: { coalesce?: string; hold?: boolean }): EditResult;
  undo(): void;
  redo(): void;
  discard(): void;
  stage(asset: StagedAsset): void;
  /** Ends the coalescing run: the next edit is a new undo step even with the same key (the end of a drag). */
  endRun(): void;
};

export const draftKey = (project: string, creative: string, format: string) => `${project}/${creative}/${format}`;

const store = new Map<string, Draft>();
/** The coalescing run of each draft: its key and when the last edit of it happened. */
const runs = new Map<string, { key: string; at: number }>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const emit = () => { for (const l of listeners) l(); };
let version = 0;
const bump = () => { version += 1; emit(); };

/** What the view's size and duration say about the format when the caller has no catalog entry. */
function presetOf(view: EditorCompositionView): FormatPreset {
  const c = view.composition;
  return { id: view.primaryFormat, kind: c.duration === 0 ? 'image' : 'video', width: c.width, height: c.height } as unknown as FormatPreset;
}

function validate(composition: Composition, files: Map<string, { size: number }>, preset: FormatPreset): CompositionProblem[] {
  return validateComposition(composition, { format: preset, files }).problems;
}

const filesOf = (view: EditorCompositionView) => new Map(view.files.map((f) => [f.path, { size: f.size }] as const));
const dirty = (d: Draft) => d.ops.length > 0;

function open(key: string, view: EditorCompositionView, preset: FormatPreset = presetOf(view)): void {
  const existing = store.get(key);
  // A draft with edits is never replaced: the caller shows the "base changed" dialog when the bases differ.
  if (existing && dirty(existing)) return;
  const files = filesOf(view);
  for (const s of existing?.staged ?? []) files.set(s.path, { size: s.size });
  const composition = structuredClone(view.composition);
  store.set(key, {
    key, base: { n: view.n, format: view.primaryFormat, hash: view.hash }, baseComposition: view.composition, composition, files,
    staged: existing?.staged ?? [], ops: [], past: [], future: [], problems: validate(composition, files, preset),
    primaryFormat: view.primaryFormat, format: view.format, fonts: view.fonts, preset,
  });
  runs.delete(key);
  bump();
}

function apply(key: string, op: EditOp, opts?: { coalesce?: string; hold?: boolean }): EditResult {
  const d = store.get(key);
  if (!d) return { ok: false, problem: compositionProblem('editor.badOp') };
  const r = applyEdit(d.composition, op, { files: new Set(d.files.keys()) });
  if (!r.ok) return r;
  const now = Date.now();
  const run = runs.get(key);
  const joins = opts?.coalesce !== undefined && run?.key === opts.coalesce && (opts.hold === true || now - run.at <= COALESCE_MS) && d.past.length > 0;
  let past = d.past;
  let ops = d.ops;
  if (joins) {
    // The same gesture: one undo step, one entry in the edit log.
    ops = [...d.ops.slice(0, -1), op];
  } else {
    past = [...d.past, { composition: d.composition, ops: d.ops }];
    if (past.length > HISTORY_MAX) past = past.slice(past.length - HISTORY_MAX);
    ops = [...d.ops, op];
  }
  if (opts?.coalesce !== undefined) runs.set(key, { key: opts.coalesce, at: now }); else runs.delete(key);
  store.set(key, { ...d, composition: r.composition, ops, past, future: [], problems: validate(r.composition, d.files, d.preset) });
  bump();
  return r;
}

function travel(key: string, dir: 'undo' | 'redo'): void {
  const d = store.get(key);
  if (!d) return;
  const from = dir === 'undo' ? d.past : d.future;
  const target = from.at(-1);
  if (!target) return;
  const here: Snapshot = { composition: d.composition, ops: d.ops };
  runs.delete(key);
  store.set(key, {
    ...d, composition: target.composition, ops: target.ops,
    past: dir === 'undo' ? d.past.slice(0, -1) : [...d.past, here].slice(-HISTORY_MAX),
    future: dir === 'undo' ? [...d.future, here] : d.future.slice(0, -1),
    problems: validate(target.composition, d.files, d.preset),
  });
  bump();
}

function stage(key: string, asset: StagedAsset): void {
  const d = store.get(key);
  if (!d) return;
  const files = new Map(d.files).set(asset.path, { size: asset.size });
  const staged = [...d.staged.filter((s) => s.path !== asset.path), asset];
  store.set(key, { ...d, files, staged, problems: validate(d.composition, files, d.preset) });
  bump();
}

function discard(key: string): void {
  runs.delete(key);
  if (store.delete(key)) bump();
}

const actionsOf = (key: string): DraftActions => ({
  open: (view, preset) => open(key, view, preset),
  apply: (op, opts) => apply(key, op, opts),
  undo: () => travel(key, 'undo'),
  redo: () => travel(key, 'redo'),
  discard: () => discard(key),
  stage: (asset) => stage(key, asset),
  endRun: () => { runs.delete(key); },
});

export function useDraft(key: string): [Draft | null, DraftActions] {
  const draft = useSyncExternalStore(subscribe, () => store.get(key) ?? null, () => store.get(key) ?? null);
  const actions = useMemo(() => actionsOf(key), [key]);
  return [draft, actions];
}

/** The draft now, outside React (the leave guard, the keyboard map, save). */
export const peekDraft = (key: string): Draft | null => store.get(key) ?? null;

/** Drafts with edits not saved yet, across the app: the desktop close confirmation and `beforeunload` ask when > 0. */
export function unsavedDrafts(): number {
  let n = 0;
  for (const d of store.values()) if (dirty(d)) n += 1;
  return n;
}

/** Re-renders when any draft changes (the count above). */
export function useUnsavedDrafts(): number {
  useSyncExternalStore(subscribe, () => version, () => version);
  return unsavedDrafts();
}

/** Whether `d` has edits to lose. */
export const isDirty = dirty;

/** Tests only. */
export function __resetDrafts(): void {
  store.clear();
  runs.clear();
  bump();
}
