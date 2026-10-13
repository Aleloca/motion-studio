import { describe, expect, it } from 'vitest';
import {
  clampZoom, clipBounds, frameRound, moveTiming, pxPerSec, pxToTime, rulerTicks, sliderToZoom, snapEdges, timeToPx, trimTiming, zoomAt, zoomToSlider,
} from '../src/screens/editor/timelineMath.ts';

describe('time and pixels', () => {
  it('fit the composition at zoom 1 and scale with the zoom', () => {
    expect(pxPerSec(600, 6, 1)).toBe(100);
    expect(pxPerSec(600, 6, 4)).toBe(400);
    expect(pxPerSec(600, 6, 50)).toBe(2000);
    expect(pxPerSec(600, 6, 0.2)).toBe(100);
    expect(pxPerSec(0, 6, 1)).toBe(0);
    expect(timeToPx(1.5, 400)).toBe(600);
    expect(pxToTime(600, 400)).toBe(1.5);
    expect(pxToTime(10, 0)).toBe(0);
    expect(clampZoom(NaN)).toBe(1);
    expect(frameRound(1.02, 30)).toBeCloseTo(1 + 1 / 30, 6);
  });
  it('the slider is logarithmic between 1x and 20x', () => {
    expect(sliderToZoom(0)).toBe(1);
    expect(sliderToZoom(100)).toBe(20);
    expect(zoomToSlider(20)).toBe(100);
    expect(zoomToSlider(sliderToZoom(37))).toBe(37);
  });
});

describe('zoom anchored at a point', () => {
  it('keeps the time under the pointer where it is', () => {
    const before = { zoom: 2, scrollLeft: 100, anchorPx: 250, viewportPx: 600, duration: 6 };
    const t = (before.scrollLeft + before.anchorPx) / pxPerSec(600, 6, 2);
    const out = zoomAt({ ...before, next: 5 });
    expect(out.zoom).toBe(5);
    expect((out.scrollLeft + before.anchorPx) / pxPerSec(600, 6, 5)).toBeCloseTo(t, 6);
  });
  it('never scrolls past the content, and back to 1x there is no scroll', () => {
    expect(zoomAt({ zoom: 20, scrollLeft: 99999, anchorPx: 0, viewportPx: 600, duration: 6, next: 20 }).scrollLeft).toBe(600 * 19);
    expect(zoomAt({ zoom: 4, scrollLeft: 300, anchorPx: 300, viewportPx: 600, duration: 6, next: 1 })).toEqual({ zoom: 1, scrollLeft: 0 });
    expect(zoomAt({ zoom: 1, scrollLeft: 0, anchorPx: 0, viewportPx: 600, duration: 6, next: 99 }).zoom).toBe(20);
  });
});

describe('snapping edges', () => {
  const targets = [0, 2, 4, 6];
  it('jumps within 8 px at the current zoom and not outside', () => {
    // 100 px/s: 8 px is 0.08 s.
    expect(snapEdges([2.07], targets, 100, true)).toEqual({ delta: expect.closeTo(-0.07, 6), snappedTo: 2 });
    expect(snapEdges([2.09], targets, 100, true)).toEqual({ delta: 0, snappedTo: null });
    // At 400 px/s the same distance is 0.02 s: 2.07 no longer snaps.
    expect(snapEdges([2.07], targets, 400, true).snappedTo).toBeNull();
    expect(snapEdges([2.01], targets, 400, true).snappedTo).toBe(2);
  });
  it('takes the closest of several edges, and does nothing when disabled', () => {
    const s = snapEdges([1.95, 3.99], targets, 100, true);
    expect(s.snappedTo).toBe(4);
    expect(s.delta).toBeCloseTo(0.01, 6);
    expect(snapEdges([2.01], targets, 100, false)).toEqual({ delta: 0, snappedTo: null });
  });
});

describe('move and trim', () => {
  const bounds = { lo: 2, hi: 4 };
  it('a move keeps the duration and stays in the bounds', () => {
    expect(moveTiming({ start: 2.2, duration: 1 }, 2.5, bounds)).toEqual({ start: 2.5, duration: 1 });
    expect(moveTiming({ start: 2.2, duration: 1 }, 9, bounds)).toEqual({ start: 3, duration: 1 });
    expect(moveTiming({ start: 2.2, duration: 1 }, -3, bounds)).toEqual({ start: 2, duration: 1 });
    // Longer than its room: pinned to the start.
    expect(moveTiming({ start: 2, duration: 3 }, 2.5, bounds)).toEqual({ start: 2, duration: 3 });
  });
  it('a trim moves one edge, keeps the other, one frame at least, inside the bounds', () => {
    expect(trimTiming({ start: 2.5, duration: 1 }, 'start', 2.8, bounds, 30)).toEqual({ start: 2.8, duration: 0.7 });
    expect(trimTiming({ start: 2.5, duration: 1 }, 'start', 0, bounds, 30)).toEqual({ start: 2, duration: 1.5 });
    expect(trimTiming({ start: 2.5, duration: 1 }, 'start', 9, bounds, 30)).toEqual({ start: 3.5 - 0.033334, duration: 0.033334 });
    expect(trimTiming({ start: 2.5, duration: 1 }, 'end', 3.2, bounds, 30)).toEqual({ start: 2.5, duration: 0.7 });
    expect(trimTiming({ start: 2.5, duration: 1 }, 'end', 9, bounds, 30)).toEqual({ start: 2.5, duration: 1.5 });
    expect(trimTiming({ start: 2.5, duration: 1 }, 'end', 0, bounds, 30)).toEqual({ start: 2.5, duration: 0.033334 });
  });
  it('the bounds are the clip scene, the composition without one, and open-ended at the end with ripple', () => {
    const c = { duration: 6, scenes: [{ id: 'a', start: 0, duration: 2 }, { id: 'b', start: 2, duration: 4 }] } as never;
    expect(clipBounds(c, { scene: 'b' } as never, false)).toEqual({ lo: 2, hi: 6 });
    expect(clipBounds(c, {} as never, false)).toEqual({ lo: 0, hi: 6 });
    expect(clipBounds(c, { scene: 'a' } as never, true).lo).toBe(0);
    expect(clipBounds(c, { scene: 'a' } as never, true).hi).toBeGreaterThan(6);
  });
});

describe('ruler', () => {
  it('labels seconds at least 72 px apart and adds frame ticks only when zoomed in', () => {
    const fit = rulerTicks(100, 30, 0, 6);
    expect(fit.step).toBe(1);
    expect(fit.major).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(fit.frames).toEqual([]);
    const far = rulerTicks(10, 30, 0, 60);
    expect(far.step).toBe(10);
    const near = rulerTicks(2000, 30, 0, 0.2);
    expect(near.step).toBe(0.1);
    expect(near.frames.length).toBeGreaterThan(0);
    expect(near.frames).not.toContain(0);
  });
  it('lists only the visible range', () => {
    expect(rulerTicks(100, 30, 3.2, 5).major).toEqual([3, 4, 5]);
  });
});
