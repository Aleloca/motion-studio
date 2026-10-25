import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generate, GALLERY_IDS } from '../scripts/gallery-gen/build.mjs';
import { SITE, tempDir, walk } from './helpers.mjs';

test('the gallery\'s compositions are exactly what the generator writes (edit the generator, not the JSON)', () => {
  const out = tempDir('ms-gallery-gen-');
  const { ids, missing } = generate(out);
  assert.deepEqual(missing, [], 'every text width is measured in widths.json');
  assert.deepEqual(ids, GALLERY_IDS);
  for (const id of ids) {
    const repo = walk(join(SITE, 'compositions', id)).filter((f) => !f.startsWith('poster')).sort();
    assert.deepEqual(walk(join(out, id)).sort(), repo, `${id}: files`);
    for (const f of repo) assert.ok(readFileSync(join(out, id, f)).equals(readFileSync(join(SITE, 'compositions', id, f))), `${id}/${f} differs from the generator's output`);
  }
});

test('nine creatives, each its own topic, palette and display face, across the four formats', () => {
  const comps = GALLERY_IDS.map((id) => ({ id, c: JSON.parse(readFileSync(join(SITE, 'compositions', id, 'composition.json'), 'utf8')), m: JSON.parse(readFileSync(join(SITE, 'compositions', id, 'meta.json'), 'utf8')) }));
  assert.equal(comps.length, 9);
  assert.equal(new Set(comps.map(({ c }) => c.background)).size, 9, 'one background each');
  const formats = comps.map(({ m }) => m.format);
  for (const f of ['instagram-reel-9x16', 'instagram-post-4x5', 'instagram-post-1x1', 'youtube-16x9']) assert.ok(formats.filter((x) => x === f).length >= 2, f);
  // The largest text of each creative (its display face and weight) is not the same twice.
  const display = comps.map(({ c }) => {
    const big = c.tracks.flatMap((t) => t.clips).filter((k) => k.type === 'text').sort((a, b) => b.props.fontSize - a.props.fontSize)[0];
    return `${big.props.fontFamily} ${big.props.fontWeight}`;
  });
  assert.ok(new Set(display).size >= 6, display.join(', '));
});

test('the gallery\'s display faces are self-hosted with their SIL OFL licence', () => {
  const fonts = readdirSync(join(SITE, 'src', 'assets', 'fonts'));
  for (const f of fonts.filter((n) => n.endsWith('.woff2'))) {
    const licence = `OFL-${f.replace('.woff2', '')}.txt`;
    assert.ok(fonts.includes(licence), licence);
    assert.match(readFileSync(join(SITE, 'src', 'assets', 'fonts', licence), 'utf8'), /SIL Open Font License, Version 1\.1/);
  }
  for (const face of ['Fraunces', 'Anton', 'Caveat']) assert.ok(fonts.includes(`${face}.woff2`), face);
});
