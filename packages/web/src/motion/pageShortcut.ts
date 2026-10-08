import { useEffect, useRef, type RefObject } from 'react';
import { isMac } from '../shell/ShellContext.tsx';

/**
 * Whether `el` belongs to the page the user is on. PageHost keeps a leaving page mounted for its exit (with only
 * pointer-events off) and marks the current one `data-page-active`; with nested hosts every enclosing page must be
 * marked. An element outside any page host counts as active.
 */
export function isActivePage(el: Element | null): boolean {
  if (!el || !el.isConnected) return false;
  // Page hosts nest (the project tabs sit in a soft host inside a page): every enclosing page must be the current one.
  for (let page = el.closest('.ms-page'); page; page = page.parentElement?.closest('.ms-page') ?? null) {
    if (!page.hasAttribute('data-page-active')) return false;
  }
  return true;
}

/**
 * A page-level keyboard shortcut on window: runs `run` when `match(e)` holds, only while the page holding `ref` is the
 * active one, never for an auto-repeated key (a held ⌘↵) and not when something else already handled the event.
 */
export function usePageShortcut(ref: RefObject<Element | null>, match: (e: KeyboardEvent) => boolean, run: (e: KeyboardEvent) => void): void {
  const cb = useRef({ match, run });
  cb.current = { match, run };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented || !cb.current.match(e) || !isActivePage(ref.current)) return;
      e.preventDefault();
      cb.current.run(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref]);
}

/** ⌘↵ on macOS, Ctrl+↵ elsewhere (the same rule as ⌘K in App); never with Alt or while an IME is composing. */
export function isSubmitChord(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.isComposing || e.altKey) return false;
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
