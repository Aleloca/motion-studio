import { describe, expect, it } from 'vitest';
import { clipPathHasNoArea } from '../src/clip-path.ts';

const W = 200, H = 100;
const none: Array<[string, string]> = [
  ['inset 50% all sides', 'inset(50%)'],
  ['inset 100% on one side (wipe)', 'inset(0px 100% 0px 0px)'],
  ['inset 100% all sides', 'inset(100% 100% 100% 100%)'],
  ['inset crossing', 'inset(0px 60% 0px 60%)'],
  ['inset vertical px covering the rounding (h + 0.5)', 'inset(50px 0px 50.5px 0px)'],
  ['inset px and % mixed, covering the rounding', 'inset(0px 50% 0px 101px)'],
  ['circle 0px', 'circle(0px at 50% 50%)'],
  ['circle 0%', 'circle(0%)'],
  ['circle 0 unitless', 'circle(0 at 10px 10px)'],
  ['ellipse first radius 0', 'ellipse(0px 40px at 50% 50%)'],
  ['ellipse second radius 0', 'ellipse(30% 0% at 50% 50%)'],
  ['polygon point', 'polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)'],
  ['polygon vertical line', 'polygon(10px 0px, 10px 50px, 10px 100px)'],
  ['polygon horizontal line', 'polygon(0% 20%, 50% 20%, 100% 20%)'],
  ['polygon with fill rule', 'polygon(evenodd, 5px 5px, 5px 5px, 5px 5px)'],
  ['surrounding whitespace', '  inset(100%)  '],
];
const visible: Array<[string, string]> = [
  ['empty string', ''], ['none', 'none'],
  ['inset with round, zero insets', 'inset(0 0 0 0 round 10px)'],
  ['inset 10%', 'inset(10%)'],
  ['inset 49.9%', 'inset(49.9%)'],
  ['negative insets leave area', 'inset(-10px)'],
  ['negative and positive', 'inset(-50% 0px -50% 0px)'],
  ['calc', 'inset(calc(50% + 50%))'],
  ['var', 'inset(var(--x))'],
  ['path', 'path("M0 0")'],
  ['url', 'url(#clip)'],
  ['em unit', 'inset(0px 100em 0px 0px)'],
  ['em radius', 'circle(0em at 50% 50%)'],
  ['unitless non-zero', 'inset(0 100 0 0)'],
  ['circle without radius', 'circle(at 50% 50%)'],
  ['empty circle', 'circle()'],
  ['closest-side', 'circle(closest-side at 50% 50%)'],
  ['farthest-side', 'ellipse(farthest-side 0px)'],
  ['circle non-zero', 'circle(50% at 50% 50%)'],
  ['M10: px insets that meet only the rounded size (a real size up to h + 0.5 leaves a sliver)', 'inset(50px 0px 50px 0px)'],
  ['M10: sub-pixel sliver in px', 'inset(0px 0px 0px 199.6px)'],
  ['M10: px and % meeting only at the rounded size', 'inset(0px 50% 0px 100px)'],
  ['polygon on one x only at the rounded size (px vs %)', 'polygon(50% 0px, 100px 50px, 50% 100px)'],
  ['diagonal collinear polygon', 'polygon(0% 0%, 50% 50%, 100% 100%)'],
  ['polygon with area', 'polygon(0% 0%, 100% 0%, 100% 100%)'],
  ['polygon with calc', 'polygon(calc(10px) 0px, 10px 5px, 10px 9px)'],
  ['upper case', 'INSET(100%)'],
  ['odd whitespace inside', 'inset(0px\t100%\n0px 0px)'],
  ['too many inset values', 'inset(100% 100% 100% 100% 100%)'],
];

describe('clipPathHasNoArea', () => {
  it.each(none)('no area: %s', (_n, v) => expect(clipPathHasNoArea(v, W, H)).toBe(true));
  it.each(visible)('visible or unknown: %s', (_n, v) => expect(clipPathHasNoArea(v, W, H)).toBe(false));
  it('never true without a box', () => {
    expect(clipPathHasNoArea('inset(100%)', 0, 100)).toBe(false);
    expect(clipPathHasNoArea('inset(100%)', 100, 0)).toBe(false);
  });
});
