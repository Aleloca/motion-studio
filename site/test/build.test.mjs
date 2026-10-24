import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../build.mjs';
import { loadCompositions, validateAll } from '../lib/compositions.mjs';
import { SITE, tempDir, walk } from './helpers.mjs';

const SAMPLE = 'kova-16x9';
let out;

before(async () => {
  out = join(tempDir(), '_site');
  await build({ root: SITE, out });
});

test('validates the sample composition with no problems', async () => {
  const items = (await loadCompositions(join(SITE, 'compositions'))).filter((i) => i.id === SAMPLE);
  assert.equal(items.length, 1);
  const [result] = await validateAll(items);
  assert.deepEqual(result.problems, []);
});

test('rejects a composition with an unknown format', async () => {
  const root = tempDir();
  cpSync(join(SITE, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(SITE, 'compositions', SAMPLE), join(root, 'compositions', 'broken'), { recursive: true });
  const metaPath = join(root, 'compositions', 'broken', 'meta.json');
  writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), format: 'nope' }));
  await assert.rejects(build({ root, out: join(root, '_site') }), /broken/);
});

test('writes a runtime page per composition with base ../compositions/<id>/', () => {
  const page = readFileSync(join(out, 'runtime', `${SAMPLE}.html`), 'utf8');
  assert.match(page, /id="ms-composition"/);
  assert.ok(page.includes(`"base":"../compositions/${SAMPLE}/"`));
});

test('copies runtime.js, preview.js and layer.js', () => {
  for (const f of ['runtime.js', 'preview.js', 'layer.js']) assert.ok(existsSync(join(out, 'runtime', f)), f);
});

test('writes compositions.json with sizes and poster times', () => {
  const list = JSON.parse(readFileSync(join(out, 'compositions.json'), 'utf8'));
  const item = list.find((i) => i.id === SAMPLE);
  assert.ok(item);
  for (const k of ['width', 'height', 'duration', 'posterTime', 'label']) assert.ok(k in item, k);
});

test('no root-absolute URLs in _site', () => {
  for (const f of walk(out).filter((f) => /\.(html|css)$/.test(f))) {
    const text = readFileSync(join(out, f), 'utf8');
    assert.doesNotMatch(text, /(?:src|href)="\/(?!\/)|url\(\s*['"]?\/(?!\/)/, f);
  }
});

test('no .DS_Store and no meta.json in _site', () => {
  const files = walk(out);
  assert.ok(!files.some((f) => f.endsWith('.DS_Store')));
  assert.ok(!files.some((f) => f.endsWith('meta.json')));
});

test('copies the guide page and its screenshots', () => {
  assert.ok(existsSync(join(out, 'guide.html')));
  assert.ok(existsSync(join(out, 'js', 'guide.js')) && existsSync(join(out, 'css', 'guide.css')));
  assert.ok(walk(out).some((f) => f.startsWith('assets/guide/') && f.endsWith('.webp')));
});
