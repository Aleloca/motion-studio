import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cameraFit, framingAt, stepAt, typedAt, parseSteps, inSteps, scrollToTime, PACE } from '../src/js/story-logic.js';
import { formatTime } from '../src/js/final-cut.js';
import { SIGNAL, TEXT, titleSize, BRAND } from '../scripts/hero-gen/story.mjs';
import { SITE } from './helpers.mjs';

test('the camera fits a world rectangle in the canvas minus its insets, centred', () => {
  const f = cameraFit([100, 50, 400, 200], { w: 1000, h: 700 }, { top: 100, right: 0, bottom: 0, left: 0 });
  assert.equal(f.s, 2.5); // 1000 / 400 (height allows 600 / 200 = 3)
  assert.equal(f.tx, -250);
  // 600 px of height for 500 px of content: 50 px above and below, under the 100 px inset.
  assert.equal(f.ty, 100 + 50 - 125);
  const g = cameraFit([0, 0, 100, 100], { w: 300, h: 200 }, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(g, { s: 2, tx: 50, ty: 0 });
});

test('between two framings the camera moves in proportion, and holds past the ends', () => {
  const list = [[0, 0, 100, 100], [100, 0, 300, 100], [0, 0, 10, 10]];
  assert.deepEqual(framingAt(list, 0), [0, 0, 100, 100]);
  assert.deepEqual(framingAt(list, 0.5), [50, 0, 200, 100]);
  assert.deepEqual(framingAt(list, 1), [100, 0, 300, 100]);
  assert.deepEqual(framingAt(list, 2.7), [0, 0, 10, 10]);
  assert.deepEqual(framingAt(list, -1), [0, 0, 100, 100]);
});

test('step n runs from n - 1 to n on the timeline; the last one holds', () => {
  assert.equal(stepAt(0, 10), 1);
  assert.equal(stepAt(0.99, 10), 1);
  assert.equal(stepAt(1, 10), 2);
  assert.equal(stepAt(9.5, 10), 10);
  assert.equal(stepAt(10.4, 10), 10);
});

test('the composer types the next request at the end of a step, once its finished state has held, and empties when it is sent', () => {
  const requests = ['Brief', null, 'Make the title bigger, more energy.', 'x'];
  assert.equal(typedAt(0.9, requests), '', 'step 2 is a click: nothing to type');
  assert.equal(typedAt(1.5, requests), '', 'not while the step plays its change');
  assert.equal(typedAt(1.78, requests), '', 'not while the finished state holds');
  assert.equal(typedAt(1.98, requests), 'Make the title bigger, more energy.');
  const half = typedAt(1.885, requests);
  assert.ok(half.length > 5 && half.length < 30, half);
  assert.equal(typedAt(2, requests), '', 'sent at the start of step 3');
});

test('the scroll paces each step: its change, then a long hold on the finished state, then the next request', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.equal(scrollToTime(0, 11), 0);
  assert.ok(near(scrollToTime(3.45, 11), 3 + PACE.ACT), 'the change ends at 45% of the scroll');
  // 40% of the step's scroll moves the timeline only from 0.75 to 0.8 of the step, where nothing moves or types.
  assert.ok(near(scrollToTime(3.85, 11), 3 + PACE.TYPE));
  assert.ok(scrollToTime(3.85, 11) - scrollToTime(3.45, 11) <= 0.05 + 1e-9);
  assert.equal(typedAt(scrollToTime(3.84, 11), [null, null, null, null, 'Use our brand']), '');
  assert.ok(near(scrollToTime(4, 11), 4), 'the next step starts as its request is sent');
  for (let p = 0; p < 11.6; p += 0.01) assert.ok(scrollToTime(p + 0.01, 11) >= scrollToTime(p, 11), `monotonic at ${p}`);
  assert.ok(near(scrollToTime(11.3, 11), 11.3), 'past the last step it holds');
});

test('step ranges', () => {
  assert.deepEqual(parseSteps('1-2'), [[1, 2]]);
  assert.deepEqual(parseSteps('4'), [[4, 4]]);
  assert.deepEqual(parseSteps('3-4 8'), [[3, 4], [8, 8]]);
  assert.ok(inSteps(parseSteps('3-4 8'), 8));
  assert.ok(!inSteps(parseSteps('3-4 8'), 5));
});

test('the final cut shows minutes and seconds', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(59.9), '00:59');
  assert.equal(formatTime(61), '01:01');
});

test('what the chat says is what the boards are', () => {
  const html = readFileSync(join(SITE, 'src', 'index.html'), 'utf8');
  // "40% larger": v2's title against v1's.
  assert.match(html, /40% larger/);
  assert.equal(SIGNAL.v2.size / SIGNAL.v1.size, 1.4);
  // "every line fits its box at the same size": every translation keeps the 16:9's title size.
  assert.match(html, /every line fits its box at the same size/);
  for (const lang of Object.keys(TEXT)) assert.equal(titleSize('16x9', lang), BRAND['16x9'].title.size, lang);
  // "your edits stay": the branded 16:9 keeps v3's hand-made position.
  assert.match(html, /your edits stay/);
  assert.equal(BRAND['16x9'].title.x, SIGNAL.v3.x);
  assert.equal(BRAND['16x9'].title.y1, SIGNAL.v3.y1);
  // The inspector's numbers are v2's and v3's title.
  for (const [field, from, to] of [['X', SIGNAL.v2.x, SIGNAL.v3.x], ['Y', SIGNAL.v2.y1, SIGNAL.v3.y1], ['Size', SIGNAL.v2.size, SIGNAL.v3.size]]) {
    assert.match(html, new RegExp(`<dt>${field}</dt><dd data-from="${from}" data-to="${to}">${from}</dd>`), field);
  }
});

test('the subtitled board draws the lines the subtitles panel lists, at the same times', () => {
  const set = JSON.parse(readFileSync(join(SITE, 'compositions', 'story-subs', 'subtitles.json'), 'utf8'));
  const html = readFileSync(join(SITE, 'src', 'index.html'), 'utf8');
  const items = [...html.matchAll(/<li data-start="([\d.]+)" data-end="([\d.]+)"><span class="lines__t">[^<]+<\/span>([^<]+)<\/li>/g)];
  assert.equal(items.length, set.cues.length);
  items.forEach(([, start, end, text], i) => {
    assert.equal(text, set.cues[i].text);
    assert.equal(Number(start) * 1000, set.cues[i].start);
    assert.equal(Number(end) * 1000, set.cues[i].end);
  });
});
