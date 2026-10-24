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

test('the KOVA 9:16 glow fades out before the top and bottom edges, so both edges are the background colour', () => {
  // The showcase centres the 9:16 film in a taller card on its background colour: a lit edge would end in a seam.
  const comp = JSON.parse(readFileSync(join(SITE, 'compositions', 'kova-9x16', 'composition.json'), 'utf8'));
  const glow = comp.tracks.flatMap((t) => t.clips).find((c) => c.id.startsWith('glow'));
  const { y, height } = glow.props;
  const scale = Math.max(...glow.animations.flatMap((a) => a.keyframes ? a.keyframes.map((k) => k.v) : [a.to ?? 1]));
  const radius = (height / 2) * scale;
  assert.ok(y + height / 2 - radius >= 0, `glow reaches the top edge (scale ${scale})`);
  assert.ok(y + height / 2 + radius <= comp.height, `glow reaches the bottom edge (scale ${scale})`);
});
