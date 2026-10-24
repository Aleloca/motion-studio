import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCompositions, validateAll } from '../lib/compositions.mjs';
import { isGeneratedMedia, SITE } from './helpers.mjs';

const EXPECTED = {
  'kova-9x16': 'instagram-reel-9x16', 'kova-1x1': 'instagram-post-1x1', 'kova-16x9': 'youtube-16x9',
  'tidefall-9x16': 'instagram-reel-9x16', 'tidefall-4x5': 'instagram-post-4x5', 'tidefall-16x9': 'youtube-16x9',
  'fernwise-9x16': 'instagram-reel-9x16', 'fernwise-1x1': 'instagram-post-1x1', 'fernwise-16x9': 'youtube-16x9',
  formats: 'youtube-16x9', editor: 'youtube-16x9', brand: 'instagram-post-1x1', identity: 'instagram-post-1x1',
  languages: 'youtube-16x9', agent: 'youtube-16x9', git: 'youtube-16x9', services: 'instagram-post-1x1',
  variants: 'youtube-16x9', og: 'og-image-1200x630', 'launch-16x9': 'youtube-16x9',
  'story-night': 'youtube-16x9', 'story-paper': 'youtube-16x9', 'story-signal-v1': 'youtube-16x9', 'story-signal-v2': 'youtube-16x9',
  'story-signal-v3': 'youtube-16x9', 'story-brand-16x9': 'youtube-16x9', 'story-brand-9x16': 'instagram-reel-9x16',
  'story-brand-1x1': 'instagram-post-1x1', 'story-it': 'youtube-16x9', 'story-de': 'youtube-16x9', 'story-es': 'youtube-16x9',
  'story-subs': 'youtube-16x9', 'story-backdrop-16x9': 'youtube-16x9',
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

test('the hero creatives are rich: several scenes, 8 to 15 s, svg art made by hand, no raster', () => {
  for (const item of items.filter((i) => /^(kova|tidefall|fernwise)-/.test(i.id))) {
    const c = item.composition;
    assert.ok(c.duration >= 8 && c.duration <= 15, `${item.id}: ${c.duration} s`);
    assert.ok(c.scenes.length >= 3, `${item.id}: scenes`);
    const clips = c.tracks.flatMap((t) => t.clips);
    assert.ok(clips.some((k) => k.type === 'svg'), `${item.id}: svg`);
    assert.ok(!clips.some((k) => k.type === 'image'), `${item.id}: no raster`);
    for (const f of readdirSync(join(item.dir, 'assets'))) assert.match(f, /\.svg$/, `${item.id}/assets/${f}`);
  }
});

test('the story\'s boards: three scenes over 8 s, svg art made by hand, the subtitled one with its subtitle set', () => {
  for (const item of items.filter((i) => i.id.startsWith('story-'))) {
    const c = item.composition;
    assert.equal(c.duration, 8, item.id);
    assert.deepEqual(c.scenes.map((s) => s.id), ['brief', 'title', 'endcard'], item.id);
    for (const f of readdirSync(join(item.dir, 'assets'), { recursive: true }).filter((f) => !isGeneratedMedia(`assets/${f}`) && f !== 'audio')) assert.match(f, /\.svg$/, `${item.id}/assets/${f}`);
    const subtitled = c.tracks.some((t) => t.kind === 'subtitles');
    assert.equal(subtitled, item.id === 'story-subs', item.id);
    assert.equal(Boolean(item.subtitles), subtitled, `${item.id}: subtitles.json`);
  }
});

test('no video clips; audio only in the launch film and the subtitled board, each on an audio track with its file', () => {
  for (const item of items) for (const t of item.composition.tracks) for (const c of t.clips) {
    assert.notEqual(c.type, 'video', `${item.id}/${c.id}`);
    if (c.type !== 'audio') continue;
    assert.ok(['launch-16x9', 'story-subs'].includes(item.id), `${item.id}/${c.id}`);
    assert.equal(t.kind, 'audio', `${item.id}/${c.id}`);
    assert.ok(existsSync(join(item.dir, c.src)), `${item.id}/${c.src}`);
  }
});

test('the subtitled board speaks its line, and its subtitle set is that line, each word timed', () => {
  const item = items.find((i) => i.id === 'story-subs');
  const voice = item.composition.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'audio');
  assert.equal(voice.length, 1);
  assert.equal(voice[0].role, 'voice');
  const words = item.subtitles.cues.flatMap((c) => c.words.map((w) => w.text));
  assert.equal(words.join(' '), voice[0].script);
  for (const c of item.subtitles.cues) {
    assert.ok(c.start >= voice[0].start * 1000 - 200 && c.end <= (voice[0].start + voice[0].duration) * 1000 + 1000, c.text);
    for (const w of c.words) assert.ok(w.start >= c.start && w.end <= c.end && w.end >= w.start, `${c.text}: ${w.text}`);
  }
});

test('the Open Graph image exists', () => {
  assert.ok(existsSync(join(SITE, 'src', 'assets', 'og-image.png')));
});
