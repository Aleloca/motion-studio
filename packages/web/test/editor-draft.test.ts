import { act, renderHook } from '@testing-library/react';
import { COMPOSITION_LIMITS, DEFAULT_FORMATS, type Composition, type EditorCompositionView, type StagedAsset } from '@motion-studio/shared';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDrafts, draftKey, HISTORY_MAX, COALESCE_MS, peekDraft, unsavedDrafts, useDraft } from '../src/screens/editor/draftStore.ts';

const spike = spikeJson as unknown as Composition;
const REEL = DEFAULT_FORMATS.find((f) => f.id === 'instagram-reel-9x16')!;
const FILES = ['composition.json', 'assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav', 'layers/outro.html'];
const view = (over: Partial<EditorCompositionView> = {}): EditorCompositionView => ({
  n: 4, format: REEL.id, primaryFormat: REEL.id, hash: 'a'.repeat(64), composition: structuredClone(spike),
  files: FILES.map((path) => ({ path, size: 1000 })), fonts: [], ...over,
});
const KEY = draftKey('acme', 'lancio', REEL.id);
const move = (x: number) => ({ kind: 'clipProps', clipId: 'title', props: { x } }) as const;
const titleX = (c: Composition) => (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as unknown as { props: { x?: number } }).props.x;

function setup() {
  const h = renderHook(() => useDraft(KEY));
  const actions = () => h.result.current[1];
  const draft = () => h.result.current[0];
  act(() => actions().open(view(), REEL));
  return { h, actions, draft };
}

beforeEach(() => { vi.useFakeTimers(); __resetDrafts(); });
afterEach(() => vi.useRealTimers());

