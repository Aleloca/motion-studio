import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, REPO } from './helpers.mjs';

const html = readFileSync(join(SITE, 'src', 'index.html'), 'utf8');
const visibleText = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ');
const REPO_URL = 'https://github.com/Aleloca/motion-studio';

/** GitHub's heading anchors: lower case, punctuation dropped (but - and _), spaces to hyphens. */
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

test('one h1, and headings never skip a level', () => {
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1);
  assert.equal(levels[0], 1);
  levels.reduce((prev, l) => { assert.ok(l <= prev + 1, `h${prev} then h${l}`); return l; });
});

test('nine feature blocks in order with the right data-category', () => {
  const blocks = [...html.matchAll(/<article class="feature[^"]*" id="([\w-]+)" data-category="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(blocks, ['formats:formats', 'editor:formats', 'brand:brand', 'identity:store', 'languages:lang', 'agent:agent', 'local:agent', 'services:brand', 'variants:formats']);
});

test('every README anchor link resolves', () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const anchors = new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
  const used = [...html.matchAll(/href="https:\/\/github\.com\/Aleloca\/motion-studio#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 9, `only ${used.length} README links`);
  for (const a of used) assert.ok(anchors.has(a), `#${a}`);
});

test('every repo file link points at a file that exists', () => {
  for (const [, path] of html.matchAll(/href="https:\/\/github\.com\/Aleloca\/motion-studio\/(?:blob|tree)\/main\/([^"#]+)/g)) assert.ok(existsSync(join(REPO, path)), path);
});

test('every figure has a poster with alt, width and height', () => {
  const figures = [...html.matchAll(/<figure class="comp[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)];
  assert.ok(figures.length >= 3 + 9 + 6);
  for (const [, inner] of figures) {
    const img = /<img class="poster"([^>]*)>/.exec(inner)?.[1];
    assert.ok(img, inner.slice(0, 80));
    for (const attr of ['alt="', 'width="', 'height="', 'src="compositions/']) assert.ok(img.includes(attr), `${attr} in ${img}`);
    assert.doesNotMatch(img, /alt=""/);
  }
});

test('every data-composition id exists in site/compositions', () => {
  for (const [, id] of html.matchAll(/data-composition="([\w-]+)"/g)) assert.ok(existsSync(join(SITE, 'compositions', id, 'composition.json')), id);
});

test('no forbidden words', () => {
  assert.doesNotMatch(visibleText, /\bGSAP\b|\bMori\b|greensock/i);
});

test('install section is faithful to the README', () => {
  const install = /<section[^>]*id="install"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(install.includes('pnpm install') && install.includes('pnpm motion-studio'));
  assert.equal((install.match(/once published/g) ?? []).length, 2);
  assert.ok(install.includes('npx @motion-studio/cli'));
  for (const req of ['Claude Code', 'Git', 'FFmpeg', 'Node.js 22']) assert.ok(install.includes(req), req);
});

test('no external URLs other than the repo, its pages and the Claude Code docs', () => {
  const urls = [...html.matchAll(/(?:href|src|content)="(https?:[^"]+)"/g)].map((m) => m[1]);
  for (const u of urls) assert.ok(u.startsWith(REPO_URL) || u.startsWith('https://aleloca.github.io/motion-studio/') || u.startsWith('https://docs.claude.com/'), u);
});

test('the paid services copy says the confirmation can be turned off', () => {
  assert.doesNotMatch(visibleText, /Every paid generation asks for confirmation first\./);
  assert.match(visibleText, /asks for confirmation first, unless you turn it off in Settings/);
});

const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(html)[0];
const heroSets = hero.split('<div class="hero__set"').slice(1).map((part) => {
  const head = part.slice(0, part.indexOf('>'));
  return {
    hidden: /\shidden$/.test(head),
    brief: /data-brief="([^"]+)"/.exec(head)?.[1],
    chips: /data-chips="([^"]+)"/.exec(head)?.[1].split('|') ?? [],
    ids: [...part.matchAll(/data-composition="([\w-]+)"/g)].map((m) => m[1]),
    imgs: [...part.matchAll(/<img [^>]*>/g)].map((m) => m[0]),
  };
});

test('the hero cycles through three or four creatives; without JS the first one shows', () => {
  assert.ok(heroSets.length >= 3 && heroSets.length <= 4, `${heroSets.length} sets`);
  heroSets.forEach((set, i) => {
    assert.equal(set.hidden, i > 0, `set ${i} hidden`);
    assert.ok(set.brief, `set ${i} brief`);
    assert.equal(set.ids.length, 3, `set ${i} frames`);
    assert.equal(set.chips.length, set.ids.length, `set ${i} chips`);
    // The later sets load their posters only when the cycle reaches them.
    for (const img of set.imgs) assert.equal(img.includes('loading="lazy"'), i > 0, img);
  });
  const prefixes = heroSets.map((s) => s.ids[0].split('-')[0]);
  assert.equal(new Set(prefixes).size, heroSets.length, 'one creative per set');
  for (const s of heroSets) assert.ok(s.ids.every((id) => id.startsWith(`${s.ids[0].split('-')[0]}-`)), s.ids.join());
  const typed = /<span class="brief__typed">([^<]+)<\/span>/.exec(hero)[1];
  assert.equal(typed, heroSets[0].brief);
  const chips = [.../<ul class="brief__chips"[^>]*>([\s\S]*?)<\/ul>/.exec(hero)[1].matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(chips, heroSets[0].chips);
});

test('every hero creative can also be played in the showcase', () => {
  const showcase = /<section[^>]*id="showcase"[\s\S]*?<\/section>/.exec(html)[0];
  const shown = new Set([...showcase.matchAll(/data-composition="([\w-]+)"/g)].map((m) => m[1].split('-')[0]));
  for (const s of heroSets) assert.ok(shown.has(s.ids[0].split('-')[0]), s.ids[0]);
});

test('every figure starts from its composition\'s poster time', () => {
  for (const [, id, t] of html.matchAll(/data-composition="([\w-]+)" data-poster-time="([\d.]+)"/g)) {
    const meta = JSON.parse(readFileSync(join(SITE, 'compositions', id, 'meta.json'), 'utf8'));
    assert.equal(Number(t), meta.posterTime, id);
  }
});

test('every showcase card letterboxes in its composition\'s own background', () => {
  // The card's media area can be taller than the composition (the 9:16 card spans two rows): the band around it is the
  // composition's background, so the frame reads as one picture.
  const showcase = /<section[^>]*id="showcase"[\s\S]*?<\/section>/.exec(html)[0];
  const figures = [...showcase.matchAll(/<figure\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(figures.length >= 6);
  for (const tag of figures) {
    const id = /data-composition="([\w-]+)"/.exec(tag)[1];
    const { background } = JSON.parse(readFileSync(join(SITE, 'compositions', id, 'composition.json'), 'utf8'));
    assert.match(tag, new RegExp(`style="--comp-bg: ${background}"`), id);
  }
});

test('every showcase card plays again from its poster frame when it comes back on screen', () => {
  const showcase = /<section[^>]*id="showcase"[\s\S]*?<\/section>/.exec(html)[0];
  for (const [tag] of showcase.matchAll(/<figure\b[^>]*>/g)) assert.match(tag, /data-replay="poster"/, tag);
});

test('every showcase card loops from a time inside its composition, past the empty first frame', () => {
  const showcase = /<section[^>]*id="showcase"[\s\S]*?<\/section>/.exec(html)[0];
  for (const [tag] of showcase.matchAll(/<figure\b[^>]*>/g)) {
    const id = /data-composition="([\w-]+)"/.exec(tag)[1];
    const from = Number(/data-loop-from="([\d.]+)"/.exec(tag)?.[1]);
    const { duration } = JSON.parse(readFileSync(join(SITE, 'compositions', id, 'composition.json'), 'utf8'));
    assert.ok(from > 0 && from < duration, `${id}: data-loop-from ${from}`);
  }
});
