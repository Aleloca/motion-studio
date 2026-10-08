import { useContext, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { D, E, enter, exit } from '../motion/index.ts';
import { LayerContext, focusInto, focusReturnChain, nextLayerId, pushLayer, scrimClickCloses } from './layers.ts';
import { usePresence } from './presence.ts';

export interface ModalProps {
  open: boolean;
  onClose(): void;
  /** Accessible name of the dialog. */
  label: string;
  width?: number;
  children: ReactNode;
}

/**
 * Modal dialog over a scrim (spec §4.3, T6), portalled into document.body. Closes on a scrim click and on Esc (only
 * when it is the top layer, so a popover inside it closes first); keeps focus inside while on top (Tab and focusin,
 * via the layer manager); focus returns to the element that had it when the modal opened, or to the nearest anchor
 * still on the page when that element has gone (a menu item).
 */
export function Modal({ open, onClose, label, width = 560, children }: ModalProps) {
  const scrim = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [id] = useState(nextLayerId);
  const parent = useContext(LayerContext);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Remember the opener while rendering the opening frame: children (autoFocus, a nested popover) may move focus
  // inside before this component's effects run.
  // The opener may be a menu item that unmounts with its popover: keep the chain up to the menu's button.
  const origin = useRef<HTMLElement[]>([]);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const a = typeof document === 'undefined' ? null : document.activeElement;
    origin.current = focusReturnChain(a instanceof HTMLElement && a !== document.body ? a : null);
  }
  wasOpen.current = open;
  const giveFocusBack = () => { origin.current.find((el) => el.isConnected)?.focus({ preventScroll: true }); };

  const shown = usePresence(open, {
    enter: () => {
      void enter(scrim.current, { y: 0, ms: D.s, ease: E.std });
      void enter(dialog.current, { y: 0, scale: 0.97, ms: D.m });
    },
    exit: () =>
      Promise.all([exit(dialog.current, { ms: D.xs }), exit(scrim.current, { ms: D.xs })]).then((r) => r.every(Boolean)),
  });

  // Focus goes back in the layout phase, not in the cleanup (React re-focuses the old element after its mutations).
  const registered = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      if (!registered.current) return;
      registered.current = false;
      giveFocusBack();
      return;
    }
    registered.current = true;
    const pop = pushLayer({
      id,
      parent,
      outside: false,
      contains: (n) => !!dialog.current?.contains(n),
      close: () => onCloseRef.current(),
      trap: () => dialog.current,
    });
    focusInto(dialog.current);
    return pop;
  }, [open, id, parent]);
  // Unmounted while open (a route change): still give focus back. During a deletion the dialog's nodes are going
  // away, so React does not re-focus them afterwards.
  useLayoutEffect(() => () => { if (registered.current) giveFocusBack(); }, []);

  if (!shown) return null;
  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && scrimClickCloses(id, e.currentTarget)) onCloseRef.current();
  };
  // Portalled events still bubble through the React tree: keep clicks from reaching the modal's React ancestors.
  const stop = (e: MouseEvent) => { e.stopPropagation(); };
  return createPortal(
    <LayerContext.Provider value={id}>
      <div className="ms-modal" inert={!open || undefined} onClick={stop}>
        <div ref={scrim} className="ms-scrim" onClick={onScrimClick} />
        <div
          ref={dialog}
          className="ms-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          style={{ width }}
        >
          {children}
        </div>
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}
