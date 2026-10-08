// Motion system: the only place animations are created. Durations/curves match spec §5 and theme.css.
export const D = { xs: 120, s: 200, m: 320, l: 480 } as const;
export const E = {
  std: 'cubic-bezier(.2,0,0,1)',
  out: 'cubic-bezier(.16,1,.3,1)',
  in: 'cubic-bezier(.4,0,1,1)',
  spring: 'cubic-bezier(.34,1.56,.64,1)',
} as const;

/** Evaluated on every call so the OS setting can change at runtime. */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** true = ran to completion, false = cancelled (e.g. by a later enter). */
const done = (a: Animation): Promise<boolean> =>
  a.finished.then(
    () => true,
    () => false,
  );

/** Resolves true when finished, false when cancelled; true at once under reduced motion or without an element. */
export function anim(
  el: Element | null,
  frames: Keyframe[],
  ms: number = D.m,
  ease: string = E.out,
  delay = 0,
): Promise<boolean> {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return Promise.resolve(true);
  return done(el.animate(frames, { duration: ms, easing: ease, delay, fill: 'backwards' }));
}

export interface EnterOptions {
  x?: number;
  y?: number;
  scale?: number;
  delay?: number;
  ms?: number;
  /** Curve; defaults to `out`. Popovers use `spring` (T5), the modal scrim `std` (T6). */
  ease?: string;
}

export function enter(el: Element | null, o: EnterOptions = {}): Promise<void> {
  if (!el) return Promise.resolve();
  const { x = 0, y = 8, scale = 1, delay = 0, ms = D.m, ease = E.out } = o;
  // A new entrance must win over any lingering exit (fill: forwards) on the same element.
  if (typeof el.getAnimations === 'function') el.getAnimations().forEach((a) => a.cancel());
  return anim(
    el,
    [{ opacity: 0, transform: `translate(${x}px,${y}px) scale(${scale})` }, { opacity: 1, transform: 'none' }],
    ms,
    ease,
    delay,
  ).then(() => undefined);
}

/**
 * Exit, 200 ms (D.s) with the "in" curve, shorter than the 320 ms entrance (T1 as spec'd). The end state is held
 * (fill: forwards) until the caller removes the element.
 * Resolves true when finished and false when cancelled (an enter revived the element): only remove on true.
 * Under reduced motion it resolves true immediately.
 */
export function exit(el: Element | null, o: { x?: number; y?: number; ms?: number } = {}): Promise<boolean> {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return Promise.resolve(true);
  const { x = 0, y = 0, ms = D.s } = o;
  return done(
    el.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate(${x}px,${y}px)` }],
      { duration: ms, easing: E.in, fill: 'forwards' },
    ),
  );
}

/**
 * Removal (T15): height, vertical padding/margins and opacity go to zero (m, in). The element should clip its
 * overflow. Like `exit`, the end state is held and it resolves true when finished, false when cancelled (an `enter`
 * on the same element revives it): only remove the element on true.
 */
export function collapse(el: Element | null, ms: number = D.m): Promise<boolean> {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return Promise.resolve(true);
  const h = (el as HTMLElement).offsetHeight;
  return done(
    el.animate(
      [
        { height: `${h}px`, opacity: 1 },
        { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px' },
      ],
      { duration: ms, easing: E.in, fill: 'forwards' },
    ),
  );
}

/** Cascade entrance; steps of 20–40 ms per spec. */
export function stagger(els: Iterable<Element>, o: EnterOptions = {}, step = 30): Promise<void> {
  return Promise.all([...els].map((el, i) => enter(el, { ...o, delay: (o.delay ?? 0) + i * step }))).then(() => undefined);
}

export function pop(el: Element | null): Promise<void> {
  return anim(el, [{ transform: 'scale(.7)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], 520, E.spring).then(() => undefined);
}

export function pulse(el: Element | null): Promise<void> {
  return anim(
    el,
    [{ boxShadow: '0 0 0 0 rgba(255,90,31,.45)' }, { boxShadow: '0 0 0 10px rgba(255,90,31,0)' }],
    900,
    E.out,
  ).then(() => undefined);
}

export function flash(el: Element | null): Promise<void> {
  return anim(
    el,
    [
      { boxShadow: 'inset 0 0 0 1px #FF5A1F, 0 0 0 3px rgba(255,90,31,.25)' },
      { boxShadow: 'inset 0 0 0 1px transparent, 0 0 0 0 transparent' },
    ],
    800,
    E.std,
  ).then(() => undefined);
}

/** FLIP: animate `el` from a previously measured rect to its current layout. */
export function flip(el: Element | null, from: DOMRect | null, ms: number = D.l): Promise<void> {
  if (!el || !from || reducedMotion()) return Promise.resolve();
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height) return Promise.resolve();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  (el as HTMLElement).style.transformOrigin = '0 0';
  return anim(el, [{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { transform: 'none' }], ms, E.out).then(
    () => undefined,
  );
}
