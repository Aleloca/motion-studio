// Deferred removal with Undo (T15) for things the API cannot restore exactly once deleted (a brand source keeps its
// id and analysis date only if it is never deleted). The item leaves the screen at once; the delete is sent when the
// Undo toast has had its time, or when the page is being closed. Undo before that simply brings the item back.
import { toast, TOAST_MS } from '../ui/index.ts';

export interface DeferredRemoval {
  /** Toast text, e.g. "acme.example removed". */
  text: string;
  undoLabel: string;
  /** Sends the delete. Errors are reported through `onError` and the item is restored. */
  commit(): Promise<unknown>;
  /** Puts the item back on screen (Undo, or a failed commit). */
  restore(): void;
  onError?(e: unknown): void;
  /** Time before the delete is sent; the toast's own time by default. */
  ms?: number;
}

const pending = new Set<() => void>();
let listening = false;
function flushAll() { for (const run of [...pending]) run(); }

/** Hides-then-deletes: returns a function that commits at once (used when the same item is removed again). */
export function deferRemoval(o: DeferredRemoval): () => void {
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(commit);
    o.commit().catch((e: unknown) => { o.restore(); o.onError?.(e); });
  };
  const ms = o.ms ?? TOAST_MS;
  // A little after the toast's own time, so the Undo button is never shown for a delete already sent.
  const timer = setTimeout(commit, ms + 400);
  pending.add(commit);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('pagehide', flushAll);
  }
  const id = toast.show(o.text, {
    ms,
    action: {
      label: o.undoLabel,
      run: () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(commit);
        toast.dismiss(id);
        o.restore();
      },
    },
  });
  return commit;
}

/** Test-only: sends every pending delete now. */
export const __flushDeferred = flushAll;
