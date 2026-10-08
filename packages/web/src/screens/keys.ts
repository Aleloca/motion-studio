// Guards of the page-level keyboard shortcuts of the creative pages (canvas, format view).

/** Keys typed into a field are text, not shortcuts. */
export const isTyping = (e: KeyboardEvent): boolean => {
  const el = e.target instanceof Element ? e.target : null;
  return Boolean(el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
};

/** A popover or modal on top owns the keyboard. */
export const inOverlay = (e: KeyboardEvent): boolean => {
  const el = e.target instanceof Element ? e.target : null;
  return Boolean(el?.closest('.ms-modal, .ms-pop'));
};

/** No modifier (Shift aside) and no IME composition. */
export const bare = (e: KeyboardEvent): boolean => !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;

/**
 * Space or Enter on a focused control activates that control: a single-key page shortcut must leave it alone.
 * `except` names the controls the shortcut itself belongs to (the player's play button and scrub bar).
 */
export const activatesControl = (e: KeyboardEvent, except?: string): boolean => {
  if (e.key !== ' ' && e.code !== 'Space' && e.key !== 'Enter') return false;
  const el = e.target instanceof Element ? e.target : null;
  const control = el?.closest('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]');
  return Boolean(control && !(except && control.closest(except)));
};
