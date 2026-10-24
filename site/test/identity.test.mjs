import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SITE } from './helpers.mjs';

const read = (p) => readFileSync(join(SITE, 'src', p), 'utf8');

/** The custom properties of the first `:root { … }` block of tokens.css. */
function tokens() {
  const css = read('css/tokens.css');
  const root = css.match(/:root\s*\{([^}]*)\}/)[1];
  return Object.fromEntries([...root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const SPEC_PALETTE = {
  'c-stage': '#0F0F0F', 'c-surface': '#171717', 'c-line': '#262626', 'c-dash': '#6B6B6B',
  'c-text': '#F5F1EC', 'c-muted': '#A3A3A3', 'c-orange': '#FF5A1F', 'c-orange-deep': '#C2410C',
  'c-formats': '#2DD4BF', 'c-brand': '#FF5A1F', 'c-store': '#A78BFA', 'c-lang': '#60A5FA', 'c-agent': '#FACC15',
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('tokens match the spec palette', () => {
  const t = tokens();
  for (const [k, v] of Object.entries(SPEC_PALETTE)) assert.equal(t[k]?.toUpperCase(), v, k);
});

test('text pairs pass AA', () => {
  const t = tokens();
  for (const [fg, bg] of [['c-text', 'c-stage'], ['c-muted', 'c-stage'], ['c-orange', 'c-stage'], ['c-text', 'c-surface'], ['c-muted', 'c-surface'],
    ['c-formats', 'c-stage'], ['c-store', 'c-stage'], ['c-lang', 'c-stage'], ['c-agent', 'c-stage'], ['c-stage', 'c-orange']]) {
    assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
  }
  assert.ok(contrast(t['c-orange-deep'], t['c-stage']) >= 3, 'deep orange is large-text only');
});

test('favicon paths are relative', () => {
  const snippet = read('index.html');
  assert.doesNotMatch(snippet, /href="\/(?!\/)/);
  const manifest = JSON.parse(read('assets/favicon/site.webmanifest'));
  for (const icon of manifest.icons) assert.ok(!icon.src.startsWith('/'), icon.src);
  assert.match(snippet, /rel="icon"[^>]*href="assets\/favicon\/favicon\.svg"/);
  assert.match(snippet, /rel="manifest"[^>]*href="assets\/favicon\/site\.webmanifest"/);
});

test('fonts are local', () => {
  const css = readdirSync(join(SITE, 'src', 'css')).map((f) => read(`css/${f}`)).join('\n');
  for (const text of [read('index.html'), css]) assert.doesNotMatch(text, /fonts\.(googleapis|gstatic)\.com/);
  for (const family of ['Bricolage Grotesque', 'Instrument Sans', 'JetBrains Mono']) assert.ok(css.includes(`'${family}'`), family);
});

test('one primary action: every primary button is the download of the latest release', () => {
  const primaries = [...read('index.html').matchAll(/<a class="[^"]*\bbtn--primary\b[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(primaries.length >= 1 && primaries.length <= 2, `${primaries.length} primary buttons`);
  for (const href of primaries) assert.equal(href, 'https://github.com/Aleloca/motion-studio/releases/latest');
});

test('the light logo keeps the orange and turns Motion off-white', () => {
  const svg = read('assets/logo-light.svg');
  assert.ok(!svg.includes('#171717'));
  assert.ok(svg.includes('#FF5A1F') && svg.includes('#F5F1EC'));
});

test('composition iframes match the runtime page colour scheme (no opaque white backdrop)', () => {
  assert.match(read('css/site.css'), /\.comp iframe\s*\{[^}]*color-scheme:\s*normal/);
});
