import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, REPO } from './helpers.mjs';
import { parseSteps, inSteps } from '../src/js/story-logic.js';
import { GALLERY_IDS } from '../scripts/gallery-gen/build.mjs';

const html = readFileSync(join(SITE, 'src', 'index.html'), 'utf8');
const visibleText = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ');
const REPO_URL = 'https://github.com/Aleloca/motion-studio';
const LATEST = `${REPO_URL}/releases/latest`;
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const section = (id) => new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
const meta = (id) => JSON.parse(readFileSync(join(SITE, 'compositions', id, 'meta.json'), 'utf8'));
const comp = (id) => JSON.parse(readFileSync(join(SITE, 'compositions', id, 'composition.json'), 'utf8'));

const story = section('story');
const stage = /<div class="stage"[\s\S]*?<p class="story__note">/.exec(story)[0];
const steps = story.split('<li class="step"').slice(1).map((part) => ({
  head: part.slice(0, part.indexOf('>')),
  body: part.slice(0, part.indexOf('</li>')),
}));

test('one h1, and headings never skip a level', () => {
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1);
  assert.equal(levels[0], 1);
  levels.reduce((prev, l) => { assert.ok(l <= prev + 1, `h${prev} then h${l}`); return l; });
});

test('the page is the story, then the final cut, then Get started, then the gallery', () => {
  const ids = [...html.matchAll(/<section[^>]*\bid="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['story', 'final-cut', 'install', 'gallery']);
  assert.ok(html.indexOf('id="gallery"') < html.indexOf('<footer'), 'the gallery comes before the footer');
});

test('the first viewport offers the download of the latest release and the final cut', () => {
  const intro = /<div class="intro">[\s\S]*?<\/div>\s*<!--/.exec(story)[0];
  assert.match(intro, /<h1\b/);
  assert.ok(intro.includes(`class="btn btn--primary" href="${LATEST}"`), 'Download for macOS');
  assert.match(intro, /Download for macOS/);
  assert.match(intro, /href="#final-cut"/);
  assert.ok(html.includes(`class="btn btn--small topbar__download" href="${LATEST}"`), 'the bar\'s Download');
});

test('on a phone the bar offers Get it (to Get started, where the macOS download is) and the sound switch, not the macOS download', () => {
  assert.match(html, /<a class="btn btn--small topbar__get" href="#install">Get it<\/a>/);
  assert.ok(section('install').includes(LATEST), 'Get started links the latest release');
  const css = readFileSync(join(SITE, 'src', 'css', 'story.css'), 'utf8');
  assert.match(css, /@media \(max-width: 720px\) \{[^}]*\.topbar__download \{ display: none; \}/);
  assert.match(css, /\.topbar__get \{ display: none;/);
});

test('eleven steps in order, each a static block: a title, what it shows, the exchange and the result', () => {
  const names = ['Brief', 'Choose', 'Ask', 'Edit by hand', 'Brand', 'Generate', 'Formats', 'Languages', 'Subtitles', 'Identity', 'Export'];
  assert.equal(steps.length, 11);
  steps.forEach(({ head, body }, i) => {
    assert.equal(attr(head, 'data-step'), String(i + 1));
    const title = /<h2 class="step__title"><span class="step__n">(\d\d)<\/span> ([^<]+)<\/h2>/.exec(body);
    assert.ok(title, `step ${i + 1} title`);
    assert.equal(title[1], String(i + 1).padStart(2, '0'));
    assert.equal(title[2], names[i]);
    assert.match(body, /<p class="step__what">[^<]+<\/p>/, `step ${i + 1} what`);
    assert.match(body, /<p class="msg msg--(you|event)">[^<]+<\/p>/, `step ${i + 1} gesture`);
    const result = body.slice(body.indexOf('<div class="step__result'));
    const imgs = [...result.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.length > 0 || /<ul class="files">/.test(result), `step ${i + 1} result`);
    for (const img of imgs) {
      for (const a of ['src', 'alt', 'width', 'height']) assert.ok(attr(img, a), `${a} in ${img}`);
      const src = attr(img, 'src');
      assert.ok(existsSync(join(SITE, 'src', src)) || existsSync(join(SITE, src)), src);
      // Only the first step's posters load at once; the rest wait for the scroll.
      assert.equal(img.includes('loading="lazy"'), i > 0, img);
    }
  });
});

test('the chat is labelled once as a demo', () => {
  assert.equal((visibleText.match(/\bdemo\b/gi) ?? []).length, 1);
  assert.match(story, /<p class="story__note">[^<]*demo[^<]*real features[^<]*<\/p>/);
});

test('every composition figure has a poster with alt and size, of a composition that exists, from its poster time', () => {
  const figures = [...html.matchAll(/<figure class="comp[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)];
  assert.equal(figures.length, 27, '14 on the canvas, the final cut and 12 in the gallery');
  for (const [whole, inner] of figures) {
    const id = attr(whole, 'data-composition');
    assert.ok(existsSync(join(SITE, 'compositions', id, 'composition.json')), id);
    assert.equal(Number(attr(whole, 'data-poster-time')), meta(id).posterTime, id);
    const img = /<img class="poster"([^>]*)>/.exec(inner)?.[1];
    assert.ok(img, inner.slice(0, 80));
    for (const a of ['alt="', 'width="', 'height="', `src="compositions/${id}/poster.webp"`]) assert.ok(img.includes(a), `${a} in ${img}`);
    assert.doesNotMatch(img, /alt=""/);
  }
});

test('the story\'s boards loop from a time inside their composition, past the typed brief', () => {
  const tags = [...stage.matchAll(/<figure\b[^>]*>/g)].map((m) => m[0]).filter((t) => attr(t, 'data-composition').startsWith('story-'));
  assert.ok(tags.length >= 12);
  for (const tag of tags) {
    const id = attr(tag, 'data-composition');
    const from = Number(attr(tag, 'data-loop-from'));
    assert.ok(from > 0 && from < comp(id).duration, `${id}: data-loop-from ${from}`);
  }
});

test('every board and panel has a place in the world and a step range; a figure\'s steps lie inside its board\'s', () => {
  const boards = [...stage.matchAll(/<div class="(?:board|panel)\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(boards.length >= 15);
  for (const tag of boards) {
    const style = attr(tag, 'style');
    for (const v of ['--x', '--y', '--w', '--h']) assert.match(style, new RegExp(`${v}:-?[\\d.]+`), tag);
    const range = parseSteps(attr(tag, 'data-steps'));
    assert.ok(range.every(([a, b]) => a >= 1 && b <= 11 && a <= b), tag);
  }
  const c = /<div class="board board--main"[\s\S]*?<!-- Step 4/.exec(stage)[0];
  const range = parseSteps(attr(c, 'data-steps'));
  const figs = [...c.matchAll(/<figure\b[^>]*>/g)].map((m) => parseSteps(attr(m[0], 'data-steps')));
  assert.equal(figs.length, 6, 'board C: v1, v2, v3, v4, v5 (the backdrop), v6 (subtitles)');
  for (const f of figs) for (const [a, b] of f) assert.ok(inSteps(range, a) && inSteps(range, b));
  for (let n = 1; n <= 11; n++) assert.ok(figs.some((f) => inSteps(f, n)), `C has a version in step ${n}`);
});

test('the final cut: a composition player with controls, its poster, and the one slot the launch video takes', () => {
  const final = section('final-cut');
  const slots = [...html.matchAll(/<figure\b[^>]*\bdata-final-cut\b[^>]*>/g)];
  assert.equal(slots.length, 1);
  const tag = slots[0][0];
  assert.ok(tag.includes('data-controls') && tag.includes('data-loop="false"') && tag.includes('data-autoplay="false"'), tag);
  assert.match(final, /<button class="final__start" type="button" aria-label="Play the launch film, with sound">/);
  const id = attr(tag, 'data-composition');
  assert.ok(existsSync(join(SITE, 'compositions', id, 'composition.json')), id);
  assert.match(final, /<img class="poster"[^>]*alt="[^"]+"/);
  for (const c of ['player-bar__play', 'player-bar__seek', 'player-bar__replay', 'player-bar__sound', 'player-bar__full']) assert.ok(final.includes(c), c);
  assert.match(final, /<button class="player-bar__btn player-bar__sound" type="button" data-sound aria-label="Sound on">/);
  assert.match(final, /type="range"[^>]*aria-label="Seek"/);
  assert.ok(final.includes(`class="btn btn--primary" href="${LATEST}"`), 'Download');
  assert.ok(final.includes(`href="${REPO_URL}"`), 'GitHub');
});

test('every in-page link has its target, and every local file the page links exists', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `#${target}`);
  for (const [, url] of html.matchAll(/(?:href|src)="(?![a-z]+:|#|\.\/")([^"]+)"/g)) {
    const path = url.split(/[?#]/)[0];
    assert.ok(existsSync(join(SITE, 'src', path)) || existsSync(join(SITE, path)), url);
  }
});

test('every repo file link points at a file that exists', () => {
  for (const [, path] of html.matchAll(/href="https:\/\/github\.com\/Aleloca\/motion-studio\/(?:blob|tree)\/main\/([^"#]+)/g)) assert.ok(existsSync(join(REPO, path)), path);
});

test('no forbidden words', () => {
  assert.doesNotMatch(visibleText, /\bGSAP\b|\bMori\b|greensock/i);
});

test('install section is faithful to the README', () => {
  const install = section('install');
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  assert.ok(install.includes('pnpm install') && install.includes('pnpm motion-studio'));
  assert.equal((install.match(/once published/g) ?? []).length, 0, 'everything in the install section is published');
  assert.ok(install.includes('npx @motion-studio/cli'));
  for (const file of ['.dmg', '.exe', '.AppImage']) { assert.ok(install.includes(file), file); assert.ok(readme.includes(file), `README ${file}`); }
  assert.match(readme, /signed and notarized/);
  assert.match(install, /signed and notarized/);
  for (const req of ['Claude Code', 'Git', 'FFmpeg', 'Node.js 22']) assert.ok(install.includes(req), req);
  assert.match(install, /href="guide\.html"/);
});

test('no external URLs other than the repo, its pages and the Claude Code docs', () => {
  const urls = [...html.matchAll(/(?:href|src|content)="(https?:[^"]+)"/g)].map((m) => m[1]);
  for (const u of urls) assert.ok(u.startsWith(REPO_URL) || u.startsWith('https://aleloca.github.io/motion-studio/') || u.startsWith('https://docs.claude.com/'), u);
});

test('every step says its voice-over line: the film\'s line of that beat, or (subtitles) its board\'s own voice', () => {
  const vo = JSON.parse(readFileSync(join(SITE, 'scripts', 'audio-gen', 'media.json'), 'utf8')).vo;
  steps.forEach(({ head }, i) => {
    const voice = attr(head, 'data-voice');
    if (i + 1 === 9) { assert.equal(voice, 'board'); return; }
    assert.equal(voice, `compositions/launch-16x9/assets/audio/${vo[i].file}`, `step ${i + 1}`);
    assert.ok(existsSync(join(SITE, voice)), voice);
  });
  const subs = comp('story-subs').tracks.flatMap((t) => t.clips).find((c) => c.type === 'audio');
  assert.equal(subs.script, vo[8].text);
  // The story's sound button sits outside the aria-hidden canvas, off until story.js shows it.
  assert.match(story, /<button class="sound-btn story__sound" type="button" data-sound hidden>[\s\S]*?Sound on/);
  const hiddenCanvas = stage.slice(0, stage.indexOf('<div class="caption">'));
  assert.doesNotMatch(hiddenCanvas, /data-sound/);
  assert.match(stage, /<div class="caption">[\s\S]*?<\/div><\/div>\s*<\/div>\s*<!--[^>]*-->\s*<button class="sound-btn story__sound"/, 'the button follows the canvas');
});

test('the Generate step: the backdrop it makes lands in board C, with the film\'s own voice and music; the paid call confirmed first, no invented price', () => {
  const gen = steps[5].body;
  assert.match(gen, /<p class="msg msg--you">[^<]+<\/p>/);
  assert.match(gen, /<div class="msg msg--paid">[\s\S]*Generate an image with gpt-image-2[\s\S]*your own OpenAI account[\s\S]*<\/div>/);
  assert.doesNotMatch(story, /\$\s?\d|\d\s?USD|€/, 'no price anywhere in the story');
  assert.match(gen, /src="compositions\/story-backdrop-16x9\/poster\.webp"/);
  assert.match(gen, /<audio controls preload="none" src="compositions\/launch-16x9\/assets\/audio\/music\.mp3"><\/audio>/);
  assert.match(stage, /data-composition="story-backdrop-16x9"[^>]*data-steps="6-8"/);
  // The story no longer generates earbuds (the gallery's KOVA board is an earbuds launch: that is fine).
  assert.doesNotMatch(story, /gpt-4o-mini-tts|cedar|earbuds/);
  assert.doesNotMatch(html, /gpt-4o-mini-tts|cedar/);
  for (const m of stage.matchAll(/data-play="([^"]+)"/g)) assert.ok(existsSync(join(SITE, m[1])), m[1]);
  assert.match(gen, /<audio controls preload="none" src="compositions\/launch-16x9\/assets\/audio\/vo-06\.mp3"><\/audio>/);
  const media = JSON.parse(readFileSync(join(SITE, 'scripts', 'audio-gen', 'media.json'), 'utf8'));
  assert.ok(gen.includes(media.image.model) && gen.includes(media.voice.model), 'the models that really made them');
  assert.match(stage, /data-board="genimg" data-steps="6"/);
  assert.match(stage, /<div class="panel genpanel" data-steps="6"/);
});

test('the gallery: twelve boards on the canvas, each a real composition with its name, mono format label and topic and style', () => {
  const gallery = section('gallery');
  assert.match(gallery, /<h2 id="gallery-title">[^<]+<\/h2>/);
  assert.doesNotMatch(gallery.slice(0, gallery.indexOf('<h2')), /eyebrow|<p\b/, 'no label above the heading');
  const boards = gallery.split('<article class="gboard').slice(1).map((b) => b.slice(0, b.indexOf('</article>')));
  assert.equal(boards.length, 12);
  const FMT = { 'instagram-reel-9x16': ['9x16', '9:16', 'Reel'], 'instagram-post-4x5': ['4x5', '4:5', 'Post'], 'instagram-post-1x1': ['1x1', '1:1', 'Post'], 'youtube-16x9': ['16x9', '16:9', 'YouTube'] };
  const ids = boards.map((b) => {
    const fig = /<figure class="comp comp--([\dx]+)"[^>]*>/.exec(b)[0];
    const id = attr(fig, 'data-composition');
    const [cls, ratio, channel] = FMT[meta(id).format];
    assert.ok(fig.includes(`comp--${cls}`) && b.startsWith(` gboard--${cls}"`), `${id}: its format's frame`);
    assert.ok(fig.includes('data-gallery'), `${id}: driven by the gallery`);
    assert.doesNotMatch(fig, /data-autoplay|data-controls/, id);
    assert.ok(new RegExp(`<span class="gboard__name">[^<]+</span><span class="gboard__fmt">${ratio}<span class="gboard__ch"> · ${channel}</span></span>`).test(b), `${id}: name and format label`);
    assert.match(b, /<img class="poster"[^>]*loading="lazy"/, `${id}: a lazy poster`);
    const tag = /<p class="gboard__tag">([^<]+)<\/p>/.exec(b)[1];
    const more = /<p class="gboard__more" aria-hidden="true">([^<]+)<\/p>/.exec(b)[1];
    assert.equal(tag.split(' · ').length, 2, `${id}: topic · style`);
    assert.ok(more.startsWith(`${tag} · `) && more.split(' · ').length === 3, `${id}: topic · style · motion`);
    return id;
  });
  assert.deepEqual([...ids].sort(), [...GALLERY_IDS, 'kova-16x9', 'tidefall-4x5', 'fernwise-9x16'].sort());
  const topics = boards.map((b) => /<p class="gboard__tag">([^<·]+)/.exec(b)[1].trim());
  assert.equal(new Set(topics).size, 12, 'twelve topics');
  for (const cls of ['9x16', '4x5', '1x1', '16x9']) assert.equal(boards.filter((b) => b.startsWith(` gboard--${cls}"`)).length, 3, cls);
});
