import { describe, expect, it } from 'vitest';
import { applyEdit, type Composition, type EditOp } from '../src/index.ts';
import { clipOf, copy, expectValid, spike } from './composition-edit-helpers.ts';

const anim = (c: Composition, id: string) => (clipOf(c, id) as { animations?: unknown[] }).animations;
function ok(c: Composition, op: EditOp): Composition {
  const before = copy(c);
  const r = applyEdit(c, op);
  expect(c).toEqual(before);
  if (!r.ok) throw new Error(`refused: ${r.problem.key}`);
  expectValid(r.composition);
  return r.composition;
}
const op = (clipId: string, slot: 'in' | 'out', preset: Extract<EditOp, { kind: 'animationPreset' }>['preset'], duration = 0.4): EditOp => ({ kind: 'animationPreset', clipId, slot, preset, duration });

describe('animationPreset', () => {
  it('replaces the entry preset, keeping the rest of the clip as it is', () => {
    const out = ok(spike, op('card', 'in', 'popIn', 0.5));
    expect(anim(out, 'card')).toEqual([{ preset: 'popIn', duration: 0.5 }]);
  });
  it('adds an exit preset ending with the clip, and replaces it', () => {
    const added = ok(spike, op('card', 'out', 'fadeOut', 0.4));
    expect(anim(added, 'card')).toEqual([{ preset: 'fadeIn', duration: 0.3 }, { preset: 'fadeOut', start: 1.6, duration: 0.4 }]);
    const replaced = ok(added, op('card', 'out', 'slideDown', 0.6));
    expect(anim(replaced, 'card')).toEqual([{ preset: 'fadeIn', duration: 0.3 }, { preset: 'slideDown', start: 1.4, duration: 0.6 }]);
  });
  it('removes a preset with null and drops an empty list', () => {
    const out = ok(spike, op('card', 'in', null));
    expect(clipOf(out, 'card')).not.toHaveProperty('animations');
    expect(ok(spike, op('card', 'out', null))).toEqual(spike);
  });
  it('keeps tweens and keyframes written by the agent', () => {
    const out = ok(spike, op('subtitle', 'in', 'slideUp', 0.3));
    expect(anim(out, 'subtitle')).toEqual([spike.tracks[2]!.clips[1]!.type === 'text' ? { prop: 'scale', from: 0.6, to: 1, duration: 0.5, ease: 'cubic-bezier(.34,1.56,.64,1)' } : null, { preset: 'slideUp', duration: 0.3 }]);
    const kf = ok(spike, op('caption', 'out', 'fadeOut', 0.3));
    expect(anim(kf, 'caption')).toHaveLength(2);
    expect((anim(kf, 'caption') as Array<Record<string, unknown>>)[0]).toEqual((anim(spike, 'caption') as unknown[])[0]);
  });
  it('replaces only the first preset of a slot holding several', () => {
    const out = ok(spike, op('title', 'in', 'popIn', 0.2));
    expect(anim(out, 'title')).toEqual([{ preset: 'popIn', duration: 0.2 }, { preset: 'fadeIn', duration: 0.5 }]);
  });
  it('refuses a slot taken by a custom animation without a preset to replace', () => {
    const r = applyEdit(spike, op('logo1', 'in', 'fadeIn'));
    // logo1 has a rotation tween at 0 and a popIn preset: the preset is replaceable
    expect(r.ok).toBe(true);
    const onlyTween = applyEdit(spike, op('caption', 'in', 'fadeIn'));
    expect(onlyTween.ok).toBe(false);
    if (!onlyTween.ok) expect(onlyTween.problem).toEqual({ key: 'editor.customAnimation', params: { clip: 'caption', slot: 'in' } });
  });
  it('clamps the duration to the clip, and refuses audio and locked clips', () => {
    expect(anim(ok(spike, op('card', 'in', 'fadeIn', 99)), 'card')).toEqual([{ preset: 'fadeIn', duration: 2 }]);
    const a = applyEdit(spike, op('music', 'in', 'fadeIn'));
    expect(!a.ok && a.problem.key).toBe('editor.wrongType');
  });
});
