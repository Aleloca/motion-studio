import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Keeps an overlay mounted through its exit animation. `enter` runs whenever it (re)opens and must cancel any running
 * exit (motion `enter` does); `exit` resolves true when finished and false when cancelled. The overlay is unmounted
 * only after an exit that finished while still closed, so open → close → open during the exit leaves it open.
 */
export function usePresence(open: boolean, run: { enter(): void; exit(): Promise<boolean> }): boolean {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const openRef = useRef(open);
  openRef.current = open;
  const runRef = useRef(run);
  runRef.current = run;

  useLayoutEffect(() => {
    if (!shown) return;
    if (open) {
      runRef.current.enter();
      return;
    }
    let live = true;
    void runRef.current.exit().then((finished) => {
      if (finished && live && !openRef.current) setShown(false);
    });
    return () => { live = false; };
  }, [open, shown]);

  return shown || open;
}
