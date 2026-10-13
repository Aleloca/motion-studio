import { applyEdit, type Composition } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';
import {
  aabbOf, angleOf, centreOf, cornersOf, guideLines, movePatch, resizePatch, resolveBox, rotatePatch, sizeFromBounds, snapMove, snapResize, turn, wrapAngle,
  type BoxProps, type Corner,
} from '../src/screens/editor/stageMath.ts';

const SCALES = [0.25, 0.5, 1, 2];
const ROTATIONS = [0, 37, 90, -120];
const CLIP_SCALES = [0.5, 1, 1.5];
const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw'];
const box = (rotation: number, scale: number): BoxProps => ({ x: 100, y: 200, width: 400, height: 300, rotation, scale });
const close = (a: number, b: number, digits = 2) => expect(a).toBeCloseTo(b, digits);

/** Where a point of the box is on the stage (stage px) for a player scale S. */
const onStage = (p: { x: number; y: number }, S: number) => ({ x: p.x * S, y: p.y * S });

describe('stageMath: move', () => {
  for (const S of SCALES) for (const rotation of ROTATIONS) for (const cs of CLIP_SCALES) {
    it(`moves the clip by the pointer delta (stage ${S}, rotation ${rotation}, clip scale ${cs})`, () => {
      const start = box(rotation, cs);
      const p = movePatch(start, 40, -25, S);
      const after = { ...start, ...p };
      // On the stage the centre went exactly where the pointer went.
      const before = onStage(centreOf(start), S), now = onStage(centreOf(after), S);
      close(now.x - before.x, 40, 2);
      close(now.y - before.y, -25, 2);
      // Size, rotation and scale are not touched.
      expect(p).not.toHaveProperty('width');
      expect(p).not.toHaveProperty('rotation');
    });
  }
});

describe('stageMath: resize', () => {
  for (const S of SCALES) for (const rotation of ROTATIONS) for (const cs of CLIP_SCALES) for (const corner of CORNERS) {
    it(`${corner}: the opposite corner stays, the dragged corner follows (stage ${S}, rotation ${rotation}, clip scale ${cs})`, () => {
      const start = box(rotation, cs);
      const opposite: Record<Corner, Corner> = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' };
      // A pointer movement that, in the clip's own frame, grows the box along both axes.
      const [sx, sy] = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] }[corner] as [number, number];
      const want = turn(sx * 30 * S, sy * 20 * S, rotation); // stage px
      const p = resizePatch(start, corner, want.x, want.y, S);
      const after = { ...start, ...p };
      const fixedBefore = cornersOf(start)[opposite[corner]], fixedAfter = cornersOf(after)[opposite[corner]];
      close(fixedAfter.x, fixedBefore.x, 2);
      close(fixedAfter.y, fixedBefore.y, 2);
      // The dragged corner moved by the pointer delta (in composition pixels).
      const movedBefore = cornersOf(start)[corner], movedAfter = cornersOf(after)[corner];
      close(movedAfter.x - movedBefore.x, want.x / S, 2);
      close(movedAfter.y - movedBefore.y, want.y / S, 2);
      // Rotation and scale stay, sides are in base units (the clip scale is not baked in).
      close(p.width, 400 + 30 / cs, 2);
      close(p.height, 300 + 20 / cs, 2);
    });
  }

  it('keeps the aspect ratio with Shift, from the right corner', () => {
    for (const rotation of ROTATIONS) for (const corner of CORNERS) {
      const start = box(rotation, 1.5);
      const p = resizePatch(start, corner, 55, -31, 0.5, { keepAspect: true });
      close(p.width / p.height, 400 / 300, 3);
      const opposite = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' }[corner] as Corner;
      const a = cornersOf(start)[opposite], b = cornersOf({ ...start, ...p })[opposite];
      close(a.x, b.x, 2);
      close(a.y, b.y, 2);
    }
  });

  it('never makes a side smaller than the minimum, even dragged through the other side', () => {
    for (const rotation of ROTATIONS) {
      const p = resizePatch(box(rotation, 1), 'se', -5000, -5000, 1);
      expect(p.width).toBeGreaterThanOrEqual(8);
      expect(p.height).toBeGreaterThanOrEqual(8);
      const q = resizePatch(box(rotation, 1), 'nw', 5000, 5000, 1, { keepAspect: true });
      expect(q.width).toBeGreaterThanOrEqual(8);
      expect(q.height).toBeGreaterThanOrEqual(8);
    }
  });

  it('a degenerate box (no size, no scale) comes back unchanged instead of NaN', () => {
    const p = resizePatch({ x: 1, y: 2, width: 0, height: 0, rotation: 0, scale: 1 }, 'se', 10, 10, 1);
    expect(p).toEqual({ x: 1, y: 2, width: 0, height: 0 });
    const q = resizePatch({ x: 1, y: 2, width: 10, height: 10, rotation: 0, scale: 0 }, 'se', 10, 10, 1);
    expect(Object.values(q).every(Number.isFinite)).toBe(true);
  });
});

