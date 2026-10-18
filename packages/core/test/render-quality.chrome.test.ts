// @vitest-environment node
/**
 * A render at another resolution and quality (decision 974), in real Chrome and ffmpeg: the output has the scaled size and
 * every frame, the encoder that ran is reported, and the page is rasterised at the scale (a 1 px line of the composition is
 * 2 px of solid white at 2x, not the blur of an upscaled frame). Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { countVideoFrames } from '../src/render/encode.ts';
import { renderComposition, type RenderCompositionOptions } from '../src/render/renderer.ts';
import { buildRuntime, decodeStrips, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('render quality tests');
const W = 320, H = 180;
const VERSION_DIR = 'outputs/v1';
const format: FormatPreset = { id: 'q', channel: 'Test', name: 'q', width: W, height: H, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 };
/** Black, with a 1 px white vertical line at x = 100 (CSS px). */
const composition = (): Composition => ({
  $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 0.5, background: '#000000', fonts: [],
  scenes: [{ id: 's', start: 0, duration: 0.5 }],
  tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'line', type: 'shape', start: 0, duration: 0.5, props: { x: 100, y: 0, width: 1, height: H, fill: '#ffffff' } }] }],
} as unknown as Composition);

describe.skipIf(!tools.ok)('renderer: resolution and quality', { timeout: 300_000 }, () => {
  let work: string;
  let dist: string;
  let creative: string;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-render-quality-'));
    dist = join(work, 'dist');
    await buildRuntime(dist);
    creative = join(work, 'creative');
    mkdirSync(join(creative, VERSION_DIR, 'compositions', 'q'), { recursive: true });
  }, 600_000);
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  const render = async (name: string, o: Partial<RenderCompositionOptions>) => {
    const out = join(creative, VERSION_DIR, `${name}.mp4`);
    const temp = join(work, `tmp-${name}`);
    mkdirSync(temp);
    const r = await renderComposition({
      dir: creative, versionDir: VERSION_DIR, composition: composition(), format, out, parallel: 1, signal: new AbortController().signal,
      provider: new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 10 * 60_000 } }),
      distDir: dist, ffmpeg: tools.ffmpeg!, tempDir: temp, x264Preset: 'ultrafast', ...o,
    });
    return { r, out };
  };

  it('2x (short side 360) is 640×360 with every frame, rasterised at the scale; high runs libx264', async () => {
    const { r, out } = await render('double', { short: 360, quality: 'high' });
    expect([r.width, r.height, r.frames, r.encoder, r.quality]).toEqual([640, 360, 15, 'libx264', 'high']);
    expect(await countVideoFrames(tools.ffmpeg!, out)).toMatchObject({ frames: 15, width: 640, height: 360 });
    // Columns 196..205 of a middle row band: the line is columns 200 and 201, solid; 198 and 203 stay black.
    const strip = decodeStrips(tools.ffmpeg!, out, { x: 196, y: 150, width: 10, height: 60 }, 10)[0]!;
    expect(strip[4]!).toBeGreaterThan(190);
    expect(strip[5]!).toBeGreaterThan(190);
    expect(strip[2]!).toBeLessThan(60);
    expect(strip[7]!).toBeLessThan(60);
  });

  it('an odd scaled side is landed on its even size (480p of 16:9 is 854×480); max encodes PNG frames with libx264', async () => {
    const { r, out } = await render('p480', { short: 480, quality: 'max' });
    expect([r.width, r.height, r.encoder, r.quality]).toEqual([854, 480, 'libx264', 'max']);
    expect(await countVideoFrames(tools.ffmpeg!, out)).toMatchObject({ frames: 15, width: 854, height: 480 });
  });

  it('without a resolution the format size; standard as before', async () => {
    const { r } = await render('own', { quality: 'standard', encoder: 'libx264' });
    expect([r.width, r.height, r.quality]).toEqual([W, H, 'standard']);
  });
});
