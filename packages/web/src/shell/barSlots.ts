// Slots of the creative bar (spec §6.1): the bar lives in the shell, outside the page host, but the title, the state,
// the version menu and Export belong to the creative page. The bar renders two empty slots; the page that owns the
// current route portals its controls into them. A page that is leaving (still mounted for its exit) never claims them.
import { useLayoutEffect, useSyncExternalStore } from 'react';

export interface BarSlots {
  /** After the breadcrumb: the creative's title and state. */
  title: HTMLElement | null;
  /** Before the bell: version menu and Export. */
  end: HTMLElement | null;
  /** Route key of the page whose controls fill the slots; the bar hides its own title crumb for it. */
  owner: string | null;
}

let slots: BarSlots = { title: null, end: null, owner: null };
const listeners = new Set<() => void>();
const emit = (next: Partial<BarSlots>) => {
  slots = { ...slots, ...next };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const get = () => slots;

/** Called by the bar's slot elements (ref callbacks). */
export function setBarSlot(name: 'title' | 'end', el: HTMLElement | null): void {
  if (slots[name] !== el) emit({ [name]: el });
}

export function useBarSlots(): BarSlots {
  return useSyncExternalStore(subscribe, get, get);
}

/** The slots while `active` (the page is the current route's), claimed for `key`; null otherwise. */
export function useBarClaim(key: string, active: boolean): BarSlots | null {
  const s = useBarSlots();
  useLayoutEffect(() => {
    if (!active) return;
    emit({ owner: key });
    return () => { if (slots.owner === key) emit({ owner: null }); };
  }, [key, active]);
  return active && s.owner === key ? s : null;
}
