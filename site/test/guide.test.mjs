import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SITE } from './helpers.mjs';
import { webpSize } from '../lib/webp.mjs';

const SRC = join(SITE, 'src');
const html = readFileSync(join(SRC, 'guide.html'), 'utf8');
const index = readFileSync(join(SRC, 'index.html'), 'utf8');
const SHOTS = join(SRC, 'assets', 'guide');
const imgs = [...html.matchAll(/<img\b([^>]*)>/g)].map((m) => m[1]);
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const guideImgs = imgs.filter((t) => attr(t, 'src')?.startsWith('assets/guide/'));

test('one h1, and headings never skip a level', () => {
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1);
  assert.equal(levels[0], 1);
  levels.reduce((prev, l) => { assert.ok(l <= prev + 1, `h${prev} then h${l}`); return l; });
});

test('every image has alt text, a size and a file', () => {
  assert.ok(imgs.length > 0);
  for (const tag of imgs) {
    const src = attr(tag, 'src');
    assert.ok(attr(tag, 'alt')?.trim(), `alt of ${src}`);
    assert.ok(Number(attr(tag, 'width')) > 0 && Number(attr(tag, 'height')) > 0, `size of ${src}`);
    assert.ok(existsSync(join(SRC, src)), src);
  }
});

test('screenshots are webp, lazy, and their width and height are the file\'s own', () => {
  assert.ok(guideImgs.length >= 40, `only ${guideImgs.length} screenshots`);
  for (const tag of guideImgs) {
    const src = attr(tag, 'src');
    assert.match(src, /\.webp$/);
    assert.equal(attr(tag, 'loading'), 'lazy', src);
    const size = webpSize(readFileSync(join(SRC, src)));
    assert.deepEqual([Number(attr(tag, 'width')), Number(attr(tag, 'height'))], [size.width, size.height], src);
  }
});

test('every screenshot file is used once, and none is too heavy', () => {
  const used = guideImgs.map((t) => attr(t, 'src').slice('assets/guide/'.length));
  assert.equal(new Set(used).size, used.length, 'a screenshot is used twice');
  const files = readdirSync(SHOTS).filter((f) => !f.startsWith('.'));
  assert.deepEqual([...files].sort(), [...used].sort());
  let total = 0;
  for (const f of files) {
    const bytes = statSync(join(SHOTS, f)).size;
    assert.ok(bytes <= 200_000, `${f}: ${bytes} bytes`);
    total += bytes;
  }
  assert.ok(total <= 4_000_000, `screenshots weigh ${total} bytes`);
});

test('every in-page link has its target, and the contents list every section in order', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(id), `#${id}`);
  const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(html)[0];
  const listed = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/<section class="guide-section" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed, sections);
});

test('the guide and the home page link to each other', () => {
  assert.match(index, /href="guide\.html"/);
  assert.match(html, /href="\.\/"/);
});

test('no external URLs other than the repo, its pages and the Claude Code docs', () => {
  const urls = [...html.matchAll(/(?:href|src|content)="(https?:[^"]+)"/g)].map((m) => m[1]);
  for (const u of urls) assert.ok(u.startsWith('https://github.com/Aleloca/motion-studio') || u.startsWith('https://aleloca.github.io/motion-studio/') || u.startsWith('https://docs.claude.com/'), u);
});

test('covers every feature the brief lists', () => {
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const words of ['Claude Code', 'Language', 'Paid services', 'Projects', 'From a codebase', 'Assets', 'Video analysis', 'With the agent',
    'Services', 'live preview', 'Open editor', 'Comment a spot', '⌘↵', 'Stop and redirect', 'Queue for after', 'Activity details', 'Compare',
    'Inspector', 'Save as vN', 'Subtitles', 'Duplicate format', 'Translate', 'Store pack', '+ Variant', 'Final selection', 'Logo',
    'Website favicon', 'App icon', 'Social preview', 'Export', 'git', 'Archive', 'Delete', 'Usage', 'tokens', 'Sandbox', 'limits']) {
    assert.ok(text.includes(words), words);
  }
});

test('no local paths or personal data in the page', () => {
  assert.doesNotMatch(html, /\/Users\/|\/home\/[a-z]|@farmakom|\bsk-[A-Za-z0-9]/);
});
