// A drag region for the desktop window on screens without a top bar (the boot spinner, Pairing): on Windows and Linux
// the title bar is hidden, so without it the window could not be moved there. Nothing in a plain browser.
import { useTitleBarClass } from '../titleBar.ts';
import { cx } from '../ui/index.ts';

export function DragStrip() {
  const titleBar = useTitleBarClass();
  if (!titleBar) return null;
  return <div className={cx('ms-drag-strip', titleBar)} aria-hidden="true" />;
}
