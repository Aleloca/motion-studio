import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D, E, anim, enter, exit, flip, reducedMotion, stagger } from '../src/motion/motion';
import { useEnter } from '../src/motion/useEnter';
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

const origAnimate = Element.prototype.animate;
const origGetAnimations = Element.prototype.getAnimations;
const origMatchMedia = window.matchMedia;

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
afterEach(() => {
  Element.prototype.animate = origAnimate;
  Element.prototype.getAnimations = origGetAnimations;
  window.matchMedia = origMatchMedia;
});

describe('motion helpers', () => {
  it('exposes spec durations and curves', () => {
    expect(D).toEqual({ xs: 120, s: 200, m: 320, l: 480 });
    expect(E.std).toBe('cubic-bezier(.2,0,0,1)');
    expect(E.spring).toBe('cubic-bezier(.34,1.56,.64,1)');
  });

  it('enter takes an optional curve (spring for popovers), out by default', () => {
    const el = document.createElement('div');
    void enter(el, { ease: E.spring, ms: D.s });
    void enter(el);
    expect(call(0).opts.easing).toBe(E.spring);
    expect(call(0).opts.duration).toBe(D.s);
    expect(call(1).opts.easing).toBe(E.out);
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

  it('exit resolves false when cancelled by an enter, true when finished', async () => {
    const el = document.createElement('div');
    const p = exit(el);
    void enter(el);
    await expect(p).resolves.toBe(false);
    const el2 = document.createElement('div');
    const p2 = exit(el2);
    call(calls.length - 1).fake.finish();
    await expect(p2).resolves.toBe(true);
    reduced = true;
    await expect(exit(el)).resolves.toBe(true);
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
  const pages = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ms-page')];
  const settle = async () => { await act(async () => { calls.forEach((c) => c.fake.finish()); await Promise.resolve(); }); };

  it('rapid A -> B -> C leaves max 2 pages and only C active', async () => {
    const { container, rerender } = render(ui(A));
    rerender(ui(B));
    rerender(ui(C));
    const mid = pages(container);
    expect(mid).toHaveLength(2);
    expect(container.querySelectorAll('[data-page-active]')).toHaveLength(1);
    const act1 = container.querySelector<HTMLElement>('[data-page-active]')!;
    expect(act1.textContent).toBe('c');
    const leaving = mid.find((p) => p !== act1)!;
    expect(leaving.style.pointerEvents).toBe('none');
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
    const forwardsExits = calls.filter((c) => c.opts.fill === 'forwards');
    await settle(); // old exit animations finish late, after A re-entered
    const ps = pages(container);
    expect(ps).toHaveLength(1);
    expect(first(ps).textContent).toBe('a');
    expect(container.querySelectorAll('[data-page-active]')).toHaveLength(1);
    // the active page has no lingering forwards-filled animation
    const active = first(ps);
    expect((live.get(active) ?? []).filter((a) => !a.cancelled && calls.find((c) => c.fake === a)?.opts.fill === 'forwards')).toHaveLength(0);
    expect(forwardsExits.length).toBeGreaterThan(0);
  });

  it('direction is +1 when depth grows and -1 when it shrinks', () => {
    const { rerender, container } = render(ui(B));
    const enterX = () => {
      const entering = calls.filter((c) => c.opts.fill === 'backwards').at(-1)!;
      return (entering.frames[0]!.transform as string).match(/translate\((-?[\d.]+)px/)![1]!;
    };
    const exitX = () => {
      const ex = calls.filter((c) => c.opts.fill === 'forwards').at(-1)!;
      return (ex.frames[1]!.transform as string).match(/translate\((-?[\d.]+)px/)![1]!;
    };
    rerender(ui(C));
    expect(Number(enterX())).toBe(24);
    expect(Number(exitX())).toBe(-16);
    rerender(ui(A));
    expect(Number(enterX())).toBe(-24);
    expect(Number(exitX())).toBe(16);
    expect(container).toBeTruthy();
  });

  it('shared mode (T3/T4): the incoming page only fades in, the outgoing one recedes; T4 is faster', () => {
    const shared = (a: R, b: R) => ((a.k === 'b' && b.k === 'c') || (a.k === 'c' && b.k === 'b') ? 'shared' as const : undefined);
    const sui = (route: R) => <PageHost route={route} keyOf={(r) => r.k} depthOf={depthOf} modeOf={shared} render={(r) => <span>{r.k}</span>} />;
    const { rerender } = render(sui(B));
    calls = [];
    rerender(sui(C));
    const entering = calls.find((c) => c.opts.fill === 'backwards')!;
    expect(entering.frames[0]!.opacity).toBe(0);
    expect(String(entering.frames[0]!.transform ?? 'none')).not.toMatch(/translate\((?!0px,0px)/);
    const leaving = calls.find((c) => c.opts.fill === 'forwards')!;
    expect(leaving.frames[1]!.transform).toBe('scale(0.98)');
    expect(leaving.frames[1]!.opacity).toBe(0);
    expect(leaving.opts.duration).toBe(D.m);
    calls = [];
    rerender(sui(B));
    const back = calls.find((c) => c.opts.fill === 'forwards')!;
    expect(back.frames[1]!.transform).toBe('scale(0.98)');
    expect(back.opts.duration).toBeLessThan(D.m);
    // Any other pair keeps T1.
    calls = [];
    rerender(sui(A));
    const t1 = calls.find((c) => c.opts.fill === 'backwards')!;
    expect(t1.frames[0]!.transform).toMatch(/translate\(-24px/);
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

describe('useEnter', () => {
  it('animates [data-enter] children in cascade', () => {
    function Box() {
      const ref = useEnter<HTMLDivElement>([]);
      return (
        <div ref={ref}>
          <i data-enter />
          <i data-enter />
          <i data-enter data-delay="500" data-y="20" />
          <i />
        </div>
      );
    }
    render(<Box />);
    expect(calls.map((c) => c.opts.delay)).toEqual([0, 30, 500]);
    expect(call(2).frames[0]!.transform).toBe('translate(0px,20px) scale(1)');
  });
});
