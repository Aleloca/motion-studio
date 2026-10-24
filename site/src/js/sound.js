// The page's one sound switch: off by default (a page should not speak unasked, and browsers allow sound only after a
// gesture). The story's button and the final cut's turn it on and off; Play on the final cut turns it on, unless the
// viewer has switched it off.
export function soundSwitch() {
  let on = false;
  const fns = new Set();
  return {
    get on() { return on; },
    /** The viewer switched the sound off at least once: Play leaves it off. */
    declined: false,
    set(v, { byViewer = false } = {}) {
      if (byViewer && !v) this.declined = true;
      if (v === on) return;
      on = v;
      for (const fn of fns) fn(on);
    },
    onChange(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
}

/**
 * A sound button: its label says what a press does ("Sound on" while silent, "Sound off" while it speaks), on its text or,
 * for an icon button, its aria-label; `.is-on` while the sound is on.
 */
export function soundButton(btn, sw) {
  const label = btn.querySelector('.sound-btn__label');
  const paint = () => {
    const text = sw.on ? 'Sound off' : 'Sound on';
    btn.classList.toggle('is-on', sw.on);
    if (label) label.textContent = text; else btn.setAttribute('aria-label', text);
  };
  btn.addEventListener('click', () => sw.set(!sw.on, { byViewer: true }));
  sw.onChange(paint);
  paint();
}
