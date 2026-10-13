import type { EditOp } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { compactOps } from '../src/screens/editor/opsCompact.ts';

describe('compactOps', () => {
  it('2000 mixed edits of a few clips and fields become one op per object, the last value winning', () => {
    const ops: EditOp[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const k = i % 5;
      ops.push(k === 0 ? { kind: 'clipProps', clipId: i % 2 ? 'a' : 'b', props: { x: i } }
        : k === 1 ? { kind: 'clipProps', clipId: 'a', props: { text: `t${i}` } }
        : k === 2 ? { kind: 'sceneDuration', sceneId: 's1', duration: 1 + (i % 3) }
        : k === 3 ? { kind: 'clipFlags', clipId: 'a', hidden: i % 2 === 0 }
        : { kind: 'htmlParam', clipId: 'h', key: 'k', value: i });
    }
    const out = compactOps(ops);
    expect(out.map((o) => o.kind)).toEqual(['clipProps', 'clipProps', 'sceneDuration', 'clipFlags', 'htmlParam']);
    expect(out[0]).toMatchObject({ clipId: 'b' });
    expect(out[1]).toMatchObject({ clipId: 'a', props: { x: 1995, text: 't1996' } });
    expect(out[4]).toMatchObject({ value: 1999 });
  });
  it('merges fields of one clip, keeps other objects apart, and leaves a short log alone', () => {
    const ops: EditOp[] = [
      { kind: 'clipProps', clipId: 'a', props: { x: 1 } },
      { kind: 'clipProps', clipId: 'a', props: { y: 2, x: 3 } },
      { kind: 'clipTiming', clipId: 'a', start: 0, duration: 1, ripple: false },
      { kind: 'clipTiming', clipId: 'a', start: 0, duration: 2, ripple: true },
      { kind: 'animationPreset', clipId: 'a', slot: 'in', preset: 'fadeIn', duration: 0.3 },
      { kind: 'animationPreset', clipId: 'a', slot: 'out', preset: null, duration: 0.3 },
    ];
    expect(compactOps(ops)).toEqual([
      { kind: 'clipProps', clipId: 'a', props: { x: 3, y: 2 } },
      { kind: 'clipTiming', clipId: 'a', start: 0, duration: 2, ripple: true },
      ops[4], ops[5],
    ]);
    expect(compactOps([])).toEqual([]);
  });
});
