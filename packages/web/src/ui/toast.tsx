// Toast store (spec §4.3, §7: a small module store for toasts). <Toasts /> renders it.

export type ToastTone = 'ok' | 'neutral';
export interface ToastAction { label: string; run(): void }
export interface ToastOptions { tone?: ToastTone; action?: ToastAction; ms?: number }
export interface ToastItem { id: number; text: string; tone: ToastTone; action?: ToastAction; leaving: boolean }

/** Visible toasts at most; a newer one pushes the oldest out. */
export const TOAST_MAX = 3;
/** Default time on screen, as in the prototype. */
export const TOAST_MS = 3200;
/** Hard bound including toasts still animating out (or never removed because <Toasts /> is not mounted). */
const KEEP = TOAST_MAX * 2;

let seq = 0;
let items: ToastItem[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const emit = (next: ToastItem[]) => {
  items = next;
  for (const l of listeners) l();
};

export function subscribeToasts(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const getToasts = (): ToastItem[] => items;

/** Drops a toast for good, once its exit animation finished (called by <Toasts />). */
export function removeToast(id: number) {
  if (items.some((t) => t.id === id)) emit(items.filter((t) => t.id !== id));
}

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  if (!items.some((t) => t.id === id && !t.leaving)) return;
  // Without a mounted <Toasts /> nobody animates it out: remove it at once.
  if (listeners.size === 0) emit(items.filter((t) => t.id !== id));
  else emit(items.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
}

function show(text: string, o: ToastOptions = {}): number {
  const id = ++seq;
  let next = [...items, { id, text, tone: o.tone ?? 'neutral', action: o.action, leaving: false }];
  const over = next.filter((t) => !t.leaving).length - TOAST_MAX;
  const oldest = next.filter((t) => !t.leaving).slice(0, Math.max(0, over)).map((t) => t.id);
  next = next.map((t) => (oldest.includes(t.id) ? { ...t, leaving: true } : t));
  for (const old of oldest) {
    clearTimeout(timers.get(old));
    timers.delete(old);
  }
  while (next.length > KEEP) {
    const i = next.findIndex((t) => t.leaving);
    next.splice(i >= 0 ? i : 0, 1);
  }
  emit(next);
  timers.set(id, setTimeout(() => dismiss(id), o.ms ?? TOAST_MS));
  return id;
}

export const toast = { show, dismiss };

/** Test-only: clear every toast and timer. */
export function __resetToasts() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  items = [];
  for (const l of listeners) l();
}
