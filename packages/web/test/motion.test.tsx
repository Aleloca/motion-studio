import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D, E, anim, enter, exit, flip, reducedMotion, stagger } from '../src/motion/motion';
import { PageHost } from '../src/motion/PageHost';

interface Call { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; fake: FakeAnim }
class FakeAnim {
  cancelled = false;
  finished: Promise<unknown>;
  private res!: () => void;
  private rej!: () => void;
  constructor() { this.finished = new Promise((r, j) => { this.res = () => r(undefined); this.rej = () => j(new Error('cancelled')); }); }
  cancel() { this.cancelled = true; this.rej(); }
  finish() { this.res(); }
}

let calls: Call[];
const call = (i: number): Call => calls[i]!;
const first = <T,>(a: T[]): T => a[0]!;
let reduced = false;
const live = new Map<Element, FakeAnim[]>();

beforeEach(() => {
  calls = []; reduced = false; live.clear();
  Element.prototype.animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const fake = new FakeAnim();
    calls.push({ el: this, frames, opts, fake });
    live.set(this, [...(live.get(this) ?? []), fake]);
    return fake as unknown as Animation;
  } as never;
  Element.prototype.getAnimations = function (this: Element) {
    return (live.get(this) ?? []).filter((a) => !a.cancelled) as unknown as Animation[];
  } as never;
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('motion helpers', () => {
  it('exposes spec durations and curves', () => {
    expect(D).toEqual({ xs: 120, s: 200, m: 320, l: 480 });
    expect(E.std).toBe('cubic-bezier(.2,0,0,1)');
    expect(E.spring).toBe('cubic-bezier(.34,1.56,.64,1)');
  });

  it('enter cancels existing animations on the element first', () => {
    const el = document.createElement('div');
    void exit(el);
    const old = call(0).fake;
    void enter(el, { x: 5 });
    expect(old.cancelled).toBe(true);
    expect(calls).toHaveLength(2);
    expect(call(1).opts.fill).toBe('backwards');
  });

  it('exit holds its end state and is faster than enter', () => {
    const el = document.createElement('div');
    void exit(el); void enter(el);
    expect(call(0).opts.fill).toBe('forwards');
    expect(call(0).opts.duration).toBeLessThan(call(1).opts.duration as number);
  });

  it('stagger spaces entrances by the step', () => {
    const els = [1, 2, 3].map(() => document.createElement('div'));
    void stagger(els, { delay: 10 }, 30);
    expect(calls.map((c) => c.opts.delay)).toEqual([10, 40, 70]);
  });

  it('flip animates from the old rect and skips without one', async () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    await flip(el, null);
    expect(calls).toHaveLength(0);
    void flip(el, { left: 50, top: 20, width: 200, height: 50 } as DOMRect);
    expect(call(0).frames[0]!.transform).toBe('translate(50px,20px) scale(2,0.5)');
  });

  it('with reduced motion nothing is animated and promises resolve', async () => {
    reduced = true;
    expect(reducedMotion()).toBe(true);
    const el = document.createElement('div');
    await Promise.all([enter(el), exit(el), anim(el, []), stagger([el]), flip(el, { left: 1, top: 1, width: 1, height: 1 } as DOMRect)]);
    expect(calls).toHaveLength(0);
  });
});

describe('PageHost', () => {
  type R = { k: string; depth: number; p?: number };
  const depthOf = (r: R) => r.depth;
  const A: R = { k: 'a', depth: 1 }, B: R = { k: 'b', depth: 2 }, C: R = { k: 'c', depth: 3 };
  const ui = (route: R) => (
    <PageHost route={route} keyOf={(r) => r.k} depthOf={depthOf} render={(r) => <span data-testid={`p-${r.k}`}>{r.k}{r.p}</span>} />
  );
  const pages = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.page')];
  const settle = async () => { await act(async () => { calls.forEach((c) => c.fake.finish()); await Promise.resolve(); }); };

  it('rapid A -> B -> C leaves max 2 pages and only C active', async () => {
    const { container, rerender } = render(ui(A));
    rerender(ui(B));
    rerender(ui(C));
    expect(pages(container).length).toBeLessThanOrEqual(2);
    await settle();
    const ps = pages(container);
    expect(ps).toHaveLength(1);
    expect(first(ps).textContent).toBe('c');
    expect(first(ps).style.pointerEvents).toBe('auto');
    expect(container.querySelectorAll('[data-page-active]')).toHaveLength(1);
  });

  it('navigating back to A during a transition keeps A visible and unique', async () => {
    const { container, rerender } = render(ui(A));
    rerender(ui(B));
    rerender(ui(A));
    const exitsOnA = calls.filter((c) => c.opts.fill === 'forwards');
    await settle(); // old exit animations finish late, after A re-entered
    const ps = pages(container);
    expect(ps).toHaveLength(1);
    expect(first(ps).textContent).toBe('a');
    expect(container.querySelectorAll('[data-page-active]')).toHaveLength(1);
    // the active page has no lingering forwards-filled animation
    const active = first(ps);
    expect((live.get(active) ?? []).filter((a) => !a.cancelled && calls.find((c) => c.fake === a)?.opts.fill === 'forwards')).toHaveLength(0);
    expect(exitsOnA.length).toBeGreaterThan(0);
  });

  it('direction is +1 when depth grows and -1 when it shrinks', () => {
    const { rerender, container } = render(ui(B));
    const enterX = () => {
      const entering = calls.filter((c) => c.opts.fill === 'backwards').at(-1)!;
      return (entering.frames[0]!.transform as string).match(/translate\((-?[\d.]+)px/)![1]!;
    };
    rerender(ui(C));
    expect(Number(enterX())).toBe(24);
    rerender(ui(A));
    expect(Number(enterX())).toBe(-24);
    expect(container).toBeTruthy();
  });

  it('same key with a new route object refreshes content without animating', () => {
    const { container, rerender } = render(ui({ k: 'a', depth: 1, p: 1 }));
    const before = calls.length;
    rerender(ui({ k: 'a', depth: 1, p: 2 }));
    expect(calls).toHaveLength(before);
    expect(pages(container)).toHaveLength(1);
    expect(container.textContent).toBe('a2');
  });
});
