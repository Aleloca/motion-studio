import { describe, expect, it } from 'vitest';
import { ANIMATION_PRESETS } from '@motion-studio/shared';
import { compileAnimations, compileKenBurns, PRESET_TABLE } from '../src/animations.ts';

const ctx = { width: 1000, height: 2000, clipDuration: 4 };
const one = (a: object) => compileAnimations([a as never], ctx);

describe('presets', () => {
  it('the table covers every preset of the schema', () => {
    expect(Object.keys(PRESET_TABLE).sort()).toEqual([...ANIMATION_PRESETS].sort());
  });
  it('fadeIn and fadeOut animate opacity; fadeOut ends with the clip', () => {
    expect(one({ preset: 'fadeIn', duration: 0.5 })).toEqual([
      { property: 'opacity', keyframes: [{ opacity: '0' }, { opacity: '1' }], start: 0, duration: 0.5, easing: 'ease-out', fill: 'both' },
    ]);
    const [out] = one({ preset: 'fadeOut', duration: 1 });
    expect(out).toMatchObject({ property: 'opacity', keyframes: [{ opacity: '1' }, { opacity: '0' }], start: 3, duration: 1 });
  });
  it('slides move by a tenth of the composition from the side they come from', () => {
    expect(one({ preset: 'slideUp', duration: 1 })[0]!.keyframes).toEqual([{ '--ms-y': '200px' }, { '--ms-y': '0px' }]);
    expect(one({ preset: 'slideDown', duration: 1 })[0]!.keyframes).toEqual([{ '--ms-y': '-200px' }, { '--ms-y': '0px' }]);
    expect(one({ preset: 'slideLeft', duration: 1 })[0]!.keyframes).toEqual([{ '--ms-x': '100px' }, { '--ms-x': '0px' }]);
    expect(one({ preset: 'slideRight', duration: 1 })[0]!.keyframes).toEqual([{ '--ms-x': '-100px' }, { '--ms-x': '0px' }]);
  });
  it('popIn scales with an overshoot and fades in; scaleIn grows from 0; wipe reveals left to right', () => {
    const pop = one({ preset: 'popIn', duration: 0.6 });
    expect(pop.map((a) => a.property).sort()).toEqual(['--ms-scale', 'opacity']);
    expect(pop.find((a) => a.property === '--ms-scale')).toMatchObject({
      keyframes: [{ '--ms-scale': '0.5' }, { '--ms-scale': '1' }], easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    });
    expect(one({ preset: 'scaleIn', duration: 1 })[0]!.keyframes).toEqual([{ '--ms-scale': '0' }, { '--ms-scale': '1' }]);
    expect(one({ preset: 'wipe', duration: 1 })[0]!.keyframes).toEqual([{ clipPath: 'inset(0px 100% 0px 0px)' }, { clipPath: 'inset(0px 0% 0px 0px)' }]);
  });
  it('a start and an ease on the preset override the defaults', () => {
    expect(one({ preset: 'fadeOut', duration: 1, start: 0.5, ease: 'linear' })[0]).toMatchObject({ start: 0.5, easing: 'linear' });
    expect(one({ preset: 'popIn', duration: 1, ease: 'ease-in' }).every((a) => a.easing === 'ease-in')).toBe(true);
  });
});

describe('tweens and keyframes', () => {
  it('maps every animatable prop to its CSS value', () => {
    const cases: Array<[string, number | string, Record<string, string>]> = [
      ['opacity', 0.25, { opacity: '0.25' }], ['x', 12, { '--ms-x': '12px' }], ['y', -3, { '--ms-y': '-3px' }],
      ['scale', 1.5, { '--ms-scale': '1.5' }], ['rotation', 90, { '--ms-rotate': '90deg' }], ['color', '#ff0000', { color: '#ff0000' }],
      ['blur', 4, { '--ms-blur': '4px' }],
    ];
    for (const [prop, v, kf] of cases) {
      expect(one({ prop, from: v, to: v, duration: 1 })[0]!.keyframes).toEqual([kf, kf]);
    }
  });
  it('a tween defaults to ease-out from its start', () => {
    expect(one({ prop: 'x', from: 0, to: 50, start: 1, duration: 2 })[0]).toEqual({
      property: '--ms-x', keyframes: [{ '--ms-x': '0px' }, { '--ms-x': '50px' }], start: 1, duration: 2, easing: 'ease-out', fill: 'both',
    });
  });
  it('keyframes keep their offsets and per-segment eases, linear by default', () => {
    expect(one({ prop: 'scale', keyframes: [{ t: 0, v: 1 }, { t: 0.5, v: 2, ease: 'ease-in' }, { t: 1, v: 1 }], duration: 1 })[0]).toEqual({
      property: '--ms-scale',
      keyframes: [{ '--ms-scale': '1', offset: 0, easing: 'linear' }, { '--ms-scale': '2', offset: 0.5, easing: 'ease-in' }, { '--ms-scale': '1', offset: 1, easing: 'linear' }],
      start: 0, duration: 1, easing: 'linear', fill: 'both',
    });
  });
  it('skips a value of the wrong kind and reports it', () => {
    const problems: string[] = [];
    expect(compileAnimations([{ prop: 'color', from: 1, to: 2, duration: 1 } as never, { prop: 'x', from: '#fff', to: 1, duration: 1 } as never], ctx, (m) => problems.push(m))).toEqual([]);
    expect(problems).toHaveLength(2);
  });
});

describe('stacking several animations of one property', () => {
  it('orders by start; only the first fills backwards, so a later one never hides an earlier one', () => {
    const list = compileAnimations([
      { preset: 'fadeOut', duration: 1 } as never,
      { preset: 'slideUp', duration: 1, start: 0.5 } as never,
      { preset: 'fadeIn', duration: 0.5, start: 0.2 } as never,
    ], ctx);
    expect(list.map((a) => [a.property, a.start, a.fill])).toEqual([
      ['opacity', 0.2, 'both'], ['--ms-y', 0.5, 'both'], ['opacity', 3, 'forwards'],
    ]);
  });
});

describe('Ken Burns', () => {
  it('runs linearly over the whole clip on the media element', () => {
    expect(compileKenBurns({ from: { scale: 1 }, to: { scale: 1.25, x: -40, y: -60 } }, 3)).toEqual({
      property: 'kenBurns',
      keyframes: [{ scale: '1', translate: '0px 0px' }, { scale: '1.25', translate: '-40px -60px' }],
      start: 0, duration: 3, easing: 'linear', fill: 'both',
    });
  });
});
