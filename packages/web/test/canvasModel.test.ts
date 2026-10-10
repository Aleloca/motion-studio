import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/api.ts', () => ({ api: { fileUrl: () => '' } }));
const { boardsWith, fitBoards, fitZoom, toScreen, worldAt, worldSize } = await import('../src/screens/canvasModel.ts');

describe('canvas fit to view (CV1)', () => {
  const boards = boardsWith(['tiktok-9x16', 'instagram-post-1x1'], DEFAULT_FORMATS, [], () => ({ format: '', n: null }));

  it('measures the world at 100%: tall boards in a row, the others stacked, with padding', () => {
    // 9:16 → 304×540 (+50 head: two 20 px lines, 2 px between, 8 px gap); 1:1 → 344×344 (+50); gap 40; padding 60 each side, 40 top, 140 bottom.
    expect(worldSize(boards)).toEqual({ width: 304 + 40 + 344 + 120, height: 590 + 180 });
  });

  it('fits every board in the viewport, rounded down to 5%, never above 100% nor below the minimum', () => {
    const world = worldSize(boards);
    expect(fitZoom(world, { width: 484, height: 700 }, 0.5)).toBe(0.55); // 1024 px window, both side panels
    expect(fitZoom(world, { width: 2000, height: 2000 }, 0.5)).toBe(1);
    expect(fitZoom(world, { width: 100, height: 100 }, 0.5)).toBe(0.5);
    expect(fitZoom(world, { width: 0, height: 0 }, 0.5)).toBeNull();
  });

  it('fits with the labels at their real size: fixed two-line height, at least 160 px wide', () => {
    // At 100% every label is one line over a wide frame: the same world as worldSize.
    expect(worldAt(boards, 1)).toEqual(worldSize(boards));
    // At 40% the frames are 121.6 and 137.6 px but their labels keep 160 px; the header is always 50 px.
    const small = worldAt(boards, 0.4);
    expect(small.width).toBeCloseTo(160 + 16 + 160 + 48);
    expect(small.height).toBeCloseTo(50 + 0.4 * 540 + 0.4 * 180);
    // 380 px: linear fit gives 45%, where the 160 px labels overflow (later steps: 40% → 384 px); 35% fits (376 px).
    expect(fitZoom(worldSize(boards), { width: 380, height: 2000 }, 0.25)).toBe(0.45);
    expect(fitBoards(boards, { width: 380, height: 2000 }, 0.25)).toBe(0.35);
    expect(fitBoards(boards, { width: 484, height: 700 }, 0.5)).toBe(0.55);
    expect(fitBoards(boards, { width: 2000, height: 2000 }, 0.5)).toBe(1);
    expect(fitBoards(boards, { width: 100, height: 100 }, 0.5)).toBe(0.5);
    expect(fitBoards(boards, { width: 0, height: 0 }, 0.5)).toBeNull();
    expect(fitBoards([], { width: 400, height: 400 }, 0.5)).toBeNull();
  });
});

describe('canvas world → screen', () => {
  it('maps a world point by the zoom and the pan', () => {
    expect(toScreen({ x: 86, y: 172 }, 0.5)).toEqual({ x: 43, y: 86 });
    expect(toScreen({ x: 86, y: 172 }, 2, { x: -10, y: 5 })).toEqual({ x: 162, y: 349 });
  });
});
