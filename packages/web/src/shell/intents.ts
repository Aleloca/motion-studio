// One-shot navigation intents between the shell and a screen (the prototype's `focusNew`): set before navigating,
// consumed by the screen that owns the target once it is on the page.
import { useEffect, useRef } from 'react';

let newProject = false;
const listeners = new Set<() => void>();

/** "New project" from the project switcher: the Projects page focuses and flashes its name field. */
export function requestNewProject(): void {
  newProject = true;
  for (const l of listeners) l();
}

/** Runs `onIntent` once per request, now if one is pending or when it arrives while mounted. */
export function useNewProjectIntent(onIntent: () => void): void {
  const cb = useRef(onIntent);
  cb.current = onIntent;
  useEffect(() => {
    const take = () => {
      if (!newProject) return;
      newProject = false;
      cb.current();
    };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, []);
}
