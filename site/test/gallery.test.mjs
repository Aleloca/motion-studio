import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickGallery, GALLERY_LIMITS } from '../src/js/gallery-logic.js';

const at = (ratio, near = ratio > 0) => ({ ratio, near });

test('at most four boards play: the most visible ones, each at least a third on screen', () => {
  const s = pickGallery([at(1), at(0.9), at(0.2), at(1), at(0.8), at(0.6), at(0)]);
  assert.deepEqual([...s.playing].sort(), [0, 1, 3, 4]);
  assert.equal(GALLERY_LIMITS.playing, 4);
  assert.deepEqual([...pickGallery([at(0.3), at(0.1)]).playing], [], 'nothing a third on screen');
});

test('the players kept mounted are the playing ones and the nearest others, at most six', () => {
  const s = pickGallery([at(1), at(0.9), at(0.2), at(1), at(0.8), at(0.6), at(0.05), at(0, true), at(0, false)]);
  assert.equal(s.mounted.size, GALLERY_LIMITS.mounted);
  for (const i of s.playing) assert.ok(s.mounted.has(i));
  assert.ok(!s.mounted.has(8), 'far from the screen: never mounted');
  assert.ok(!s.mounted.has(7) || s.mounted.size <= 6);
});

test('under reduced motion nothing is mounted: the boards keep their posters', () => {
  const s = pickGallery([at(1), at(1)], { reducedMotion: true });
  assert.equal(s.mounted.size, 0);
  assert.equal(s.playing.size, 0);
});

test('within the page\'s budget of live runtimes (two on a phone): no more mounted or playing than it allows', () => {
  const s = pickGallery([at(1), at(0.9), at(1), at(0.8), at(0, true)], { budget: 2 });
  assert.equal(s.mounted.size, 2);
  assert.deepEqual([...s.playing].sort(), [0, 2]);
});
