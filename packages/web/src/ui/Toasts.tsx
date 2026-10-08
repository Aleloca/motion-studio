import { useLayoutEffect, useRef, useSyncExternalStore, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { D, enter, exit } from '../motion/index.ts';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { getToasts, pauseToast, removeToast, resumeToast, subscribeToasts, toast, type ToastItem } from './toast.tsx';

/**
 * Toast stack at the top centre (spec §4.3, T7), portalled into document.body. Mount once, in the shell. The stack is a
 * single persistent polite live region, so screen readers announce toasts added to it.
 */
export function Toasts() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return createPortal(
    <div className="ms-toasts" role="status" aria-live="polite">
      {items.map((t) => <Toast key={t.id} t={t} />)}
    </div>,
    document.body,
  );
}

function Toast({ t }: { t: ToastItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef({ pointer: false, focus: false });
  useLayoutEffect(() => { void enter(ref.current, { y: -16, ms: D.m }); }, []);
  useLayoutEffect(() => {
    if (!t.leaving) return;
    void exit(ref.current, { y: -8, ms: D.s }).then((finished) => { if (finished) removeToast(t.id); });
  }, [t.leaving, t.id]);

  // Hovering or focusing a toast holds its auto-dismiss, so its action can be reached (also by keyboard).
  const hold = (k: 'pointer' | 'focus', on: boolean) => {
    if (held.current[k] === on) return;
    held.current[k] = on;
    if (on) pauseToast(t.id);
    else resumeToast(t.id);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) hold('focus', false);
  };
  const act = () => {
    try {
      t.action!.run();
    } catch (err) {
      console.error(err);
    } finally {
      toast.dismiss(t.id);
    }
  };

  return (
    <div
      ref={ref}
      className="ms-toast"
      aria-hidden={t.leaving || undefined}
      onPointerEnter={() => hold('pointer', true)}
      onPointerLeave={() => hold('pointer', false)}
      onFocus={() => hold('focus', true)}
      onBlur={onBlur}
    >
      {t.tone === 'ok' ? (
        <span className="ms-toast-ok"><Icon name="check" size={14} strokeWidth={2} /></span>
      ) : (
        <span className="ms-dot ms-toast-dot" />
      )}
      <span className="ms-toast-text">{t.text}</span>
      {t.action ? (
        <Button variant="accent" size="sm" disabled={t.leaving} onClick={act}>
          {t.action.label}
        </Button>
      ) : (
        <span className="ms-toast-end" />
      )}
    </div>
  );
}
