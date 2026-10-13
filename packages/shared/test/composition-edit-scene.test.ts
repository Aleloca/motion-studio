import { describe, expect, it } from 'vitest';
import { applyEdit, sceneOrderAllowed, type Composition, type EditOp } from '../src/index.ts';
import { clipOf, copy, expectValid, mutate, reorderable, spike } from './composition-edit-helpers.ts';

function ok(c: Composition, op: EditOp): Composition {
  const before = copy(c);
  const r = applyEdit(c, op);
  expect(c).toEqual(before);
  if (!r.ok) throw new Error(`refused: ${r.problem.key} ${JSON.stringify(r.problem.params)}`);
  expectValid(r.composition);
  return r.composition;
}
function refused(c: Composition, op: EditOp, key: string, params?: Record<string, unknown>) {
  const r = applyEdit(c, op);
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.problem.key).toBe(key); if (params) expect(r.problem.params).toMatchObject(params); }
}
const sd = (sceneId: string, duration: number): EditOp => ({ kind: 'sceneDuration', sceneId, duration });
const starts = (c: Composition) => c.scenes.map((s) => [s.id, s.start, s.duration]);

describe('sceneDuration', () => {
  it('grows a scene: later scenes and clips shift, spanning clips stretch, the duration follows', () => {
    const out = ok(spike, sd('photo', 3));
    expect(starts(out)).toEqual([['intro', 0, 2], ['photo', 2, 3], ['outro', 5, 2]]);
    expect(out.duration).toBe(7);
    expect(clipOf(out, 'outro-html')).toMatchObject({ start: 5, duration: 2 });
    expect(clipOf(out, 'ding')).toMatchObject({ start: 5 });
    expect(clipOf(out, 'photo1')).toMatchObject({ start: 2, duration: 2 });
    expect(clipOf(out, 'bgv')).toMatchObject({ start: 0, duration: 7 });
    expect(clipOf(out, 'logo1')).toMatchObject({ start: 0, duration: 7 });
    expect(clipOf(out, 'music')).toMatchObject({ start: 0, duration: 7 });
    expect(clipOf(out, 'vo')).toMatchObject({ start: 0.5, duration: 4 });
  });
  it('grows the first scene, shifting everything after it', () => {
    const out = ok(spike, sd('intro', 2.5));
    expect(starts(out)).toEqual([['intro', 0, 2.5], ['photo', 2.5, 2], ['outro', 4.5, 2]]);
    expect(clipOf(out, 'caption')).toMatchObject({ start: 2.8 });
  });
  it('shrinks a scene, clamping clips that stick out when a frame is left', () => {
    const c = mutate((x) => { (clipOf(x, 'photo1') as { animations: unknown[] }).animations = [{ preset: 'fadeIn', duration: 0.25 }, { preset: 'fadeOut', start: 1.5, duration: 0.5 }]; delete (clipOf(x, 'caption') as { animations?: unknown }).animations; });
    refused(spike, sd('photo', 1.5), 'composition.animationOutside', { clip: 'caption' });
    const out = ok(c, sd('photo', 1.5));
    expect(starts(out)).toEqual([['intro', 0, 2], ['photo', 2, 1.5], ['outro', 3.5, 2]]);
    expect(out.duration).toBe(5.5);
    expect(clipOf(out, 'photo1')).toMatchObject({ start: 2, duration: 1.5 });
    expect((clipOf(out, 'photo1') as { animations: unknown[] }).animations).toEqual([{ preset: 'fadeIn', duration: 0.25 }, { preset: 'fadeOut', start: 1, duration: 0.5 }]);
    expect(clipOf(out, 'bgv')).toMatchObject({ duration: 5.5 });
    expect(clipOf(out, 'outro-html')).toMatchObject({ start: 3.5 });
  });
  it('refuses with the clip id when a clip would drop under one frame', () => {
    refused(spike, sd('photo', 0.3), 'composition.clipOutsideScene', { clip: 'caption', scene: 'photo' });
    // caption starts 0.3 into the scene: a scene of 0.3 leaves it no frame
  });
  it('refuses to clamp a locked clip but shifts locked clips', () => {
    const lockedCaption = mutate((x) => { (clipOf(x, 'caption') as { locked?: boolean }).locked = true; });
    refused(lockedCaption, sd('photo', 1.9), 'editor.locked', { clip: 'caption' });
    const lockedLater = mutate((x) => { (clipOf(x, 'outro-html') as { locked?: boolean }).locked = true; });
    expect(clipOf(ok(lockedLater, sd('photo', 3)), 'outro-html')).toMatchObject({ start: 5 });
  });
  it('refuses unknown scenes, bad durations and stills', () => {
    refused(spike, sd('nope', 1), 'editor.unknownScene');
    refused(spike, sd('photo', 0), 'editor.badValue');
    refused(spike, sd('photo', -1), 'editor.badValue');
    refused(spike, sd('photo', Number.NaN), 'editor.badValue');
    refused(spike, sd('photo', 601), 'editor.badValue');
    refused(spike, sd('photo', 599), 'editor.invalid');
  });
  it('treats a video without scenes as one implicit scene', () => {
    const c = mutate((x) => { x.scenes = []; x.tracks = x.tracks.filter((t) => t.id === 'text'); for (const k of x.tracks[0]!.clips) delete (k as { scene?: string }).scene; });
    const out = ok(c, sd('scene-1', 8));
    expect(out.scenes).toEqual([{ id: 'scene-1', start: 0, duration: 8 }]);
    expect(out.duration).toBe(8);
  });
});

