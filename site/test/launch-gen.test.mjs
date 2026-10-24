import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generate, LAUNCH_IDS, POSTER_TIME } from '../scripts/launch-gen/build.mjs';
import { MUSIC_LEVEL, musicStretches, timeline } from '../scripts/launch-gen/timeline.mjs';
import { VO_LINES, voFile } from '../scripts/audio-gen/lines.mjs';
import { isGeneratedMedia, SITE, tempDir, walk } from './helpers.mjs';

test('the launch film is exactly what its generator writes (edit the generator, not the JSON)', () => {
  const out = tempDir('ms-launch-gen-');
  assert.deepEqual(generate(out), [], 'every text width is measured in widths.json');
  for (const id of LAUNCH_IDS) {
    const repo = walk(join(SITE, 'compositions', id)).filter((f) => f !== 'poster.webp' && !isGeneratedMedia(f)).sort();
    assert.deepEqual(walk(join(out, id)).filter((f) => !isGeneratedMedia(f)).sort(), repo, `${id}: files`);
    for (const f of repo) assert.ok(readFileSync(join(out, id, f)).equals(readFileSync(join(SITE, 'compositions', id, f))), `${id}/${f} differs from the generator's output`);
  }
});

test('the launch film: 50 to 75 s at 1920×1080 and 30 fps, one scene per step plus the end card, vector art and the generated picture', () => {
  const dir = join(SITE, 'compositions', 'launch-16x9');
  const c = JSON.parse(readFileSync(join(dir, 'composition.json'), 'utf8'));
  assert.deepEqual([c.width, c.height, c.fps], [1920, 1080, 30]);
  assert.ok(c.duration >= 50 && c.duration <= 75, `${c.duration} s`);
  assert.deepEqual(c.scenes.map((s) => s.id), ['brief', 'variants', 'chat', 'edit', 'brand', 'generate', 'formats', 'languages', 'subtitles', 'identity', 'export', 'endcard']);
  const clips = c.tracks.flatMap((t) => t.clips);
  assert.ok(!clips.some((k) => ['video', 'html'].includes(k.type)), 'no video or html layers');
  assert.deepEqual([...new Set(clips.filter((k) => k.type === 'image').map((k) => k.src))], ['assets/generated-backdrop.jpg'], 'the one raster: the generated backdrop');
  for (const f of readdirSync(join(dir, 'assets'))) if (!isGeneratedMedia(`assets/${f}`) && f !== 'audio') assert.match(f, /\.svg$/, `assets/${f}`);
  const texts = clips.filter((k) => k.type === 'text').map((k) => k.props.text);
  for (const s of ['Brief in.', 'Motion out.', 'github.com/Aleloca/motion-studio', 'Entra il brief.', 'Briefing rein.', 'ブリーフを入れて、', 'Save as v3', 'Generate an asset', 'Generate an image with gpt-image-2', 'Added to Assets']) assert.ok(texts.includes(s), s);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.posterTime, POSTER_TIME);
});

test('the voice-over: every line once, in order, inside its own beat, on the voice track', () => {
  const c = JSON.parse(readFileSync(join(SITE, 'compositions', 'launch-16x9', 'composition.json'), 'utf8'));
  const voice = c.tracks.find((t) => t.id === 'voice');
  assert.equal(voice.kind, 'audio');
  assert.deepEqual(voice.clips.map((k) => k.script), VO_LINES);
  voice.clips.forEach((k, i) => {
    const scene = c.scenes[i];
    assert.equal(k.role, 'voice');
    assert.equal(k.src, `assets/audio/${voFile(i)}`);
    assert.ok(k.start >= scene.start && k.start + k.duration <= scene.start + scene.duration + 0.6, `${k.script}: ${k.start}+${k.duration} in ${scene.id}`);
    if (i) assert.ok(k.start >= voice.clips[i - 1].start + voice.clips[i - 1].duration - 0.6, `${k.script} starts after the line before`);
  });
});

test('the subtitles beat lights each word when the voice says it', () => {
  const c = JSON.parse(readFileSync(join(SITE, 'compositions', 'launch-16x9', 'composition.json'), 'utf8'));
  const TL = timeline();
  const line = TL.vo.find((v) => v.beat === 'subs');
  const lit = c.tracks.flatMap((t) => t.clips).filter((k) => k.id.startsWith('16x9-word-'));
  assert.deepEqual(lit.map((k) => k.props.text), line.words.map((w) => w.text));
  lit.forEach((k, i) => assert.ok(Math.abs(k.start - (line.start + line.words[i].start)) < 0.01, `${k.props.text}: ${k.start}`));
});

test('the music bed ducks under every line: stretches of one level that cross-fade over the same span of the file', () => {
  const vo = [{ start: 1, speechEnd: 2 }, { start: 3.5, speechEnd: 1 }, { start: 10, speechEnd: 3 }];
  const m = musicStretches(vo, 20);
  // The gain at t: the sum of every stretch's level × its fades (linear), as the renderer mixes them.
  const gain = (t) => m.reduce((g, s) => {
    if (t < s.from || t > s.to) return g;
    const fin = Math.min(1, (t - s.from) / s.fadeIn); const fout = Math.min(1, (s.to - t) / s.fadeOut);
    return g + s.level * fin * fout;
  }, 0);
  for (const v of vo) for (let t = v.start; t <= v.start + v.speechEnd; t += 0.05) assert.ok(Math.abs(gain(t) - MUSIC_LEVEL.duck) < 1e-6, `ducked at ${t}`);
  for (const t of [6, 8, 15]) assert.ok(Math.abs(gain(t) - MUSIC_LEVEL.open) < 1e-6, `open at ${t}`);
  for (let i = 1; i < m.length; i++) assert.ok(Math.abs(m[i - 1].to - m[i].from - m[i].fadeIn) < 1e-6 && m[i - 1].fadeOut === m[i].fadeIn, `stretch ${i} cross-fades`);
  assert.equal(m.at(-1).to, 20);
});

test('the timeline: each beat holds its line with room to breathe, and the warp maps the beats onto it', () => {
  const TL = timeline();
  for (const v of TL.vo) {
    const end = TL.T[v.beat] + TL.len[v.beat];
    assert.ok(v.start + v.speechEnd + 0.9 <= end, `${v.beat}: the line ends ${(end - v.start - v.speechEnd).toFixed(2)} s before the beat`);
  }
  for (const b of Object.keys(TL.A)) assert.ok(Math.abs(TL.W(TL.A[b]) - TL.T[b]) < 1e-9, b);
  assert.ok(Math.abs(TL.W(TL.DA) - TL.D) < 1e-9);
  for (const t of [0.5, 10, 33.3, 60]) assert.ok(Math.abs(TL.U(TL.W(t)) - t) < 1e-9, `U(W(${t}))`);
});
