// @vitest-environment node
/**
 * A render at another resolution and quality (decision 974), in real Chrome and ffmpeg: the output has the scaled size and
 * every frame, the encoder that ran is reported, and the page is rasterised at the scale (a 1 px line of the composition is
 * 2 px of solid white at 2x, not the blur of an upscaled frame). Report 39: another frame rate gives round(duration × fps)
 * frames at that rate, each sampled at its own time (no repeated frame). Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { countVideoFrames } from '../src/render/encode.ts';
import { renderComposition, type RenderCompositionOptions } from '../src/render/renderer.ts';
import { buildRuntime, decodeStrips, put, renderTools } from './helpers/render-env.ts';

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
    // A layer whose grey is its own time (one step of 4 per 1/60 s), filling the whole frame.
    put(join(creative, VERSION_DIR, 'compositions', 'q', 'layers', 'clock.html'), `<!doctype html><html><body style="margin:0"><div id="b" style="position:absolute;inset:0"></div><script>
const b = document.getElementById('b');
window.msSeek = (t) => { const g = Math.min(255, Math.round(t * 60) * 4); b.style.background = 'rgb(' + g + ',' + g + ',' + g + ')'; };
</script></body></html>`);
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

  /** The video stream's frame rate and frame count (ffprobe). */
  const probe = (file: string) => {
    const out = execFileSync(join(tools.ffmpeg!.path, '..', 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=r_frame_rate,nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const [rate, frames] = out.trim().split(',');
    return { rate, frames: Number(frames) };
  };
  const clockComposition = (): Composition => ({ ...composition(), tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'c', type: 'html', src: 'layers/clock.html', start: 0, duration: 0.5, props: { x: 0, y: 0, width: W, height: H } }] }] } as unknown as Composition);

  it('report 39: at 60 fps a 0.5 s composition of 30 fps is 30 frames at 60/1, every frame its own time; at 24 fps 12 frames', async () => {
    const { r, out } = await render('fps60', { fps: 60, quality: 'max', composition: clockComposition() });
    expect([r.frames, r.fps, r.durationSec]).toEqual([30, 60, 0.5]);
    expect(probe(out)).toEqual({ rate: '60/1', frames: 30 });
    const greys = decodeStrips(tools.ffmpeg!, out, { x: 100, y: 60, width: 40, height: 40 }, 1).map((s) => s[0]!);
    expect(greys).toHaveLength(30);
    // Frame i shows t = i / 60: grey 4i (within the encode's rounding), so no frame repeats the one before.
    greys.forEach((g, i) => expect(Math.abs(g - 4 * i), `frame ${i}: ${g}`).toBeLessThanOrEqual(2));
    const low = await render('fps24', { fps: 24, composition: clockComposition() });
    expect([low.r.frames, low.r.fps]).toEqual([12, 24]);
    expect(probe(low.out)).toEqual({ rate: '24/1', frames: 12 });
  });
});
