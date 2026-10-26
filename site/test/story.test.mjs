import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { typed, labelAt, viewChange, cuesOn, PLAY_RATIO } from '../src/js/scene-logic.js';
import { formatTime } from '../src/js/final-cut.js';
import { SIGNAL, TEXT, titleSize, BRAND } from '../scripts/hero-gen/story.mjs';
import { SITE } from './helpers.mjs';

const html = readFileSync(join(SITE, 'src', 'index.html'), 'utf8');
const section = (id) => new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';

test('a request types itself into its bubble, letter by letter, then stays whole', () => {
  assert.equal(typed('Make it bigger.', 0), '');
  assert.equal(typed('Make it bigger.', 1), 'Make it bigger.');
  assert.equal(typed('Make it bigger.', 7), 'Make it bigger.');
  assert.equal(typed('Make it bigger.', -1), '');
  const half = typed('Make it bigger.', 0.5);
  assert.ok('Make it bigger.'.startsWith(half) && half.length > 4 && half.length < 11, half);
});

test('a label shows the last state reached at a time of its scene', () => {
  const marks = [[0, 'v1'], [2.5, 'Rendering…'], [3.2, 'v2']];
  assert.equal(labelAt(marks, 0), 'v1');
  assert.equal(labelAt(marks, 2.49), 'v1');
  assert.equal(labelAt(marks, 2.5), 'Rendering…');
  assert.equal(labelAt(marks, 9), 'v2');
  assert.equal(labelAt(marks, -1), 'v1');
});

test('a demo plays from its start when it comes on screen, pauses when it leaves, and resumes if it never left entirely', () => {
  // Never seen: enough of it on screen starts it from the beginning.
  assert.deepEqual(viewChange({ playing: false, left: true }, PLAY_RATIO), { playing: true, restart: true, left: false });
  assert.deepEqual(viewChange({ playing: false, left: true }, PLAY_RATIO / 2), { playing: false, restart: false, left: true });
  // Mostly scrolled away: paused; back again without having left the screen: it goes on where it was.
  assert.deepEqual(viewChange({ playing: true, left: false }, 0.1), { playing: false, restart: false, left: false });
  assert.deepEqual(viewChange({ playing: false, left: false }, 0.6), { playing: true, restart: false, left: false });
  // Gone from the screen: the next visit starts it over.
  assert.deepEqual(viewChange({ playing: true, left: false }, 0), { playing: false, restart: false, left: true });
});

test('the subtitles panel lights the line the board is saying', () => {
  const cues = [{ start: 2.7, end: 4 }, { start: 4, end: 5.22 }];
  assert.deepEqual(cuesOn(cues, 1), [false, false]);
  assert.deepEqual(cuesOn(cues, 3), [true, false]);
  assert.deepEqual(cuesOn(cues, 4), [false, true]);
  assert.deepEqual(cuesOn(cues, 6), [false, false]);
});

test('the final cut shows minutes and seconds', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(59.9), '00:59');
  assert.equal(formatTime(61), '01:01');
});

test('what the chat says is what the boards are', () => {
  // "40% larger": v2's title against v1's.
  assert.match(section('step-ask'), /40% larger/);
  assert.equal(SIGNAL.v2.size / SIGNAL.v1.size, 1.4);
  // "every line fits its box at the same size": every translation keeps the 16:9's title size.
  assert.match(section('step-languages'), /every line fits its box at the same size/);
  for (const lang of Object.keys(TEXT)) assert.equal(titleSize('16x9', lang), BRAND['16x9'].title.size, lang);
  // "your edits stay": the branded 16:9 keeps v3's hand-made position.
  assert.match(section('step-brand'), /your edits stay/);
  assert.equal(BRAND['16x9'].title.x, SIGNAL.v3.x);
  assert.equal(BRAND['16x9'].title.y1, SIGNAL.v3.y1);
  // The inspector's numbers are v2's and v3's title, drawn at v3's (the finished edit).
  for (const [field, from, to] of [['X', SIGNAL.v2.x, SIGNAL.v3.x], ['Y', SIGNAL.v2.y1, SIGNAL.v3.y1], ['Size', SIGNAL.v2.size, SIGNAL.v3.size]]) {
    assert.match(section('step-edit'), new RegExp(`<dt>${field}</dt><dd data-from="${from}" data-to="${to}">${to}</dd>`), field);
  }
});

test('the subtitled board draws the lines the subtitles panel lists, at the same times', () => {
  const set = JSON.parse(readFileSync(join(SITE, 'compositions', 'story-subs', 'subtitles.json'), 'utf8'));
  const items = [...section('step-subtitles').matchAll(/<li data-start="([\d.]+)" data-end="([\d.]+)"><span class="lines__t">[^<]+<\/span>([^<]+)<\/li>/g)];
  assert.equal(items.length, set.cues.length);
  items.forEach(([, start, end, text], i) => {
    assert.equal(text, set.cues[i].text);
    assert.equal(Number(start) * 1000, set.cues[i].start);
    assert.equal(Number(end) * 1000, set.cues[i].end);
  });
});
