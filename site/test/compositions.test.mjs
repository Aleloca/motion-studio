import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCompositions, validateAll } from '../lib/compositions.mjs';
import { SITE } from './helpers.mjs';

const EXPECTED = {
  'hero-9x16': 'instagram-reel-9x16', 'hero-1x1': 'instagram-post-1x1', 'hero-16x9': 'youtube-16x9',
  formats: 'youtube-16x9', editor: 'youtube-16x9', brand: 'instagram-post-1x1', identity: 'instagram-post-1x1',
  languages: 'youtube-16x9', agent: 'youtube-16x9', git: 'youtube-16x9', services: 'instagram-post-1x1',
  variants: 'youtube-16x9', og: 'og-image-1200x630',
};
const items = await loadCompositions(join(SITE, 'compositions'));

/** Width and height of a WebP file (VP8, VP8L or VP8X). */
function webpSize(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
  throw new Error(`unknown webp chunk ${chunk}`);
}

test('every listed composition exists and validates with no problems', async () => {
  assert.deepEqual(Object.fromEntries(items.map((i) => [i.id, i.meta.format])), EXPECTED);
  for (const r of await validateAll(items)) assert.deepEqual(r.problems, [], r.id);
});

test('every composition has a poster.webp of its own size', () => {
  for (const item of items) {
    const p = join(item.dir, 'poster.webp');
    assert.ok(existsSync(p), `${item.id}: poster.webp`);
    assert.deepEqual(webpSize(readFileSync(p)), { width: item.composition.width, height: item.composition.height }, item.id);
  }
});

test('no video or audio clips', () => {
  for (const item of items) for (const t of item.composition.tracks) for (const c of t.clips) assert.ok(!['video', 'audio'].includes(c.type), `${item.id}/${c.id}`);
});

test('the Open Graph image exists', () => {
  assert.ok(existsSync(join(SITE, 'src', 'assets', 'og-image.png')));
});
