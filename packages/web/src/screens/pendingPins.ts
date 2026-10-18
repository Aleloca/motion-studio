// Comments (pins) placed but not sent yet, per creative. A module store, not page state: the canvas and the format
// view are different pages of the same creative, and a comment placed on one must still be a chip on the other.
import type { Pin, VariantId } from '@motion-studio/shared';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * A pending comment and the version it was placed on. The core crops pin frames from its pin source (the version
 * resumed from, else the latest): a comment only goes out while its version is that source.
 */
export interface PendingPin { pin: Pin; version: number }

const NONE: PendingPin[] = [];
const store = new Map<string, PendingPin[]>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const pinsKey = (project: string, creative: string) => `${project}/${creative}`;

export function usePendingPins(key: string): [PendingPin[], (update: (pins: PendingPin[]) => PendingPin[]) => void] {
  const pins = useSyncExternalStore(subscribe, () => store.get(key) ?? NONE, () => store.get(key) ?? NONE);
  const update = useCallback((fn: (pins: PendingPin[]) => PendingPin[]) => {
    const next = fn(store.get(key) ?? NONE);
    if (next.length) store.set(key, next); else store.delete(key);
    for (const l of listeners) l();
  }, [key]);
  return [pins, update];
}

/** What a page's chat needs of the pending comments (see `useChatPins`). */
export interface ChatPins {
  /** This page's variant's comments (the boards' marks and their numbers). */
  stored: PendingPin[];
  setStored(update: (pins: PendingPin[]) => PendingPin[]): void;
  /** The other variants' comments, sent with the group's next message too (empty outside a group with one agent). */
  others: Pin[];
  /** Removes the comments that went out with a message (any variant's). */
  drop(sent: readonly Pin[]): void;
}

/**
 * Phase 3 of the single agent (spec §7, decision 1160): the pending comments of a page. Outside a group with one agent they
 * are the creative's own, as before. In a group with one agent the composer is the group's: the comments are kept for the
 * whole group (the host's key), each with the variant it was placed on (set here, so every page that places one stamps it).
 * A comment kept before the group had one agent has no variant: it is A's (the host's).
 */
export function useChatPins(project: string, creative: string, group: { host: string; letter: VariantId } | null): ChatPins {
  const [all, update] = usePendingPins(pinsKey(project, group ? group.host : creative));
  const letter = group?.letter ?? null;
  const mine = useCallback((p: PendingPin) => letter === null || (p.pin.variant ?? 'a') === letter, [letter]);
  const stored = useMemo(() => (letter === null ? all : all.filter(mine)), [all, letter, mine]);
  const others = useMemo(() => (letter === null ? [] : all.filter((p) => !mine(p)).map((p) => p.pin)), [all, letter, mine]);
  const setStored = useCallback((fn: (pins: PendingPin[]) => PendingPin[]) => update((ps) => {
    if (letter === null) return fn(ps);
    const own = fn(ps.filter(mine)).map((p) => (p.pin.variant === letter ? p : { ...p, pin: { ...p.pin, variant: letter } }));
    return [...ps.filter((p) => !mine(p)), ...own];
  }), [update, letter, mine]);
  const drop = useCallback((sent: readonly Pin[]) => update((ps) => ps.filter((p) => !sent.includes(p.pin))), [update]);
  return { stored, setStored, others, drop };
}

/** Tests only. */
export function __resetPendingPins(): void {
  store.clear();
  for (const l of listeners) l();
}
