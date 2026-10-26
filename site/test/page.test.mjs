import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, REPO } from './helpers.mjs';
import { GALLERY_IDS } from '../scripts/gallery-gen/build.mjs';

const html = readFileSync(join(SITE, 'src', 'index.html'), 'utf8');
const visibleText = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ');
const REPO_URL = 'https://github.com/Aleloca/motion-studio';
const LATEST = `${REPO_URL}/releases/latest`;
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const section = (id) => new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
const meta = (id) => JSON.parse(readFileSync(join(SITE, 'compositions', id, 'meta.json'), 'utf8'));
const comp = (id) => JSON.parse(readFileSync(join(SITE, 'compositions', id, 'composition.json'), 'utf8'));

const hero = section('story');
const STEPS = ['ask', 'edit', 'brand', 'generate', 'formats', 'languages', 'subtitles', 'identity', 'export'];
const steps = STEPS.map((id) => section(`step-${id}`));
/** The story: the hero and its steps. */
const story = [hero, ...steps].join('\n');
const num = (tag, name) => Number(attr(tag, name));

test('one h1, and headings never skip a level', () => {
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1);
  assert.equal(levels[0], 1);
  levels.reduce((prev, l) => { assert.ok(l <= prev + 1, `h${prev} then h${l}`); return l; });
});

