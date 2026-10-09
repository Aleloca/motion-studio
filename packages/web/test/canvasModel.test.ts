import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/api.ts', () => ({ api: { fileUrl: () => '' } }));
const { boardsOf, fitZoom, toScreen, worldFixed, worldSize } = await import('../src/screens/canvasModel.ts');

describe('canvas fit to view (CV1)', () => {
  const boards = boardsOf(['tiktok-9x16', 'instagram-post-1x1'], DEFAULT_FORMATS, null);

  it('measures the world at 100%: tall boards in a row, the others stacked, with padding', () => {
    // 9:16 → 304×540 (+30 head); 1:1 → 344×344 (+30); gap 40; padding 60 each side, 40 top, 140 bottom.
    expect(worldSize(boards)).toEqual({ width: 304 + 40 + 344 + 120, height: 570 + 180 });
  });

  it('fits every board in the viewport, rounded down to 5%, never above 100% nor below the minimum', () => {
    const world = worldSize(boards);
    expect(fitZoom(world, { width: 484, height: 700 }, 0.5)).toBe(0.55); // 1024 px window, both side panels
    expect(fitZoom(world, { width: 2000, height: 2000 }, 0.5)).toBe(1);
    expect(fitZoom(world, { width: 100, height: 100 }, 0.5)).toBe(0.5);
    expect(fitZoom(world, { width: 0, height: 0 }, 0.5)).toBeNull();
  });

  it('keeps the board labels out of the zoom: their height is fixed, only the rest shrinks to fit', () => {
    const world = worldSize(boards);
    const fixed = worldFixed(boards);
    expect(fixed).toEqual({ width: 0, height: 30 });
    // 300 px tall: (300 − 30) / (750 − 30) = 0.375 → 35%, where scaling the labels too would give 0.4 → 40% overflowing.
    expect(fitZoom(world, { width: 2000, height: 300 }, 0.25, fixed)).toBe(0.35);
  });
});

describe('canvas world → screen', () => {
  it('maps a world point by the zoom and the pan', () => {
    expect(toScreen({ x: 86, y: 172 }, 0.5)).toEqual({ x: 43, y: 86 });
    expect(toScreen({ x: 86, y: 172 }, 2, { x: -10, y: 5 })).toEqual({ x: 162, y: 349 });
  });
});
