import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/api.ts', () => ({ api: { fileUrl: () => '' } }));
const { boardsWith, canvasGroups, canvasLines, fitBoards, fitZoom, labelMin, toScreen, worldAt, worldSize, FIT_MIN, LABEL_MIN } = await import('../src/screens/canvasModel.ts');

describe('canvas fit to view (CV1)', () => {
  const boards = [{ boards: boardsWith(['tiktok-9x16', 'instagram-post-1x1'], DEFAULT_FORMATS, [], () => ({ format: '', n: null })) }];

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

  it('fits with the labels at their real size: fixed two-line height, at least 176 px wide', () => {
    // At 100% every label is one line over a wide frame: the same world as worldSize.
    expect(worldAt(boards, 1)).toEqual(worldSize(boards));
    // At 40% the frames are 121.6 and 137.6 px but their labels keep 141 px (report 40: 176 px from 50% up, narrower below); the header is always 50 px.
    const small = worldAt(boards, 0.4);
    expect(small.width).toBeCloseTo(141 + 16 + 141 + 48);
    expect(small.height).toBeCloseTo(50 + 0.4 * 540 + 0.4 * 180);
    // 430 px: linear fit gives 50%, where the 176 px labels overflow on one line (432 px).
    expect(fitZoom(worldSize(boards), { width: 430, height: 2000 }, 0.25)).toBe(0.5);
    // Report 40: a line too long for the viewport wraps; 430 × 2000 takes the two boards one under the other at 90%.
    expect(fitBoards(boards, { width: 430, height: 2000 }, 0.25)).toBe(0.9);
    expect(fitBoards(boards, { width: 430, height: 700 }, 0.25)).toBe(0.5); // wrapped: 654 px high
    expect(fitBoards(boards, { width: 484, height: 700 }, 0.5)).toBe(0.55);
    expect(fitBoards(boards, { width: 2000, height: 2000 }, 0.5)).toBe(1);
    expect(fitBoards(boards, { width: 100, height: 100 }, 0.5)).toBe(0.5);
    expect(fitBoards(boards, { width: 0, height: 0 }, 0.5)).toBeNull();
    expect(fitBoards([], { width: 400, height: 400 }, 0.5)).toBeNull();
  });
});

describe('canvas rows (report 40)', () => {
  const none = () => ({ format: '', n: null });
  const ids = (lines: Array<Array<{ boards: Array<{ id: string }> }>>) => lines.map((l) => l.map((it) => it.boards.map((b) => b.id).join('+')));
  const pack = [...Array.from({ length: 8 }, (_, i) => `appstore-iphone-69${i ? `@${i + 1}` : ''}`), 'appstore-preview',
    ...Array.from({ length: 8 }, (_, i) => `playstore-phone-9x16${i ? `@${i + 1}` : ''}`), 'playstore-feature', 'playstore-promo-16x9'];
  const packBoards = boardsWith(pack, DEFAULT_FORMATS, [], none);
  const packGroups = canvasGroups(packBoards, new Set(pack));

  it('groups the boards as the formats column does: a store pack by store, each on lines of its own', () => {
    expect(packGroups.map((g) => [g.boards.length, g.alone])).toEqual([[9, true], [10, true]]);
    const plain = canvasGroups(boardsWith(['instagram-reel-9x16', 'instagram-post-1x1', 'tiktok-9x16', 'youtube-16x9'], DEFAULT_FORMATS, [], none), new Set());
    expect(plain.map((g) => g.boards.map((b) => b.id))).toEqual([['instagram-reel-9x16', 'instagram-post-1x1'], ['tiktok-9x16'], ['youtube-16x9']]);
    expect(plain.every((g) => !g.alone)).toBe(true);
  });

  it('lays a group out as before (tall boards, then the others stacked) and lets small groups share a line', () => {
    const plain = canvasGroups(boardsWith(['instagram-reel-9x16', 'instagram-post-1x1', 'tiktok-9x16', 'youtube-16x9'], DEFAULT_FORMATS, [], none), new Set());
    expect(ids(canvasLines(plain, 1, null))).toEqual([['instagram-reel-9x16', 'instagram-post-1x1', 'tiktok-9x16', 'youtube-16x9']]);
    expect(canvasLines(plain, 1, null)[0]!.map((it) => it.stack)).toEqual([false, true, false, true]);
    // 1000 px: Instagram (304 + 40 + 344) and TikTok (304) do not fit together: TikTok starts a line, YouTube (420) joins it.
    expect(ids(canvasLines(plain, 1, 1000))).toEqual([['instagram-reel-9x16', 'instagram-post-1x1'], ['tiktok-9x16', 'youtube-16x9']]);
  });

  it('wraps a store\'s row that is too long, and never puts two stores on one line', () => {
    // 1000 px at 50%: 880 px inside the padding; tall boards ≥ 176 px (label) + 20 px gap: 4 per line.
    const lines = canvasLines(packGroups, 0.5, 1000);
    expect(lines.map((l) => l.length)).toEqual([4, 4, 1, 4, 4, 1]);
    expect(ids(lines)[2]).toEqual(['appstore-preview']);
    expect(ids(lines)[5]).toEqual(['playstore-feature+playstore-promo-16x9']);
    // Without a width (not laid out) each store is one line.
    expect(canvasLines(packGroups, 1, null).map((l) => l.length)).toEqual([9, 9]);
  });

  it('opens a store pack zoomed so that every board is in the viewport, below the usual 50% when needed', () => {
    const view = { width: 660, height: 700 };
    const z = fitBoards(packGroups, view, FIT_MIN)!;
    expect(z).toBeLessThan(0.5);
    expect(z).toBeGreaterThanOrEqual(FIT_MIN);
    const w = worldAt(packGroups, z, view.width);
    expect(w.width).toBeLessThanOrEqual(view.width);
    expect(w.height).toBeLessThanOrEqual(view.height);
    // A bigger viewport opens bigger.
    expect(fitBoards(packGroups, { width: 1400, height: 900 }, FIT_MIN)!).toBeGreaterThan(z);
  });

  it('narrows the labels only below 50%, never under 96 px', () => {
    expect(labelMin(1)).toBe(LABEL_MIN);
    expect(labelMin(0.5)).toBe(LABEL_MIN);
    expect(labelMin(0.4)).toBe(141);
    expect(labelMin(0.1)).toBe(96);
  });
});

describe('canvas world → screen', () => {
  it('maps a world point by the zoom and the pan', () => {
    expect(toScreen({ x: 86, y: 172 }, 0.5)).toEqual({ x: 43, y: 86 });
    expect(toScreen({ x: 86, y: 172 }, 2, { x: -10, y: 5 })).toEqual({ x: 162, y: 349 });
  });
});
