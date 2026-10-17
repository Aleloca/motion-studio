// The editor's draft (Phase 10b): the composition being edited, its undo / redo history and the problems
// `validateComposition` finds in it. A module store like pendingPins.ts, keyed by project/creative/format: it survives a
// route change inside the app (the page unmounts, the draft stays) and not a reload. Every `apply` goes through
// `applyEdit` (the one rule set shared with the core) and re-validates with the files of the composition folder plus the
// files staged for this draft, so Save can be disabled with the first problem's text while the core refuses the same.
import {
  applyEdit, compositionProblem, draftSizeProblem, validateComposition,
  type Composition, type CompositionProblem, type EditOp, type EditorCompositionView, type EditResult, type FormatPreset, type StagedAsset, type StageRequest,
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
  /** Files staged for this draft, each with what it was staged from (to stage it again in a new session, decisions log 264). */
  staged: StagedEntry[];
  /** The preview session (token) the staged files are known to be in; another session must take them over or stage them again. */
  stagedIn: string | null;
  /**
   * SVG inner editor: the text of SVG files the core checked (a base file it read, an edit it staged), by composition path.
   * Not part of the history: an undo puts an older `src` back, and its text is found here again.
   */
  svgTexts: ReadonlyMap<string, string>;
  /**
   * SVG inner editor: the clips with SVG changes not staged and applied yet (waiting for the delay, or on their way). Save
   * waits for them and leaving asks, as for edits (`isDirty`).
   */
  svgPending: ReadonlySet<string>;
  /** Which opening of this draft it is: a late answer meant for an earlier one (saved or discarded since) is dropped. */
  gen: number;
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

export type StagedEntry = StagedAsset & { from?: StageRequest['from'] };

export type DraftActions = {
  /** Starts a draft from the editor's view of a version. An existing draft with edits is kept as it is (never lost). */
  open(view: EditorCompositionView, preset?: FormatPreset): void;
  apply(op: EditOp, opts?: { coalesce?: string; hold?: boolean }): EditResult;
  /** Applies several edits as one undo step (all or none): the first refusal is returned and nothing changes. */
  applyAll(ops: EditOp[]): EditResult;
  undo(): void;
  redo(): void;
  discard(): void;
  /** A staged file (new, or as a renewed session reports it: its media index may differ), in session `token` when given. */
  stage(asset: StagedAsset, o?: { from?: StageRequest['from']; token?: string }): void;
  /** The staged files are now known to be in session `token`. */
  stagedIn(token: string): void;
  /** Records the checked text of the SVG file `path` (SVG inner editor). */
  svgText(path: string, text: string): void;
  /** Marks the clip as having SVG changes on their way (or not any more). */
  svgPending(clipId: string, on: boolean): void;
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
/** The count of drafts opened (`Draft.gen`). */
let opened = 0;
const bump = () => { version += 1; emit(); };

/** What the view's size and duration say about the format when the caller has no catalog entry. */
function presetOf(view: EditorCompositionView): FormatPreset {
  const c = view.composition;
  return { id: view.primaryFormat, kind: c.duration === 0 ? 'image' : 'video', width: c.width, height: c.height } as unknown as FormatPreset;
}

function validate(composition: Composition, files: Map<string, { size: number }>, preset: FormatPreset): CompositionProblem[] {
  // The core's size rule too (final review M5): the same compact JSON of the normalised draft, the same limit.
  const tooLarge = draftSizeProblem(composition);
  return [...(tooLarge ? [tooLarge] : []), ...validateComposition(composition, { format: preset, files }).problems];
}

const filesOf = (view: EditorCompositionView) => new Map(view.files.map((f) => [f.path, { size: f.size }] as const));
const dirty = (d: Draft) => d.ops.length > 0 || d.svgPending.size > 0;

/**
 * The SVG texts a new draft keeps: only those of staged edits (their name holds their hash). A base file's text belongs to
 * the version it was read from: another version may hold other content under the same path.
 */
function keptTexts(d: Draft | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of d?.staged ?? []) {
    const text = d?.svgTexts.get(s.path);
    if (s.svgEdit && text !== undefined) out.set(s.path, text);
  }
  return out;
}

function open(key: string, view: EditorCompositionView, preset: FormatPreset = presetOf(view)): void {
  const existing = store.get(key);
  // A draft with edits is never replaced: the caller shows the "base changed" dialog when the bases differ.
  if (existing && dirty(existing)) return;
  const files = filesOf(view);
  for (const s of existing?.staged ?? []) files.set(s.path, { size: s.size });
  const composition = structuredClone(view.composition);
  store.set(key, {
    key, base: { n: view.n, format: view.primaryFormat, hash: view.hash }, baseComposition: view.composition, composition, files,
    staged: existing?.staged ?? [], stagedIn: existing?.stagedIn ?? null, svgTexts: keptTexts(existing), svgPending: new Set(), gen: ++opened, ops: [], past: [], future: [], problems: validate(composition, files, preset),
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

function applyAll(key: string, list: EditOp[]): EditResult {
  const d = store.get(key);
  if (!d || list.length === 0) return { ok: false, problem: compositionProblem('editor.badOp') };
  let composition = d.composition;
  let r: EditResult = { ok: true, composition };
  for (const op of list) {
    r = applyEdit(composition, op, { files: new Set(d.files.keys()) });
    if (!r.ok) return r;
    composition = r.composition;
  }
  runs.delete(key);
  let past = [...d.past, { composition: d.composition, ops: d.ops }];
  if (past.length > HISTORY_MAX) past = past.slice(past.length - HISTORY_MAX);
  store.set(key, { ...d, composition, ops: [...d.ops, ...list], past, future: [], problems: validate(composition, d.files, d.preset) });
  bump();
  return r;
}

function svgText(key: string, path: string, text: string): void {
  const d = store.get(key);
  if (!d || d.svgTexts.get(path) === text) return;
  store.set(key, { ...d, svgTexts: new Map(d.svgTexts).set(path, text) });
  bump();
}

function svgPending(key: string, clipId: string, on: boolean): void {
  const d = store.get(key);
  if (!d || d.svgPending.has(clipId) === on) return;
  const next = new Set(d.svgPending);
  if (on) next.add(clipId); else next.delete(clipId);
  store.set(key, { ...d, svgPending: next });
  bump();
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

function stage(key: string, asset: StagedAsset, o: { from?: StageRequest['from']; token?: string } = {}): void {
  const d = store.get(key);
  if (!d) return;
  const files = new Map(d.files).set(asset.path, { size: asset.size });
  const before = d.staged.find((s) => s.path === asset.path);
  const from = o.from ?? before?.from;
  const entry: StagedEntry = { ...asset, ...(from ? { from } : {}) };
  // Same place in the list (a renewal's update keeps the order the media indices were given in).
  const staged = before ? d.staged.map((s) => (s.path === asset.path ? entry : s)) : [...d.staged, entry];
  store.set(key, { ...d, files, staged, stagedIn: o.token ?? d.stagedIn, problems: validate(d.composition, files, d.preset) });
  bump();
}

function stagedIn(key: string, token: string): void {
  const d = store.get(key);
  if (!d || d.stagedIn === token) return;
  store.set(key, { ...d, stagedIn: token });
  bump();
}

function discard(key: string): void {
  runs.delete(key);
  if (store.delete(key)) bump();
}

const actionsOf = (key: string): DraftActions => ({
  open: (view, preset) => open(key, view, preset),
  apply: (op, opts) => apply(key, op, opts),
  applyAll: (ops) => applyAll(key, ops),
  svgText: (path, text) => svgText(key, path, text),
  svgPending: (clipId, on) => svgPending(key, clipId, on),
  undo: () => travel(key, 'undo'),
  redo: () => travel(key, 'redo'),
  discard: () => discard(key),
  stage: (asset, o) => stage(key, asset, o),
  stagedIn: (token) => stagedIn(key, token),
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
