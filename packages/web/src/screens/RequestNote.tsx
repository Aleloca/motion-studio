// A version's request note (decisions log 140, live checks of phase 9): clamped to two lines with an ellipsis. When the
// text is cut, "More" expands it in place ("Less" folds it back); the full text is also the tooltip. Inside a row that is
// itself a button (popovers), use `clampedNote` instead: a clamp and a tooltip, no nested control.
import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n.tsx';
import { Button, cx } from '../ui/index.ts';

/** True when the clamped element hides part of its text. */
const isCut = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1;

export function RequestNote({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const v = t.web.canvas.versions;
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    setOpen(false);
    const el = ref.current;
    if (!el) return;
    const measure = () => setCut(isCut(el));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span className={cx('ms-reqnote', className)}>
      <span ref={ref} className={cx('ms-reqnote-text', !open && 'ms-clamp2')} title={cut && !open ? text : undefined}>{text}</span>
      {cut || open ? (
        <Button size="sm" variant="ghost" className="ms-reqnote-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? v.noteLess : v.noteMore}
        </Button>
      ) : null}
    </span>
  );
}
