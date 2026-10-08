import { createContext } from 'react';

/**
 * Layer manager: a module-level stack of the open popovers and modals, so that
 * - Esc closes only the topmost layer;
 * - an outside pointer down dismisses only the topmost popover (a modal ignores it: its scrim handles clicks);
 * - the click that follows a pointer down which dismissed a popover never also closes the modal beneath it.
 * A layer is registered while it is open (not during its exit animation).
 */
export interface Layer {
  id: number;
  /** The enclosing layer (a popover inside a modal): a parent always stays below its children. */
  parent: number | null;
  /** Popovers close on an outside pointer down; modals do not. */
  outside: boolean;
  /** True when the node belongs to this layer (its surface or its anchor). */
  contains(node: Node): boolean;
  close(): void;
}

let seq = 0;
export const nextLayerId = (): number => ++seq;

/** The id of the layer a component sits in, so nested layers know their parent. */
export const LayerContext = createContext<number | null>(null);

const stack: Layer[] = [];
/** What the last pointer down hit and which layer was on top then; cleared after the click it starts. */
let lastDown: { target: EventTarget | null; top: number | null } | null = null;

const top = (): Layer | undefined => stack[stack.length - 1];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return;
  const t = top();
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  t.close();
}

function onPointerDown(e: Event) {
  const t = top();
  lastDown = { target: e.target, top: t?.id ?? null };
  if (!t || !t.outside) return;
  if (e.target instanceof Node && t.contains(e.target)) return;
  t.close();
}

/** Runs after React's handlers (document bubble phase): the pointer sequence is over. */
function onClickDone() {
  lastDown = null;
}

function listen(on: boolean) {
  if (on) {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClickDone, false);
  } else {
    lastDown = null;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClickDone, false);
  }
}

export function pushLayer(layer: Layer): () => void {
  if (stack.length === 0) listen(true);
  // A parent registering after its children (React runs child effects first) goes below them.
  const child = stack.findIndex((l) => l.parent === layer.id);
  if (child >= 0) stack.splice(child, 0, layer);
  else stack.push(layer);
  return () => {
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) listen(false);
  };
}

export const isTopLayer = (id: number): boolean => top()?.id === id;

/**
 * Whether a click on a modal's scrim should close it: the pointer down must have hit the scrim itself while that
 * modal was on top (so a down that dismissed a popover, or a drag that started inside the dialog, does not count).
 * A click with no pointer down (synthetic or keyboard) counts when the modal is on top.
 */
export function scrimClickCloses(id: number, scrim: Element): boolean {
  const d = lastDown;
  if (!d) return isTopLayer(id);
  return d.target === scrim && d.top === id;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('inert'));
}

/** Keeps Tab / Shift+Tab cycling inside `root`. Returns true when it moved focus. */
export function trapTab(
  e: { key: string; shiftKey: boolean; defaultPrevented: boolean; preventDefault(): void },
  root: Element | null,
): boolean {
  // A nested layer (portalled, but its events bubble through React) already handled it.
  if (e.key !== 'Tab' || !root || e.defaultPrevented) return false;
  const list = focusables(root);
  if (list.length === 0) {
    e.preventDefault();
    return true;
  }
  const first = list[0]!;
  const last = list[list.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/** Focuses the first focusable inside `root`, or `root` itself, unless focus is already inside. */
export function focusInto(root: HTMLElement | null) {
  if (!root) return;
  if (document.activeElement instanceof Node && root.contains(document.activeElement)) return;
  (focusables(root)[0] ?? root).focus({ preventScroll: true });
}
