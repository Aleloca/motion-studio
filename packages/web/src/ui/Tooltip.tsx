import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { D, enter } from '../motion/index.ts';

export interface TooltipProps {
  /** The tooltip text (the same words as the trigger's `aria-label`, which stays its accessible name). */
  label: string;
  /**
   * CSS selector of a descendant that carries the visible text. When given, the tooltip only shows while that
   * descendant is not rendered (the button has folded to an icon): a button that still shows its word needs no hint.
   */
  whenHidden?: string;
  /** The one trigger element: a button or anything focusable. Its own handlers keep working. */
  children: ReactElement<Record<string, unknown>>;
}

const GAP = 6;
const MARGIN = 8;

/** Whether the keyboard focus ring would show: keyboard focus yes, the focus a mouse click leaves behind no. */
function focusVisible(el: HTMLElement): boolean {
  try { return el.matches(':focus-visible'); } catch { return true; }
}

function folded(el: HTMLElement, sel: string | undefined): boolean {
  if (!sel) return true;
  const t = el.querySelector<HTMLElement>(sel);
  return !t || getComputedStyle(t).display === 'none';
}

/**
 * Hint for an icon-only control (decision 703 update). Shows on hover and on keyboard focus, hides on blur, mouse leave
 * and Esc (without consuming the Esc: a dialog or the range band under it still gets it). While shown the trigger is
 * `aria-describedby` the `role="tooltip"` bubble; the bubble is portalled into document.body and fixed-positioned, so no
 * `overflow: hidden` bar clips it, and it is out of layout (never counted as overflow). Not rendered while hidden.
 */
export function Tooltip({ label, whenHidden, children }: TooltipProps) {
  const id = useId();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const tip = useRef<HTMLDivElement>(null);
  const props = children.props;

  const show = useCallback((t: HTMLElement) => { if (folded(t, whenHidden)) setEl(t); }, [whenHidden]);
  const hide = useCallback(() => setEl(null), []);

  useEffect(() => {
    if (!el) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [el, hide]);

  // The trigger going away (or turning disabled) while the hint is up must not leave it behind.
  useEffect(() => { if (el && !el.isConnected) hide(); });

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
  const trigger = cloneElement(children, {
    'aria-describedby': el ? [props['aria-describedby'], id].filter(Boolean).join(' ') : props['aria-describedby'],
    onMouseEnter: on(props.onMouseEnter, (e: MouseEvent<HTMLElement>) => show(e.currentTarget)),
    onMouseLeave: on(props.onMouseLeave, hide),
    onFocus: on(props.onFocus, (e: FocusEvent<HTMLElement>) => { if (focusVisible(e.currentTarget)) show(e.currentTarget); }),
    onBlur: on(props.onBlur, hide),
  });
  return (
    <>
      {trigger}
      {el ? createPortal(<div ref={tip} id={id} role="tooltip" className="ms-tooltip" style={style}>{label}</div>, document.body) : null}
    </>
  );
}
