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

const pending = new Set<() => Promise<void>>();
let listening = false;
function flushAll() { void flushDeferred(); }

/** Sends every pending delete now and waits for them (e.g. before an analysis, so a removed source is not analyzed). */
export async function flushDeferred(): Promise<void> {
  await Promise.all([...pending].map((run) => run()));
}

/** Hides-then-deletes: returns a function that commits at once. */
export function deferRemoval(o: DeferredRemoval): () => Promise<void> {
  let done = false;
  let id = 0;
  const commit = async () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(commit);
    // The delete is going out: its Undo must not stay on screen (a toast held open by the pointer).
    toast.dismiss(id);
    try { await o.commit(); } catch (e) { o.restore(); o.onError?.(e); }
  };
  const ms = o.ms ?? TOAST_MS;
  // A little after the toast's own time; a toast held longer is dismissed when the delete goes out.
  const timer = setTimeout(() => { void commit(); }, ms + 400);
  pending.add(commit);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('pagehide', flushAll);
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
        o.restore();
      },
    },
  });
  return commit;
}

