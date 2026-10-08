import { useContext, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { D, E, enter, exit, stagger } from '../motion/index.ts';
import { LayerContext, focusInto, nextLayerId, pushLayer, trapTab } from './layers.ts';
import { usePresence } from './presence.ts';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start';

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  /** The source button: the popover is placed against it, ignores clicks on it and returns focus to it. */
  anchor: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  width?: number;
  children: ReactNode;
}

const GAP = 6;
const MARGIN = 8;
const ORIGIN: Record<PopoverPlacement, string> = { 'bottom-start': 'top left', 'bottom-end': 'top right', 'top-start': 'bottom left' };

/**
 * Anchored popover (spec §4.3, T5), portalled into document.body so overflow:hidden parents cannot clip it. Closes on
 * an outside pointer down and on Esc (only when it is the top layer); light focus trap; focus returns to the anchor.
 * Rows marked `data-row` cascade in 20 ms apart.
 */
export function Popover({ open, onClose, anchor, placement = 'bottom-start', width, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [id] = useState(nextLayerId);
  const parent = useContext(LayerContext);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<CSSProperties>({});

  const shown = usePresence(open, {
    enter: () => {
      const el = ref.current;
      void enter(el, { y: -4, scale: 0.96, ms: D.s, ease: E.spring });
      if (el) void stagger(el.querySelectorAll('[data-row]'), { y: -4, ms: D.s }, 20);
    },
    exit: () => exit(ref.current, { ms: D.xs }),
  });

  // Register as a layer while open. Focus goes back in the layout phase, not in the cleanup: React restores the
  // previously focused element after its mutation phase, which would undo a focus() made there.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      const active = document.activeElement;
      const inside = !active || active === document.body || !!ref.current?.contains(active);
      if (inside) anchor.current?.focus({ preventScroll: true });
      return;
    }
    wasOpen.current = true;
    const pop = pushLayer({
      id,
      parent,
      outside: true,
      contains: (n) => !!(ref.current?.contains(n) || anchor.current?.contains(n)),
      close: () => onCloseRef.current(),
    });
    focusInto(ref.current);
    return pop;
  }, [open, id, parent, anchor]);

  // Placement against the anchor, kept in the viewport, refreshed on resize and scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const w = width ?? ref.current?.offsetWidth ?? 0;
      const vw = window.innerWidth;
      let left = placement === 'bottom-end' ? r.right - w : r.left;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
      setPos(
        placement === 'top-start'
          ? { left, bottom: window.innerHeight - r.top + GAP }
          : { left, top: r.bottom + GAP },
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, placement, width]);

  if (!shown) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => { trapTab(e, ref.current); };
  return createPortal(
    <LayerContext.Provider value={id}>
      <div
        ref={ref}
        className="ms-pop"
        tabIndex={-1}
        style={{ ...pos, width, transformOrigin: ORIGIN[placement] }}
        onKeyDown={onKeyDown}
        inert={!open || undefined}
      >
        {children}
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}