describe('sceneOrder', () => {
  const order = (...o: string[]): EditOp => ({ kind: 'sceneOrder', order: o });
  it('says which clip blocks reordering', () => {
    expect(sceneOrderAllowed(spike)).toEqual({ ok: false, clipId: 'bgv' });
    expect(sceneOrderAllowed(reorderable())).toEqual({ ok: true });
    const dangling = mutate((c) => { c.tracks.push({ id: 'extra', kind: 'visual', clips: [{ id: 'banner', type: 'shape', start: 1, duration: 2, props: {} }] }); });
    expect(sceneOrderAllowed(dangling)).toEqual({ ok: false, clipId: 'bgv' });
  });
  it('permutes scenes and moves their clips; audio spanning scenes stays', () => {
    const out = ok(reorderable(), order('outro', 'intro', 'photo'));
    expect(starts(out)).toEqual([['outro', 0, 2], ['intro', 2, 2], ['photo', 4, 2]]);
    expect(clipOf(out, 'outro-html')).toMatchObject({ start: 0 });
    expect(clipOf(out, 'title')).toMatchObject({ start: 2.2, duration: 1.8 });
    expect(clipOf(out, 'photo1')).toMatchObject({ start: 4 });
    expect(clipOf(out, 'caption')).toMatchObject({ start: 4.3 });
    expect(clipOf(out, 'whoosh')).toMatchObject({ start: 4 });
    expect(clipOf(out, 'ding')).toMatchObject({ start: 0 });
    expect(clipOf(out, 'music')).toMatchObject({ start: 0, duration: 6 });
    expect(clipOf(out, 'vo')).toMatchObject({ start: 0.5, duration: 4 });
    expect(out.duration).toBe(6);
  });
  it('an identity order changes nothing', () => { expect(ok(reorderable(), order('intro', 'photo', 'outro'))).toEqual(reorderable()); });
  it('refuses a non permutation and a blocked reorder', () => {
    refused(reorderable(), order('intro', 'photo'), 'editor.badOrder');
    refused(reorderable(), order('intro', 'photo', 'photo'), 'editor.badOrder');
    refused(reorderable(), order('intro', 'photo', 'zzz'), 'editor.badOrder');
    refused(spike, order('outro', 'intro', 'photo'), 'editor.sceneOrderBlocked', { clip: 'bgv' });
  });
});
