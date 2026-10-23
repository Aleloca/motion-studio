import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, HERO_IDS } from '../scripts/hero-gen/build.mjs';
import { SITE, tempDir, walk } from './helpers.mjs';

test('the hero compositions are exactly what the generator writes (edit the generator, not the JSON)', () => {
  const out = tempDir('ms-hero-gen-');
  assert.deepEqual(generate(out), [], 'every text width is measured in widths.json');
  for (const id of HERO_IDS) {
    const repo = walk(join(SITE, 'compositions', id)).filter((f) => f !== 'poster.webp').sort();
    assert.deepEqual(walk(join(out, id)).sort(), repo, `${id}: files`);
    for (const f of repo) assert.ok(readFileSync(join(out, id, f)).equals(readFileSync(join(SITE, 'compositions', id, f))), `${id}/${f} differs from the generator's output`);
  }
});
