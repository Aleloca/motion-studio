import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundSwitch, soundButton } from '../src/js/sound.js';

/** A button with a label span, its classes and its click handler. */
function fakeButton({ label = true } = {}) {
  const classes = new Set(); const attrs = {}; let onClick = null;
  const span = { textContent: '' };
  return {
    classes, attrs, span, click: () => onClick(),
    querySelector: () => (label ? span : null),
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: (type, fn) => { if (type === 'click') onClick = fn; },
  };
}

test('the sound is off until asked for; listeners hear each change once', () => {
  const sw = soundSwitch();
  const heard = [];
  sw.onChange((on) => heard.push(on));
  assert.equal(sw.on, false);
  sw.set(true); sw.set(true); sw.set(false);
  assert.deepEqual(heard, [true, false]);
});

test('a sound button says what a press does, and two buttons share the one switch', () => {
  const sw = soundSwitch();
  const story = fakeButton(); const bar = fakeButton({ label: false });
  soundButton(story, sw); soundButton(bar, sw);
  assert.equal(story.span.textContent, 'Sound on');
  assert.equal(bar.attrs['aria-label'], 'Sound on');
  story.click();
  assert.equal(sw.on, true);
  assert.equal(story.span.textContent, 'Sound off');
  assert.equal(bar.attrs['aria-label'], 'Sound off');
  assert.ok(story.classes.has('is-on') && bar.classes.has('is-on'));
  bar.click();
  assert.equal(sw.on, false);
  assert.equal(sw.declined, true, 'switched off by the viewer: Play leaves it off');
});
