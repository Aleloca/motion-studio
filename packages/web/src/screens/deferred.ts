// Deferred removal with Undo (T15) for things the API cannot restore exactly once deleted (a brand source keeps its
// id and analysis date only if it is never deleted). The item leaves the screen at once; the delete is sent when the
// Undo toast has had its time, or when the page is being closed. Undo before that simply brings the item back.
//
// Pending removals are tracked here, at module level, by key (see `removalKey`), so an item stays hidden when the
// user leaves the screen and comes back within the Undo window; screens read them through `usePendingRemovals`.
// The deletes go out with `keepalive` (see `DeferredRemoval.commit`) so a flush on pagehide/beforeunload survives the
// page being torn down.
import { useEffect, useReducer, useRef } from 'react';
import { toast, TOAST_MS } from '../ui/index.ts';

/** Options every deferred delete must pass to the API: the request must outlive a closing page. */
export const KEEPALIVE = { keepalive: true } as const;

export interface DeferredRemoval {
  /** Toast text, e.g. "acme.example removed". */
  text: string;
  undoLabel: string;
  /** The items being removed (see `removalKey`): hidden on every screen until the delete settles. */
  keys?: string[];
  /** Sends the delete (with `KEEPALIVE`). Errors are reported through `onError` and the item is restored. */
  commit(): Promise<unknown>;
  /** Puts the item back on screen (Undo, or a failed commit). */
  restore(): void;
  onError?(e: unknown): void;
  /** Time before the delete is sent; the toast's own time by default. */
  ms?: number;
}

/** A stable key for a removable item: `removalKey('asset', slug, file)`. */
export function removalKey(kind: 'asset' | 'reference' | 'brand-source', slug: string, id: string): string {
  return `${kind}\u0000${slug}\u0000${id}`;
}

export type RemovalEvent = { type: 'committed' | 'restored'; keys: string[] };

const pending = new Set<() => Promise<void>>();
const pendingKeys = new Map<string, number>();
const listeners = new Set<(e: RemovalEvent) => void>();
let listening = false;
function flushAll() { void flushDeferred(); }

function addKeys(keys: string[]) { for (const k of keys) pendingKeys.set(k, (pendingKeys.get(k) ?? 0) + 1); }
function settle(keys: string[], type: RemovalEvent['type']) {
  for (const k of keys) {
    const n = (pendingKeys.get(k) ?? 1) - 1;
    if (n > 0) pendingKeys.set(k, n); else pendingKeys.delete(k);
  }
  if (keys.length) for (const l of [...listeners]) l({ type, keys });
}

/** True while the item's delete waits for its Undo time (or is being sent). */
export function isPendingRemoval(key: string): boolean {
  return pendingKeys.has(key);
}

/** Calls `listener` when a pending removal is committed or restored (Undo, failure). Returns the unsubscribe. */
export function onRemovalSettled(listener: (e: RemovalEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Re-renders the screen when a pending removal settles, and calls `onCommitted` with the keys whose delete went out,
 * in the same task, so a screen mounted after the removal started can drop the item from its (older) listing before
 * the key stops hiding it. Returns a version that changes with every settled removal (a memo dependency for lists
 * filtered with `isPendingRemoval`).
 */
export function usePendingRemovals(onCommitted?: (keys: string[]) => void): number {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const cb = useRef(onCommitted);
  cb.current = onCommitted;
  useEffect(() => onRemovalSettled((e) => {
    if (e.type === 'committed') cb.current?.(e.keys);
    bump();
  }), []);
  return version;
}

/** Sends every pending delete now and waits for them (e.g. before an analysis, so a removed source is not analyzed). */
export async function flushDeferred(): Promise<void> {
  await Promise.all([...pending].map((run) => run()));
}

/** Hides-then-deletes: returns a function that commits at once. */
export function deferRemoval(o: DeferredRemoval): () => Promise<void> {
  let done = false;
  let id = 0;
  const keys = o.keys ?? [];
  const commit = async () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(commit);
    // The delete is going out: its Undo must not stay on screen (a toast held open by the pointer).
    toast.dismiss(id);
    try {
      await o.commit();
      settle(keys, 'committed');
    } catch (e) {
      settle(keys, 'restored');
      o.restore();
      o.onError?.(e);
    }
  };
  const ms = o.ms ?? TOAST_MS;
  // A little after the toast's own time; a toast held longer is dismissed when the delete goes out.
  const timer = setTimeout(() => { void commit(); }, ms + 400);
  pending.add(commit);
  addKeys(keys);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    // pagehide covers bfcache and mobile; beforeunload covers a desktop window closing. Both are safe to fire twice:
    // a removal commits once.
    window.addEventListener('pagehide', flushAll);
    window.addEventListener('beforeunload', flushAll);
  }
  id = toast.show(o.text, {
    ms,
    action: {
      label: o.undoLabel,
      run: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(commit);
        toast.dismiss(id);
        settle(keys, 'restored');
        o.restore();
      },
    },
  });
  return commit;
}

/** Tests only: forgets every pending removal and its keys (module state outlives a test's fake timers). */
export function __resetDeferred(): void {
  pending.clear();
  pendingKeys.clear();
  listeners.clear();
}
