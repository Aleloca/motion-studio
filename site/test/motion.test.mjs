import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SITE } from './helpers.mjs';

const src = (p) => readFileSync(join(SITE, 'src', p), 'utf8');

test('final states are the CSS default', () => {
  // Rules that hide things must be scoped to html.js-motion, which main.js adds only when motion is allowed.
  // @keyframes steps are animations, not starting states.
  const css = src('css/site.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/opacity:\s*0(?![.\d])|visibility:\s*hidden/.test(body) && !selector.includes('.js-motion') && !selector.includes('.is-ready')) {
      assert.fail(`hides without .js-motion: ${selector.trim()}`);
    }
  }
});

test('vendor files are pinned 3.13.0', () => {
  const dir = join(SITE, 'src', 'vendor', 'gsap');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['ScrollTrigger.min.js', 'SplitText.min.js', 'gsap.min.js']);
  for (const f of files) assert.match(readFileSync(join(dir, f), 'utf8').slice(0, 400), /3\.13\.0/, f);
});

test('index.html loads no script from another origin', () => {
  const html = src('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 4);
  for (const attrs of scripts) assert.doesNotMatch(attrs, /src="(https?:)?\/\//);
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
});

test('main.js marks motion only when it is allowed', () => {
  const main = src('js/main.js');
  assert.match(main, /prefers-reduced-motion/);
  assert.match(main, /classList\.add\('js-motion'\)/);
});
