import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type Ref, type FocusEvent, type MouseEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { D, enter } from '../motion/index.ts';

export interface TooltipProps {
  /**
   * The tooltip text. It starts with, or equals, the trigger's accessible name (`aria-label`, which stays the name); a
   * longer hint may follow it ("Duplicate · copies this format").
   */
  label: string;
  /**
   * CSS selector of a descendant that carries the visible text. When given, the tooltip only shows while that
   * descendant is not rendered (the button has folded to an icon): a button that still shows its word needs no hint,
   * unless `label` says more than the trigger's `aria-label` (a hint after the name), which shows in every layout.
   */
  whenHidden?: string;
  /** The one trigger element: a button or anything focusable. Its own handlers keep working. */
  children: ReactElement<Record<string, unknown>>;
}

const GRACE_MS = 150;
const GAP = 6;
const MARGIN = 8;

/** Whether the keyboard focus ring would show: keyboard focus yes, the focus a mouse click leaves behind no. */
function focusVisible(el: HTMLElement): boolean {
  try { return el.matches(':focus-visible'); } catch { return true; }
}

function isFolded(el: HTMLElement, sel: string | undefined): boolean {
  if (!sel) return true;
  const t = el.querySelector<HTMLElement>(sel);
  return !t || getComputedStyle(t).display === 'none';
}

/**
 * Hint for an icon-only control (decisions 703, 795, 798). Two parts, both portalled into document.body:
 * - a static, visually hidden `role="tooltip"` description (`.ms-sr`), always mounted while the hint applies (folded, or
 *   `label` says more than `aria-label`) and wired with `aria-describedby` only when `label` differs from the trigger's
 *   `aria-label` (the name is never announced twice);
 * - the visible bubble, `aria-hidden`, fixed-positioned (no `overflow: hidden` bar clips it, never counted as layout
 *   overflow): shows on hover and on keyboard focus (`:focus-visible` only), hides on blur, Esc (not consumed: a dialog
 *   or the range band under it still gets it), scroll and resize; leaving the trigger or the bubble hides it after a
 *   150 ms grace so the pointer can travel onto it (WCAG 1.4.13 hoverable). Hidden while the trigger is
 *   `aria-expanded="true"` (its popover sits under the bubble's z-index).
 * A disabled or loading trigger gets no mouse events, so while the hint applies it carries `label` as a native `title`.
 */
export function Tooltip({ label, whenHidden, children }: TooltipProps) {
  const id = useId();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const tip = useRef<HTMLDivElement>(null);
  const props = children.props;

  const hide = useCallback(() => setEl(null), []);
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelGrace = useCallback(() => { if (grace.current) { clearTimeout(grace.current); grace.current = null; } }, []);
  /** Pointer left the trigger or the bubble: a short grace lets it travel from one to the other (WCAG 1.4.13 hoverable). */
  const hideSoon = useCallback(() => { cancelGrace(); grace.current = setTimeout(() => { grace.current = null; setEl(null); }, GRACE_MS); }, [cancelGrace]);
  const hideNow = useCallback(() => { cancelGrace(); setEl(null); }, [cancelGrace]);
  useEffect(() => cancelGrace, [cancelGrace]);
  const name = typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined;
  /** The label carries more than the accessible name (a hint after it): shown even while the visible text is there. */
  const extra = name !== undefined && label !== name;
  const expanded = props['aria-expanded'] === true || props['aria-expanded'] === 'true';
  const show = useCallback((t: HTMLElement) => {
    if (t.getAttribute('aria-expanded') === 'true') return;
    if (extra || isFolded(t, whenHidden)) { cancelGrace(); setEl(t); }
  }, [whenHidden, cancelGrace, extra]);

  // The always-mounted, visually hidden description is the announced text. It lives in document.body, not beside the
  // trigger, so it never disturbs sibling selectors; the trigger is found through a ref composed with the child's own.
  const [trig, setTrig] = useState<HTMLElement | null>(null);
  const childRef = props.ref as Ref<HTMLElement> | undefined;
  const setRef = useCallback((n: HTMLElement | null) => {
    setTrig(n);
    if (typeof childRef === 'function') childRef(n);
    else if (childRef) (childRef as MutableRefObject<HTMLElement | null>).current = n;
  }, [childRef]);
  const [folded, setFolded] = useState(!whenHidden);
  useLayoutEffect(() => {
    if (!trig || !whenHidden) { setFolded(true); return; }
    const check = () => {
      const f = isFolded(trig, whenHidden);
      setFolded(f);
      if (!f && !extra) hideNow();
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(trig);
    return () => ro.disconnect();
  }, [trig, whenHidden, hideNow, extra]);

  // An open popover of the trigger sits under the bubble (z 70 vs 75): the bubble goes while it is open.
  useEffect(() => { if (expanded) hideNow(); }, [expanded, hideNow]);

  useEffect(() => {
    if (!el) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hideNow(); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hideNow, true);
    window.addEventListener('resize', hideNow);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hideNow, true);
      window.removeEventListener('resize', hideNow);
    };
  }, [el, hideNow]);

  // The trigger going away (or turning disabled) while the hint is up must not leave it behind.
  useEffect(() => { if (el && !el.isConnected) hideNow(); });

  useLayoutEffect(() => {
    const t = tip.current;
    if (!el || !t) return;
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - MARGIN));
    const above = r.top - GAP - h >= MARGIN;
    setStyle({ left, top: above ? r.top - GAP - h : r.bottom + GAP });
    void enter(t, { y: above ? 3 : -3, ms: D.xs });
  }, [el, label]);

  const on = <E,>(own: unknown, fn: (e: E) => void) => (e: E) => {
    if (typeof own === 'function') (own as (e: E) => void)(e);
    fn(e);
  };
  const applies = folded || extra;
  const describe = applies && label !== name;
  const trigger = cloneElement(children, {
    ref: setRef,
    'aria-describedby': describe ? [props['aria-describedby'], id].filter(Boolean).join(' ') : props['aria-describedby'],
    title: (props.disabled || props.loading) && applies ? label : props.title,
    onMouseEnter: on(props.onMouseEnter, (e: MouseEvent<HTMLElement>) => show(e.currentTarget)),
    onMouseLeave: on(props.onMouseLeave, hideSoon),
    onFocus: on(props.onFocus, (e: FocusEvent<HTMLElement>) => { if (focusVisible(e.currentTarget)) show(e.currentTarget); }),
    onBlur: on(props.onBlur, hideNow),
  });
  return (
    <>
      {trigger}
      {describe ? createPortal(<span id={id} role="tooltip" className="ms-sr">{label}</span>, document.body) : null}
      {el ? createPortal(<div ref={tip} className="ms-tooltip" aria-hidden="true" style={style} onMouseEnter={cancelGrace} onMouseLeave={hideSoon}>{label}</div>, document.body) : null}
    </>
  );
}
