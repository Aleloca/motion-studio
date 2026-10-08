import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { D, enter, exit } from '../motion/index.ts';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { getToasts, removeToast, subscribeToasts, toast, type ToastItem } from './toast.tsx';

/** Toast stack at the top centre (spec §4.3, T7), portalled into document.body. Mount once, in the shell. */
export function Toasts() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return createPortal(
    <div className="ms-toasts">
      {items.map((t) => <Toast key={t.id} t={t} />)}
    </div>,
    document.body,
  );
}

function Toast({ t }: { t: ToastItem }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { y: -16, ms: D.m }); }, []);
  useLayoutEffect(() => {
    if (!t.leaving) return;
    void exit(ref.current, { y: -8, ms: D.s }).then((finished) => { if (finished) removeToast(t.id); });
  }, [t.leaving, t.id]);

  return (
    <div ref={ref} className="ms-toast" role="status" aria-hidden={t.leaving || undefined}>
      {t.tone === 'ok' ? (
        <span className="ms-toast-ok"><Icon name="check" size={14} strokeWidth={2} /></span>
      ) : (
        <span className="ms-dot ms-toast-dot" />
      )}
      <span className="ms-toast-text">{t.text}</span>
      {t.action ? (
        <Button
          variant="accent"
          size="sm"
          disabled={t.leaving}
          onClick={() => { t.action!.run(); toast.dismiss(t.id); }}
        >
          {t.action.label}
        </Button>
      ) : (
        <span className="ms-toast-end" />
      )}
    </div>
  );
}
