import { useEffect, useRef, type RefObject } from 'react';

/**
 * Whether `el` belongs to the page the user is on. PageHost keeps a leaving page mounted for its exit (with only
 * pointer-events off) and marks the current one `data-page-active`; an element outside any page host counts as active.
 */
export function isActivePage(el: Element | null): boolean {
  if (!el || !el.isConnected) return false;
  const page = el.closest('.ms-page');
  return !page || page.hasAttribute('data-page-active');
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

/** ⌘↵ on macOS, Ctrl+↵ elsewhere (either is accepted). */
export const isSubmitChord = (e: KeyboardEvent): boolean => e.key === 'Enter' && (e.metaKey || e.ctrlKey);
