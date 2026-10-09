import { useContext, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
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
  /** Accessible name: the popover (which receives focus when it has nothing focusable) becomes a named dialog. */
  label?: string;
  children: ReactNode;
}

const GAP = 6;
const MARGIN = 8;
/** Below this much room on the preferred side, a popover flips to the other side when that one is roomier. */
const MIN_ROOM = 160;

interface Placed { style: CSSProperties; origin: string }

/**
 * Fixed-position placement against the anchor rect: horizontally clamped to the viewport; vertically on the
 * preferred side unless the content (natural height `h`) does not fit there and the other side has more room; the
 * height is capped to the room on the chosen side.
 */
export function placePopover(r: DOMRect, placement: PopoverPlacement, w: number, h: number, vw: number, vh: number): Placed {
  let left = placement === 'bottom-end' ? r.right - w : r.left;
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
  const below = vh - r.bottom - GAP - MARGIN;
  const above = r.top - GAP - MARGIN;
  const preferBelow = placement !== 'top-start';
  const want = Math.max(h, MIN_ROOM);
  const room = preferBelow ? below : above;
  const other = preferBelow ? above : below;
  const useBelow = room < want && other > room ? !preferBelow : preferBelow;
  const x = placement === 'bottom-end' ? 'right' : 'left';
  return useBelow
    ? { style: { left, top: r.bottom + GAP, maxHeight: Math.max(0, below) }, origin: `top ${x}` }
    : { style: { left, bottom: vh - r.top + GAP, maxHeight: Math.max(0, above) }, origin: `bottom ${x}` };
}

/**
 * Anchored popover (spec §4.3, T5), portalled into document.body so overflow:hidden parents cannot clip it. Closes on
 * an outside pointer down and on Esc (only when it is the top layer); light focus trap; focus returns to the anchor.
 * Rows marked `data-row` cascade in 20 ms apart.
 */
export function Popover({ open, onClose, anchor, placement = 'bottom-start', width, label, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [id] = useState(nextLayerId);
  const parent = useContext(LayerContext);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<Placed>({ style: {}, origin: placement === 'top-start' ? 'bottom left' : 'top left' });

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
      anchor: () => anchor.current,
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
      const el = ref.current;
      setPos(placePopover(a.getBoundingClientRect(), placement, width ?? el?.offsetWidth ?? 0, el?.scrollHeight ?? 0, window.innerWidth, window.innerHeight));
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
  // Portalled events still bubble through the React tree: keep clicks from reaching the popover's React ancestors
  // (a Select inside a clickable card row).
  const onClick = (e: MouseEvent<HTMLDivElement>) => { e.stopPropagation(); };
  return createPortal(
    <LayerContext.Provider value={id}>
      <div
        ref={ref}
        className="ms-pop"
        tabIndex={-1}
        {...(label ? { role: 'dialog', 'aria-label': label } : {})}
        style={{ ...pos.style, width, transformOrigin: pos.origin }}
        onKeyDown={onKeyDown}
        onClick={onClick}
        inert={!open || undefined}
      >
        {children}
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}
