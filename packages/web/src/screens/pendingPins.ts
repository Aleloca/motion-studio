// Comments (pins) placed but not sent yet, per creative. A module store, not page state: the canvas and the format
// view are different pages of the same creative, and a comment placed on one must still be a chip on the other.
import type { Pin } from '@motion-studio/shared';
import { useCallback, useSyncExternalStore } from 'react';

const NONE: Pin[] = [];
const store = new Map<string, Pin[]>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const pinsKey = (project: string, creative: string) => `${project}/${creative}`;

export function usePendingPins(key: string): [Pin[], (update: (pins: Pin[]) => Pin[]) => void] {
  const pins = useSyncExternalStore(subscribe, () => store.get(key) ?? NONE, () => store.get(key) ?? NONE);
  const update = useCallback((fn: (pins: Pin[]) => Pin[]) => {
    const next = fn(store.get(key) ?? NONE);
    if (next.length) store.set(key, next); else store.delete(key);
    for (const l of listeners) l();
  }, [key]);
  return [pins, update];
}

/** Tests only. */
export function __resetPendingPins(): void {
  store.clear();
  for (const l of listeners) l();
}
