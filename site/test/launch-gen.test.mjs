import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generate, LAUNCH_IDS, POSTER_TIME } from '../scripts/launch-gen/build.mjs';
import { SITE, tempDir, walk } from './helpers.mjs';

test('the launch film is exactly what its generator writes (edit the generator, not the JSON)', () => {
  const out = tempDir('ms-launch-gen-');
  assert.deepEqual(generate(out), [], 'every text width is measured in widths.json');
  for (const id of LAUNCH_IDS) {
    const repo = walk(join(SITE, 'compositions', id)).filter((f) => f !== 'poster.webp').sort();
    assert.deepEqual(walk(join(out, id)).sort(), repo, `${id}: files`);
    for (const f of repo) assert.ok(readFileSync(join(out, id, f)).equals(readFileSync(join(SITE, 'compositions', id, f))), `${id}/${f} differs from the generator's output`);
  }
});

test('the launch film: 45 to 60 s at 1920×1080 and 30 fps, one scene per step plus the end card, vector art only', () => {
  const dir = join(SITE, 'compositions', 'launch-16x9');
  const c = JSON.parse(readFileSync(join(dir, 'composition.json'), 'utf8'));
  assert.deepEqual([c.width, c.height, c.fps], [1920, 1080, 30]);
  assert.ok(c.duration >= 45 && c.duration <= 60, `${c.duration} s`);
  assert.deepEqual(c.scenes.map((s) => s.id), ['brief', 'variants', 'chat', 'edit', 'brand', 'formats', 'languages', 'subtitles', 'identity', 'export', 'endcard']);
  const clips = c.tracks.flatMap((t) => t.clips);
  assert.ok(!clips.some((k) => ['image', 'video', 'audio', 'html'].includes(k.type)), 'no raster, media or html layers');
  for (const f of readdirSync(join(dir, 'assets'))) assert.match(f, /\.svg$/, `assets/${f}`);
  const texts = clips.filter((k) => k.type === 'text').map((k) => k.props.text);
  for (const s of ['Brief in.', 'Motion out.', 'github.com/Aleloca/motion-studio', 'Entra il brief.', 'Briefing rein.', 'ブリーフを入れて、', 'Save as v3']) assert.ok(texts.includes(s), s);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.posterTime, POSTER_TIME);
});
