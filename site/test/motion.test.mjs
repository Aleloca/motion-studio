import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SITE } from './helpers.mjs';

const src = (p) => readFileSync(join(SITE, 'src', p), 'utf8');

test('final states are the CSS default', () => {
  // Rules that hide things must be scoped to html.js-motion, which main.js adds only when motion is allowed.
  // @keyframes steps are animations, not starting states.
  const css = (src('css/site.css') + src('css/story.css') + src('css/gallery.css')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/opacity:\s*0(?![.\d])|visibility:\s*hidden/.test(body) && !selector.includes('.js-motion') && !selector.includes('.is-ready')) {
      assert.fail(`hides without .js-motion: ${selector.trim()}`);
    }
  }
});

test('vendor files are pinned 3.13.0', () => {
  const dir = join(SITE, 'src', 'vendor', 'gsap');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['SplitText.min.js', 'gsap.min.js']);
  for (const f of files) assert.match(readFileSync(join(dir, f), 'utf8').slice(0, 400), /3\.13\.0/, f);
});

test('index.html loads no script from another origin', () => {
  const html = src('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 3);
  for (const attrs of scripts) assert.doesNotMatch(attrs, /src="(https?:)?\/\//);
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
});

test('main.js marks motion only when it is allowed', () => {
  const main = src('js/main.js');
  assert.match(main, /prefers-reduced-motion/);
  assert.match(main, /classList\.add\('js-motion'\)/);
});

test('the demos run by themselves: no scroll scrubbing, no pinned or sticky story, no scroll handlers', () => {
  const scenes = src('js/scenes.js');
  assert.match(scenes, /IntersectionObserver/);
  assert.doesNotMatch(scenes + src('js/main.js'), /ScrollTrigger|scrub|snap|addEventListener\('(scroll|wheel|touchmove|keydown)'|preventDefault|scrollTo|scrollIntoView/);
  assert.doesNotMatch(src('index.html'), /ScrollTrigger/);
  assert.doesNotMatch(src('css/story.css') + src('css/site.css'), /position: sticky/);
});

test('in-page links glide, except under reduced motion', () => {
  const css = src('css/site.css');
  assert.match(css, /html \{[^}]*scroll-behavior: smooth;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ html \{ scroll-behavior: auto; \} \}/);
  assert.doesNotMatch(css, /html\.js-motion \{ scroll-behavior/);
});
