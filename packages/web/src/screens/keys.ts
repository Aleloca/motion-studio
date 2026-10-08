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