test('the page is the hero, one section per step, then the final cut, Get started and the gallery', () => {
  const ids = [...html.matchAll(/<section[^>]*\bid="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['story', ...STEPS.map((id) => `step-${id}`), 'final-cut', 'install', 'gallery']);
  assert.ok(html.indexOf('id="gallery"') < html.indexOf('<footer'), 'the gallery comes before the footer');
});

test('the first viewport: the headline, the download of the latest release, the final cut, and step 1 playing by itself', () => {
  const copy = /<div class="hero__copy">[\s\S]*?<\/div>\s*<\/div>/.exec(hero)[0];
  assert.match(copy, /<h1\b/);
  assert.ok(copy.includes(`class="btn btn--primary hero__download" href="${LATEST}"`), 'Download for macOS');
  assert.match(copy, /Download for macOS/);
  assert.match(copy, /href="#final-cut"/);
  assert.ok(html.includes(`class="btn btn--small topbar__download" href="${LATEST}"`), 'the bar\'s Download');
  // Step 1: the brief, three variants, one chosen.
  assert.match(hero, /<div class="demo demo--hero" data-scene="brief">/);
  const boards = [...hero.matchAll(/<div class="board at[^"]*" data-board="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(boards, ['a', 'b', 'c']);
  assert.match(hero, /data-board="c"[^>]*>\s*<p class="board__label">[^\n]*Chosen/);
  assert.match(hero, /<p class="msg msg--you" data-type>A launch video for Motion Studio\. Three variants\.<\/p>/);
  assert.match(hero, /<p class="msg msg--agent">[^<]+<\/p>/);
});

test('on a phone the bar offers Get it (to Get started, where the macOS download is), not the macOS download', () => {
  assert.match(html, /<a class="btn btn--small topbar__get" href="#install">Get it<\/a>/);
  assert.ok(section('install').includes(LATEST), 'Get started links the latest release');
  const css = readFileSync(join(SITE, 'src', 'css', 'story.css'), 'utf8');
  assert.match(css, /@media \(max-width: 720px\) \{[^}]*\.topbar__download \{ display: none; \}/);
  assert.match(css, /\.topbar__get \{ display: none;/);
});

test('one section per step, in order: a step label, a title, two lines of copy, and its demo with the exchange', () => {
  const names = ['Ask', 'Edit by hand', 'Brand', 'Generate', 'Formats', 'Languages', 'Subtitles', 'Identity', 'Export'];
  steps.forEach((body, i) => {
    assert.match(body, new RegExp(`^<section class="step" id="step-${STEPS[i]}" aria-labelledby="${STEPS[i]}-title" data-scene="${STEPS[i]}">`));
    const title = /<h2 class="step__title" id="[\w-]+"><span class="step__n">(\d\d) · ([^<]+)<\/span> ([^<]+)<\/h2>/.exec(body);
    assert.ok(title, `step ${STEPS[i]} title`);
    assert.equal(title[1], String(i + 2).padStart(2, '0'));
    assert.equal(title[2], names[i]);
    const what = /<p class="step__what">([^<]+)<\/p>/.exec(body)[1];
    assert.ok(what.length > 60 && what.length < 150, `${STEPS[i]}: two lines of copy (${what.length} chars)`);
    assert.match(body, /<div class="demo">\s*<div class="demo__canvas">\s*<div class="scene" style="--sw:\d+;--sh:\d+;--psw:\d+;--psh:\d+">/, STEPS[i]);
    assert.match(body, /<div class="chat" role="group" aria-label="The exchange">[\s\S]*?<p class="msg msg--(you|event)">[^<]+<\/p>/, `${STEPS[i]}: the gesture`);
  });
});

test('the chat is drawn, never an input: no field, no caret, no send button', () => {
  const chats = [...story.matchAll(/<div class="chat"[\s\S]*?<\/div>/g)].map((m) => m[0]);
  assert.equal(chats.length, 10);
  for (const c of chats) assert.doesNotMatch(c, /<(input|textarea|button|form)\b|contenteditable|tabindex/);
  assert.doesNotMatch(html, /chat__composer|chat__caret|chat__field|chat__send|⌘↵|Describe what to change/);
  assert.doesNotMatch(html, /<textarea|contenteditable/);
});

test('every board and panel of a demo has its place in the scene, inside it and clear of the others, on a computer and on a phone', () => {
  for (const body of [hero, ...steps]) {
    const scene = /<div class="scene" style="([^"]+)">/.exec(body)[1];
    const v = (n) => Number(new RegExp(`--${n}:([\\d.]+)`).exec(scene)[1]);
    const items = [...body.matchAll(/<(?:div|p) class="[^"]*\bat\b[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(items.length > 0, body.slice(0, 60));
    for (const phone of [false, true]) {
      const [sw, sh] = phone ? [v('psw'), v('psh')] : [v('sw'), v('sh')];
      // A board's label sits above it: its box starts 20 units higher.
      const boxes = items.filter((t) => !(phone && t.includes('at--wide'))).map((t) => {
        const st = attr(t, 'style');
        const g = (n) => { const m = new RegExp(`--${phone ? 'p' : ''}${n}:(-?[\\d.]+)`).exec(st) ?? new RegExp(`--${n}:(-?[\\d.]+)`).exec(st); return Number(m[1]); };
        const label = t.includes('class="board') ? 20 : 0;
        return { t, x: g('x'), y: g('y') - label, w: g('w'), h: g('h') + label };
      });
      for (const b of boxes) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= sw + 0.01 && b.y + b.h <= sh + 0.01, `${phone ? 'phone' : 'computer'}: ${b.t} out of its ${sw}×${sh} scene`);
      boxes.forEach((p, i) => boxes.slice(i + 1).forEach((q) => {
        const hit = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        assert.ok(!hit, `${phone ? 'phone' : 'computer'}: ${p.t} and ${q.t} overlap`);
      }));
    }
  }
});

test('a new version wipes in over the poster of the one before it', () => {
  const frames = [...story.matchAll(/<div class="board__frame">([\s\S]*?)<\/figure>/g)].map((m) => m[1]).filter((f) => f.includes('data-wipe'));
  assert.equal(frames.length, 5, 'v2, v3, v4, v5 and v6');
  for (const f of frames) {
    const before = /<img class="board__before" src="([^"]+)"[^>]*alt=""/.exec(f);
    assert.ok(before, f.slice(0, 120));
    assert.ok(existsSync(join(SITE, before[1])), before[1]);
  }
});

test('the chat is labelled once as a demo', () => {
  assert.equal((visibleText.match(/\bdemo\b/gi) ?? []).length, 1);
  assert.match(hero, /<p class="hero__note">[^<]*demo[^<]*real features[^<]*<\/p>/);
});

test('every composition figure has a poster with alt and size, of a composition that exists, from its poster time', () => {
  const figures = [...html.matchAll(/<figure class="comp[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)];
  assert.equal(figures.length, 27, '14 in the story, the final cut and 12 in the gallery');
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

test('every poster offers its half-size file, which a phone takes; a wide screen keeps the full one', () => {
  const imgs = [...html.matchAll(/<img class="poster"[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length > 20);
  for (const img of imgs) {
    const id = /compositions\/([\w-]+)\/poster\.webp/.exec(img)[1];
    const w = Number(attr(img, 'width'));
    assert.equal(attr(img, 'srcset'), `compositions/${id}/poster-half.webp ${Math.round(w / 2)}w, compositions/${id}/poster.webp ${w}w`, id);
    assert.equal(attr(img, 'sizes'), '(max-width: 959px) 320px, 100vw', id);
  }
});

test('the story\'s boards loop from a time inside their composition, past the typed brief', () => {
  const tags = [...story.matchAll(/<figure\b[^>]*>/g)].map((m) => m[0]).filter((t) => attr(t, 'data-composition').startsWith('story-'));
  assert.equal(tags.length, 13);
  for (const tag of tags) {
    const id = attr(tag, 'data-composition');
    const from = Number(attr(tag, 'data-loop-from'));
    assert.ok(from > 0 && from < comp(id).duration, `${id}: data-loop-from ${from}`);
  }
});

test('only the hero\'s pictures load at once; the steps\' wait for the scroll', () => {
  for (const img of [...hero.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])) assert.doesNotMatch(img, /loading="lazy"/, img);
  for (const body of steps) for (const img of [...body.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])) assert.match(img, /loading="lazy"/, img);
});

test('every step\'s demo shows its result as real pictures, each with its size and an existing file', () => {
  for (const body of [hero, ...steps]) {
    const imgs = [...body.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.length > 0 || /<ul class="export__rows">/.test(body), body.slice(0, 60));
    for (const img of imgs) {
      for (const a of ['src', 'width', 'height']) assert.ok(attr(img, a), `${a} in ${img}`);
      assert.ok(/\balt="/.test(img), `alt in ${img}`);
      const src = attr(img, 'src');
      assert.ok(existsSync(join(SITE, 'src', src)) || existsSync(join(SITE, src)), src);
    }
  }
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

test('nothing speaks by itself: only Generate and Subtitles have a Play with sound control, shown by the script', () => {
  assert.doesNotMatch(html, /\bautoplay\b(?!=)|<audio\b|<video\b/);
  assert.doesNotMatch(html, /story__sound|data-voice="board"/);
  const controls = [...html.matchAll(/<button class="sound-play" type="button" data-sound-play="(\w+)"[^>]*\bhidden>[\s\S]*?<\/button>/g)];
  assert.deepEqual(controls.map((m) => m[1]), ['generate', 'subtitles']);
  for (const [whole] of controls) assert.match(whole, /Play with sound/);
  assert.ok(section('step-generate').includes('data-sound-play="generate"'));
  assert.ok(section('step-subtitles').includes('data-sound-play="subtitles"'));
  for (const m of html.matchAll(/data-(?:voice|music)="([^"]+)"/g)) assert.ok(existsSync(join(SITE, m[1])), m[1]);
  const vo = JSON.parse(readFileSync(join(SITE, 'scripts', 'audio-gen', 'media.json'), 'utf8')).vo;
  assert.match(section('step-generate'), new RegExp(`data-voice="compositions/launch-16x9/assets/audio/${vo[5].file}"`));
  const subs = comp('story-subs').tracks.flatMap((t) => t.clips).find((c) => c.type === 'audio');
  assert.equal(subs.script, vo[8].text, 'the subtitled board says the film\'s subtitles line');
});

test('the Generate step: the backdrop it makes lands in board C, with the film\'s own voice and music; the paid call confirmed first, no invented price', () => {
  const gen = section('step-generate');
  assert.match(gen, /<p class="msg msg--you">[^<]+<\/p>/);
  assert.match(gen, /<div class="genpanel__paid">[\s\S]*Generate an image with gpt-image-2[\s\S]*your own OpenAI account[\s\S]*<\/div>/);
  assert.doesNotMatch(story, /\$\s?\d|\d\s?USD|€/, 'no price anywhere in the story');
  assert.match(gen, /data-composition="story-backdrop-16x9"[^>]*data-wipe/);
  assert.doesNotMatch(story, /gpt-4o-mini-tts|cedar|earbuds/);
  assert.doesNotMatch(html, /gpt-4o-mini-tts|cedar/);
  const media = JSON.parse(readFileSync(join(SITE, 'scripts', 'audio-gen', 'media.json'), 'utf8'));
  assert.ok(gen.includes(media.image.model) && gen.includes(media.voice.model), 'the models that really made them');
  assert.ok(gen.includes(`data-music="compositions/launch-16x9/assets/audio/${media.music.file}"`));
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
