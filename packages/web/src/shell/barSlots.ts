// Slots of the creative bar (spec §6.1): the bar lives in the shell, outside the page host, but the title, the state,
// the version control and Export belong to the creative page (and, in the format page, the format's name). The bar renders
// two empty slots; the page that owns the current route portals its controls into them. A page that is leaving (still
// mounted for its exit) never claims them. The page also tells the bar about its creative crumb (user report 23): the
// readable title it knows and the way back it runs (the format page's T4), so the crumb is the "back" control.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/** What the page says about the bar's creative crumb. */
export interface BarCrumb {
  /** Route key of the page that said it: the bar uses it only while that page owns the slots. */
  key: string;
  /** The creative's title, as the page read it (a variant sister is not in the bar's catalog). */
  title: string | null;
  /** The variant shown, upper case ("B"), in a variant group. */
  variant: string | null;
  /** Runs instead of the plain link (a click without modifier keys): the page's own way back. */
  open: (() => void) | null;
}

export interface BarSlots {
  /** After the breadcrumb: the current item (the creative's title, or the format's name) and its state. */
  title: HTMLElement | null;
  /** Before the app's controls: the object's actions (version control, Languages, Export, "…"). */
  end: HTMLElement | null;
  /** Route key of the page whose controls fill the slots; the bar hides its own title crumb for it. */
  owner: string | null;
  crumb: BarCrumb | null;
}

let slots: BarSlots = { title: null, end: null, owner: null, crumb: null };
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

/**
 * The slots while `active` (the page is the current route's), claimed for `key`; null otherwise. `crumb`: the creative
 * crumb's title, variant and click (the latest `open` runs, so a page may pass a new function each render).
 */
export function useBarClaim(key: string, active: boolean, crumb?: { title?: string | null; variant?: string | null; open?: () => void }): BarSlots | null {
  const s = useBarSlots();
  useLayoutEffect(() => {
    if (!active) return;
    emit({ owner: key });
    return () => { if (slots.owner === key) emit({ owner: null }); };
  }, [key, active]);
  const open = useRef(crumb?.open);
  open.current = crumb?.open;
  const title = crumb?.title || null;
  const variant = crumb?.variant ?? null;
  const hasOpen = Boolean(crumb?.open);
  useLayoutEffect(() => {
    if (!active || (!title && !variant && !hasOpen)) return;
    emit({ crumb: { key, title, variant, open: hasOpen ? () => open.current?.() : null } });
    return () => { if (slots.crumb?.key === key) emit({ crumb: null }); };
  }, [key, active, title, variant, hasOpen]);
  return active && s.owner === key ? s : null;
}