describe('stageMath: rotate', () => {
  const centreStage = { x: 300, y: 300 };
  it('turns by the angle the pointer swept around the centre, and leaves the position alone', () => {
    for (const rotation of ROTATIONS) for (const cs of CLIP_SCALES) {
      const start = box(rotation, cs);
      // From straight above the centre to straight to its right: a quarter turn clockwise.
      const p = rotatePatch(start, centreStage, { x: 300, y: 100 }, { x: 500, y: 300 });
      expect(Object.keys(p)).toEqual(['rotation']);
      close(wrapAngle(p.rotation - rotation - 90), 0, 2);
      // The centre of the drawn box is where it was.
      const c = centreOf({ ...start, ...p });
      expect(c).toEqual(centreOf(start));
    }
  });
  it('snaps to 15 degrees with Shift', () => {
    const p = rotatePatch(box(0, 1), centreStage, { x: 300, y: 100 }, { x: 300 + 200 * Math.sin(rad(22)), y: 300 - 200 * Math.cos(rad(22)) }, { snap: true });
    expect(p.rotation).toBe(15);
    const q = rotatePatch(box(7, 1), centreStage, { x: 300, y: 100 }, { x: 300 + 200 * Math.sin(rad(25)), y: 300 - 200 * Math.cos(rad(25)) }, { snap: true });
    expect(q.rotation % 15).toBe(0);
    expect(q.rotation).toBe(30);
  });
  it('wraps into (-180, 180]', () => {
    expect(wrapAngle(190)).toBe(-170);
    expect(wrapAngle(-180)).toBe(180);
    expect(wrapAngle(540)).toBe(180);
    expect(angleOf({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(90);
  });
});

const rad = (d: number) => (d * Math.PI) / 180;

describe('stageMath: geometry helpers', () => {
  it('reads the box from the props with the runtime defaults', () => {
    expect(resolveBox(undefined, { width: 1080, height: 1920 })).toEqual({ x: 0, y: 0, width: 1080, height: 1920, rotation: 0, scale: 1 });
    expect(resolveBox({ x: 5, width: 10 }, { width: 99, height: 77 })).toEqual({ x: 5, y: 0, width: 10, height: 77, rotation: 0, scale: 1 });
  });
  it('the bounds of a turned box give its sides back (except near 45 degrees)', () => {
    for (const rotation of [0, 37, 90, -120, 200]) {
      const b = { ...box(rotation, 1.5), x: 0, y: 0 };
      const a = aabbOf(b);
      const s = sizeFromBounds(a, rotation)!;
      close(s.width, 400 * 1.5, 3);
      close(s.height, 300 * 1.5, 3);
    }
    expect(sizeFromBounds({ width: 100, height: 100 }, 45)).toBeNull();
  });
});

describe('stageMath: guides', () => {
  const lines = guideLines(1080, 1920, { top: 250, bottom: 340, left: 60, right: 120 });
  it('has the frame centre and edges and the safe area', () => {
    expect(lines.x).toEqual([0, 60, 540, 960, 1080]);
    expect(lines.y).toEqual([0, 250, 960, 1580, 1920]);
    expect(guideLines(100, 50).x).toEqual([0, 50, 100]);
  });
  it('snaps a move to the frame centre within 6 stage pixels, and not beyond', () => {
    const start = { x: 340, y: 700, width: 400, height: 300, rotation: 0, scale: 1 }; // centre x = 540
    // 3 px of stage at scale 0.5 = 6 composition pixels away from the centre line: inside the threshold.
    const near = snapMove(start, 3 * 0.5, 0, 0.5, lines);
    expect(near.guides).toContainEqual({ axis: 'x', at: 540 });
    const snapped = movePatch(start, near.dx, near.dy, 0.5);
    close(centreOf({ ...start, ...snapped }).x, 540, 3);
    // 7 px is out of reach.
    const far = snapMove(start, 7, 0, 1, lines);
    expect(far.guides.filter((g) => g.axis === 'x')).toEqual([]);
    expect(far.dx).toBe(7);
  });
  it('snaps by the drawn box (rotated: its bounds), and by the nearest of its edges and centre', () => {
    const start = { x: 0, y: 0, width: 400, height: 300, rotation: 90, scale: 1 }; // drawn: 300 wide, 400 tall around (200, 150)
    const moved = snapMove(start, -48, 0, 1, lines); // left edge of the drawn box = 50 - 48 = 2 -> 0
    expect(moved.guides).toContainEqual({ axis: 'x', at: 0 });
    const left = aabbOf({ ...start, ...movePatch(start, moved.dx, moved.dy, 1) });
    close(left.x, 0, 3);
  });
  it('snaps a resize of an unrotated box on the moving corner; a turned box does not snap', () => {
    const start = { x: 100, y: 100, width: 400, height: 300, rotation: 0, scale: 1 }; // se corner at (500, 400)
    const s = snapResize(start, 'se', 38, 0, 1, lines); // x = 538 -> 540
    expect(s.guides).toContainEqual({ axis: 'x', at: 540 });
    const p = resizePatch(start, 'se', s.dx, s.dy, 1);
    close(p.x + p.width, 540, 3);
    expect(snapResize({ ...start, rotation: 20 }, 'se', 38, 0, 1, lines).guides).toEqual([]);
  });
});

// ---- Review Focus 5: drags on the real edit pipeline ----

const spike = spikeJson as unknown as Composition;
const propsOf = (c: Composition, id: string) => (c.tracks.flatMap((t) => t.clips).find((k) => k.id === id) as unknown as { props: Record<string, number | undefined> }).props;
const boxOf = (c: Composition, id: string): BoxProps => resolveBox(propsOf(c, id), { width: 0, height: 0 });
const withClip = (rotation: number, scale: number): Composition => {
  const r = applyEdit(spike, { kind: 'clipProps', clipId: 'card', props: { rotation, scale } });
  if (!r.ok) throw new Error('setup');
  return r.composition;
};

describe('ten drags and undo (Review Focus 5)', () => {
  for (const S of SCALES) for (const rotation of ROTATIONS) for (const cs of CLIP_SCALES) {
    it(`ten moves add up with no drift, ten undos restore the exact original (stage ${S}, rotation ${rotation}, clip scale ${cs})`, () => {
      const original = withClip(rotation, cs);
      const history: Composition[] = [];
      let c = original;
      for (let i = 0; i < 10; i++) {
        const start = boxOf(c, 'card');
        const patch = movePatch(start, 13.7, -9.3, S);
        const r = applyEdit(c, { kind: 'clipProps', clipId: 'card', props: patch });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        history.push(c);
        c = r.composition;
      }
      const end = boxOf(c, 'card'), first = boxOf(original, 'card');
      // Ten times the pointer delta in composition pixels, within the rounding of the saved values.
      expect(Math.abs(end.x - (first.x + (10 * 13.7) / S))).toBeLessThan(0.006);
      expect(Math.abs(end.y - (first.y - (10 * 9.3) / S))).toBeLessThan(0.006);
      // Undo is the store's snapshots: the composition we get back is the original, value for value.
      for (let i = 9; i >= 0; i--) c = history[i]!;
      expect(c).toEqual(original);
    });

    it(`ten resizes and rotations keep the fixed corner and the centre (stage ${S}, rotation ${rotation}, clip scale ${cs})`, () => {
      let c = withClip(rotation, cs);
      const anchor = cornersOf(boxOf(c, 'card')).nw;
      for (let i = 0; i < 10; i++) {
        const start = boxOf(c, 'card');
        const v = turn(7 * S, 5 * S, start.rotation);
        const r = applyEdit(c, { kind: 'clipProps', clipId: 'card', props: resizePatch(start, 'se', v.x, v.y, S) });
        if (!r.ok) throw new Error('resize refused');
        c = r.composition;
      }
      const a = cornersOf(boxOf(c, 'card')).nw;
      // Each step rounds to a thousandth; ten steps cannot move the anchor by more than a hundredth.
      expect(Math.abs(a.x - anchor.x)).toBeLessThan(0.01);
      expect(Math.abs(a.y - anchor.y)).toBeLessThan(0.01);
      const centre = centreOf(boxOf(c, 'card'));
      for (let i = 0; i < 10; i++) {
        const start = boxOf(c, 'card');
        const r = applyEdit(c, { kind: 'clipProps', clipId: 'card', props: rotatePatch(start, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 140, y: 5 }) });
        if (!r.ok) throw new Error('rotate refused');
        c = r.composition;
      }
      expect(centreOf(boxOf(c, 'card'))).toEqual(centre);
    });
  }
});
