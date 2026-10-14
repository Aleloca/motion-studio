import { describe, expect, it } from 'vitest';
import { rowAt, sceneRows } from '../src/components/SceneThumb.tsx';
import { sceneAt } from '../src/screens/editor/ScenesColumn.tsx';

const label = { scene: (p: { n: number }) => `Scene ${p.n}`, wholeVideo: 'Whole video' };

describe('scene rows (UX feedback 1, Task 2)', () => {
  it('rows in time order; an unnamed scene is numbered; no scenes is one whole-video row', () => {
    expect(sceneRows({ duration: 6, scenes: [{ id: 'b', start: 3, duration: 3 }, { id: 'a', name: 'Intro', start: 0, duration: 3 }] }, label))
      .toEqual([{ id: 'a', name: 'Intro', start: 0, duration: 3 }, { id: 'b', name: 'Scene 2', start: 3, duration: 3 }]);
    expect(sceneRows({ duration: 6, scenes: [] }, label)).toEqual([{ id: null, name: 'Whole video', start: 0, duration: 6 }]);
  });

  it('a first scene that starts after 0: the time before it marks the first row', () => {
    const rows = [{ start: 1, duration: 2 }, { start: 3, duration: 3 }];
    expect(rowAt(rows, 0)).toBe(0);
    expect(rowAt(rows, 0.99)).toBe(0);
    expect(rowAt(rows, 1)).toBe(0);
    expect(rowAt(rows, 3)).toBe(1);
  });

  it('a gap between scenes keeps the scene before it; past the end, the last', () => {
    const rows = [{ start: 0, duration: 2 }, { start: 4, duration: 2 }];
    expect(rowAt(rows, 1.5)).toBe(0);
    expect(rowAt(rows, 3)).toBe(0); // in the gap: not the last row
    expect(rowAt(rows, 4)).toBe(1);
    expect(rowAt(rows, 10)).toBe(1);
    expect(rowAt([], 1)).toBe(0);
  });

  it('the editor marks the same scene (sceneAt)', () => {
    const scenes = [{ id: 'a', start: 1, duration: 1 }, { id: 'b', start: 4, duration: 2 }];
    expect(sceneAt(scenes, 0)?.id).toBe('a');
    expect(sceneAt(scenes, 3)?.id).toBe('a');
    expect(sceneAt(scenes, 5)?.id).toBe('b');
  });
});
