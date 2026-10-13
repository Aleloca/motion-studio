// @vitest-environment node
/**
 * The renderer's store steps in real Chrome and ffmpeg (Phase 12, Task 6, spec §4.2): a store still goes through the flatten
 * step (RGB PNG, colour type 2), and a store preview whose composition has no audio comes out with a silent AAC track.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { readImageInfo } from '../src/store-pack/requirements.ts';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { renderComposition } from '../src/render/renderer.ts';
import { buildRuntime, renderTools } from './helpers/render-env.ts';
import { firstPixel } from './helpers/store-images.ts';

const tools = await renderTools('store render steps (renderer)');
const ff = tools.ffmpeg;
const work = mkdtempSync(join(tmpdir(), 'ms-test-store-render-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const signal = new AbortController().signal;
const streams = (file: string) => (JSON.parse(execFileSync(join(ff!.path, '..', 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate,duration', '-of', 'json', file], { encoding: 'utf8' })) as { streams: Array<Record<string, string | number>> }).streams;

describe.skipIf(!tools.ok)('renderer: store still without alpha, store preview with audio (real Chrome)', { timeout: 300_000 }, () => {
  let dist: string;
  let creative: string;
  beforeAll(async () => {
    dist = join(work, 'dist');
    await buildRuntime(dist);
    creative = join(work, 'creative');
  }, 600_000);

  const comp = (w: number, h: number, duration: number): Composition => ({
    $schema: 'motion-studio/composition@1', width: w, height: h, fps: 30, duration, background: '#00000000', fonts: [],
    scenes: [],
    tracks: [{ id: 'shapes', kind: 'visual', clips: [{ id: 'box', type: 'shape', start: 0, duration, props: { x: 40, y: 40, width: 16, height: 16, fill: '#ff0000' } }] }],
  }) as unknown as Composition;

  it('a store still goes through the flatten step: colour type 2, no temp file left', async () => {
    const format: FormatPreset = { id: 'appstore-iphone-69', channel: 'Test', name: 'Shot', width: 64, height: 96, kind: 'image', extensions: ['png'] };
    mkdirSync(join(creative, 'outputs/v1/compositions', format.id), { recursive: true });
    const out = join(creative, 'outputs/v1', `${format.id}.png`);
    const provider = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 5 * 60_000 } });
    const r = await renderComposition({ dir: creative, versionDir: 'outputs/v1', composition: comp(64, 96, 0), format, out, provider, signal, distDir: dist, ffmpeg: ff!, flattenOnto: '#00ff00' });
    expect(await readImageInfo(out)).toMatchObject({ ok: true, width: 64, height: 96, alpha: false, colorType: 2 });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Chrome paints a transparent page on white and captures RGB; the store step guarantees it whatever engine renders
    // (an Electron provider, a transparent default background): the result is always an RGB PNG of the format size.
    expect(firstPixel(readFileSync(out)).pixel).toHaveLength(3);
    expect(readdirSync(join(creative, 'outputs/v1')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a video without audio clips gets a silent AAC track when storeAudio is set', async () => {
    const format: FormatPreset = { id: 'appstore-preview', channel: 'Test', name: 'Preview', width: 64, height: 128, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 400 };
    mkdirSync(join(creative, 'outputs/v1/compositions', format.id), { recursive: true });
    const out = join(creative, 'outputs/v1', `${format.id}.mp4`);
    const provider = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 5 * 60_000 } });
    const r = await renderComposition({ dir: creative, versionDir: 'outputs/v1', composition: comp(64, 128, 1), format, out, provider, signal, distDir: dist, ffmpeg: ff!, encoder: 'libx264', parallel: 1, storeAudio: true });
    expect(r.audio).toBe(true);
    expect(r.frames).toBe(30);
    const s = streams(out);
    expect(s.find((x) => x.codec_type === 'audio')).toMatchObject({ codec_name: 'aac', channels: 2 });
  });
});