describe('draft store', () => {
  it('has no draft until it is opened, then holds the base and the composition', () => {
    const h = renderHook(() => useDraft(KEY));
    expect(h.result.current[0]).toBeNull();
    act(() => h.result.current[1].open(view(), REEL));
    const d = h.result.current[0]!;
    expect(d.base).toEqual({ n: 4, format: REEL.id, hash: 'a'.repeat(64) });
    expect(d.ops).toEqual([]);
    expect(d.problems).toEqual([]);
    expect(d.files.get('assets/photo.jpg')).toEqual({ size: 1000 });
  });

  it('the core\'s size rule is the draft\'s first problem: compact JSON of the normalised draft over the limit (final review M5)', () => {
    const { actions } = setup();
    expect(peekDraft(KEY)!.problems.map((p) => p.key)).not.toContain('composition.jsonTooLarge');
    // A text far over the size limit (the schema's own text limit aside, the size rule comes first).
    act(() => { actions().apply({ kind: 'clipProps', clipId: 'title', props: { text: 'x' } }); });
    const big = structuredClone(peekDraft(KEY)!.composition);
    (big.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as unknown as { props: { text: string } }).props.text = 'x'.repeat(COMPOSITION_LIMITS.jsonBytes);
    act(() => { __resetDrafts(); actions().open(view({ composition: big }), REEL); });
    expect(peekDraft(KEY)!.problems[0]!.key).toBe('composition.jsonTooLarge');
  });

  it('apply changes the composition, records the op, and undo / redo walk the history', () => {
    const { actions, draft } = setup();
    const before = titleX(draft()!.composition);
    let r;
    act(() => { r = actions().apply(move(111)); });
    expect(r).toMatchObject({ ok: true });
    expect(titleX(draft()!.composition)).toBe(111);
    expect(draft()!.ops).toHaveLength(1);
    act(() => actions().apply(move(222)));
    expect(draft()!.ops).toHaveLength(2);
    act(() => actions().undo());
    expect(titleX(draft()!.composition)).toBe(111);
    expect(draft()!.ops).toHaveLength(1);
    act(() => actions().undo());
    expect(titleX(draft()!.composition)).toBe(before);
    expect(draft()!.ops).toHaveLength(0);
    act(() => actions().undo()); // nothing left: no-op
    expect(titleX(draft()!.composition)).toBe(before);
    act(() => actions().redo());
    act(() => actions().redo());
    expect(titleX(draft()!.composition)).toBe(222);
    expect(draft()!.ops).toHaveLength(2);
    act(() => actions().redo());
    expect(titleX(draft()!.composition)).toBe(222);
  });

  it('a new edit clears the redo history', () => {
    const { actions, draft } = setup();
    act(() => actions().apply(move(1)));
    act(() => actions().undo());
    expect(draft()!.future).toHaveLength(1);
    act(() => actions().apply(move(2)));
    expect(draft()!.future).toHaveLength(0);
  });

  it('an invalid op leaves the state unchanged and says why', () => {
    const { actions, draft } = setup();
    act(() => actions().apply(move(5)));
    const snapshot = draft();
    let r: ReturnType<typeof actions>['apply'] extends (...a: never[]) => infer R ? R : never;
    act(() => { r = actions().apply({ kind: 'clipProps', clipId: 'nope', props: { x: 1 } }); });
    expect(r!.ok).toBe(false);
    if (!r!.ok) expect(r!.problem.key).toBe('editor.unknownClip');
    expect(draft()).toBe(snapshot);
    expect(draft()!.past).toHaveLength(1);
  });

  it('the same coalesce key within 500 ms is one undo step; a pause or another key starts a new one', () => {
    const { actions, draft } = setup();
    act(() => actions().apply(move(1), { coalesce: 'drag:title' }));
    vi.advanceTimersByTime(COALESCE_MS - 100);
    act(() => actions().apply(move(2), { coalesce: 'drag:title' }));
    vi.advanceTimersByTime(COALESCE_MS - 100);
    act(() => actions().apply(move(3), { coalesce: 'drag:title' }));
    expect(draft()!.past).toHaveLength(1);
    expect(draft()!.ops).toHaveLength(1);
    expect(titleX(draft()!.composition)).toBe(3);
    vi.advanceTimersByTime(COALESCE_MS + 1);
    act(() => actions().apply(move(4), { coalesce: 'drag:title' }));
    expect(draft()!.past).toHaveLength(2);
    act(() => actions().apply(move(5), { coalesce: 'type:subtitle' }));
    expect(draft()!.past).toHaveLength(3);
    act(() => actions().undo());
    expect(titleX(draft()!.composition)).toBe(4);
    act(() => actions().undo());
    expect(titleX(draft()!.composition)).toBe(3);
  });

  it('an undo ends a coalesced run', () => {
    const { actions, draft } = setup();
    act(() => actions().apply(move(1), { coalesce: 'k' }));
    act(() => actions().undo());
    act(() => actions().apply(move(2), { coalesce: 'k' }));
    expect(draft()!.past).toHaveLength(1);
    expect(draft()!.ops).toHaveLength(1);
  });

  it('keeps at most 200 undo steps', () => {
    const { actions, draft } = setup();
    for (let i = 0; i < HISTORY_MAX + 20; i += 1) act(() => actions().apply(move(i)));
    expect(draft()!.past).toHaveLength(HISTORY_MAX);
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) act(() => actions().undo());
    expect(draft()!.past).toHaveLength(0);
    expect(titleX(draft()!.composition)).toBe(19); // the oldest step kept is the state after edit #20
  });

  it('validates every apply with the files map: a missing file is a problem, the op itself is refused', () => {
    const { actions, draft } = setup();
    let r;
    act(() => { r = actions().apply({ kind: 'clipMedia', clipId: 'photo1', src: 'assets/missing.jpg' }); });
    expect(r).toMatchObject({ ok: false });
    expect(draft()!.problems).toEqual([]);
  });

  it('problems of the draft come from validateComposition, re-checked on every apply and when a file is staged', () => {
    const h = renderHook(() => useDraft(KEY));
    // The base already lacks a file its composition names (as a version the agent left half-done would).
    act(() => h.result.current[1].open(view({ files: view().files.filter((f) => f.path !== 'assets/photo.jpg') }), REEL));
    expect(h.result.current[0]!.problems.length).toBeGreaterThan(0);
    act(() => { h.result.current[1].apply(move(7)); });
    expect(h.result.current[0]!.problems.length).toBeGreaterThan(0);
    act(() => h.result.current[1].stage({ path: 'assets/photo.jpg', size: 10, kind: 'image' }));
    expect(h.result.current[0]!.problems).toEqual([]);
  });

  it('staging a file adds it to the files map and the staged list; the new path is usable by an op', () => {
    const { actions, draft } = setup();
    const asset: StagedAsset = { path: 'assets/lib/ab12cd34-new.jpg', size: 2048, kind: 'image', width: 100, height: 100 };
    let r;
    act(() => { r = actions().apply({ kind: 'clipMedia', clipId: 'photo1', src: asset.path }); });
    expect(r).toMatchObject({ ok: false });
    act(() => actions().stage(asset));
    expect(draft()!.staged).toEqual([asset]);
    expect(draft()!.files.get(asset.path)).toEqual({ size: 2048 });
    act(() => { r = actions().apply({ kind: 'clipMedia', clipId: 'photo1', src: asset.path }); });
    expect(r).toMatchObject({ ok: true });
  });

  it('discard drops the draft; open again starts from the base', () => {
    const { h, actions, draft } = setup();
    act(() => actions().apply(move(9)));
    expect(unsavedDrafts()).toBe(1);
    act(() => actions().discard());
    expect(draft()).toBeNull();
    expect(peekDraft(KEY)).toBeNull();
    expect(unsavedDrafts()).toBe(0);
    act(() => h.result.current[1].open(view(), REEL));
    expect(draft()!.ops).toHaveLength(0);
  });

  it('survives an unmount (a route change) and is found again, with its history', () => {
    const first = setup();
    act(() => first.actions().apply(move(9)));
    first.h.unmount();
    const again = renderHook(() => useDraft(KEY));
    expect(again.result.current[0]!.ops).toHaveLength(1);
    // Opening again on the same base keeps the edits.
    act(() => again.result.current[1].open(view(), REEL));
    expect(again.result.current[0]!.ops).toHaveLength(1);
    act(() => again.result.current[1].undo());
    expect(again.result.current[0]!.ops).toHaveLength(0);
  });

  it('a draft with edits is never replaced by open() on another base (never lose the draft)', () => {
    const { actions, draft } = setup();
    act(() => actions().apply(move(9)));
    act(() => actions().open(view({ n: 5, hash: 'c'.repeat(64) }), REEL));
    expect(draft()!.base.n).toBe(4);
    expect(draft()!.ops).toHaveLength(1);
  });

  it('an untouched draft is replaced by open() on a newer base', () => {
    const { actions, draft } = setup();
    act(() => actions().open(view({ n: 5, hash: 'c'.repeat(64) }), REEL));
    expect(draft()!.base.n).toBe(5);
  });

  it('counts only drafts that have edits as unsaved', () => {
    const { actions } = setup();
    expect(unsavedDrafts()).toBe(0);
    act(() => actions().apply(move(1)));
    expect(unsavedDrafts()).toBe(1);
    act(() => actions().undo());
    expect(unsavedDrafts()).toBe(0);
  });
});
