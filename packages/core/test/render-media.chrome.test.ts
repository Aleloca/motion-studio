// @vitest-environment node
/**
 * The renderer end to end in real headless Chrome and ffmpeg (plan Review Focus 3, and the concat seams):
 * - videos at 24 and 25 fps and a variable-frame-rate one in a 30 fps composition, a `trimStart`, and a clip ending exactly
 *   at the composition end: every output frame shows the expected source frame (frame-coded sources);
 * - 69 frames over 4 parallel segments: the output has exactly 69 frames, each the right one (no duplicate, no gap);
 * - audio placed to the sample (onsets within 1 sample after AAC, a 44.1 kHz source included), cut at the clip end when the source is longer, fine
 *   when it is shorter, and a clip ending exactly at the composition end;
 * - a still (`duration` 0) gives a PNG;
 * - nothing is left behind: no process of the browser group, no ffmpeg, no temp file.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { decodePng } from '../../composition-runtime/test/support/png.ts';
import { sourceFrameIndex, videoSourceTime, VFR_NUDGE } from '../../composition-runtime/src/timing.ts';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { renderComposition } from '../src/render/renderer.ts';
import { checkVideotoolbox } from '../src/render/encode.ts';
import { buildRuntime, burstWav, decodeAudio, decodeStrips, frameCodedVideo, framePts, leftovers, onset, readCode, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('renderer media tests');

const W = 320, H = 180, FPS = 30, DURATION = 2.3, FRAMES = 69;
const FORMAT: FormatPreset = { id: 'test-video', channel: 'Test', name: 'Test', width: W, height: H, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 };
const STILL: FormatPreset = { ...FORMAT, id: 'test-still', kind: 'image', extensions: ['png'] };
const VERSION_DIR = 'outputs/v1';
/** The VFR source: frames 0–9 every 1/24 s, then every 1/30 s… then every 1/12 s (seconds per frame index n). */
const VFR_PTS = 'if(lt(N,10),N/24,if(lt(N,30),10/24+(N-10)/30,10/24+20/30+(N-30)/12))';

const BOXES = {
  v24: { x: 0, y: 0, width: 80, height: 80 },
  v25: { x: 80, y: 0, width: 80, height: 80 },
  vfr: { x: 160, y: 0, width: 80, height: 80 },
  trim: { x: 240, y: 0, width: 80, height: 80 },
  seam: { x: 0, y: 100, width: 320, height: 80 },
};
const CLIPS = {
  v24: { start: 0, duration: DURATION, sourceFps: 24 },
  v25: { start: 0.3, duration: 2.0, sourceFps: 25 }, // ends exactly at the composition end
  vfr: { start: 0, duration: DURATION },
  trim: { start: 0.5, duration: 1.5, trimStart: 0.4, sourceFps: 24 },
  seam: { start: 0, duration: DURATION, sourceFps: 30 },
};

describe.skipIf(!tools.ok)('renderer: media timing, seams, audio, still', () => {
  let work: string;
  let dist: string;
  let creative: string;
  let compDir: string;
  let vfrTimes: number[];
  let result: Awaited<ReturnType<typeof renderComposition>>;
  let provider: ChromeProvider;
  let renderTemp: string;
  const loads: number[] = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-render-media-'));
    dist = join(work, 'dist');
    await buildRuntime(dist);
    creative = join(work, 'creative');
    compDir = join(creative, VERSION_DIR, 'compositions', FORMAT.id);
    const ff = tools.ffmpeg!;
    // Frame-coded sources; the code shown is the source frame index + 1, so 0 (black) means "not visible".
    frameCodedVideo(ff, join(compDir, 'assets', 'v24.mp4'), { fps: 24, frames: 72 });
    frameCodedVideo(ff, join(compDir, 'assets', 'v25.mp4'), { fps: 25, frames: 75 });
    frameCodedVideo(ff, join(compDir, 'assets', 'v30.mp4'), { fps: 30, frames: 75 });
    frameCodedVideo(ff, join(compDir, 'assets', 'vfr.mp4'), { fps: 30, frames: 60, pts: VFR_PTS });
    vfrTimes = framePts(ff, join(compDir, 'assets', 'vfr.mp4'));
    // Audio: a burst at 0.25 s of a 1 s file; a 2 s file bursting from 1.0 to 1.6 s (longer than its clip); a 0.2 s file
    // bursting from 0.1 s to its end (shorter than its clip).
    burstWav(ff, join(compDir, 'assets', 'a1.wav'), { seconds: 1, at: 0.25, burst: 0.05 });
    burstWav(ff, join(compDir, 'assets', 'a2.wav'), { seconds: 2, at: 1.0, burst: 0.6 });
    burstWav(ff, join(compDir, 'assets', 'a3.wav'), { seconds: 0.2, at: 0.1 });
    // A 44.1 kHz source (resampled to 48 kHz by the mix): its burst starts at 0.3 s, exactly sample 13230.
    burstWav(ff, join(compDir, 'assets', 'a4.wav'), { seconds: 1, at: 0.3, burst: 0.05, rate: 44_100 });
    readdirSync(compDir); // exists
  }, 600_000);

  afterAll(async () => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const composition = (): Composition => {
    const video = (id: keyof typeof CLIPS, src: string) => ({ id, type: 'video', src, ...CLIPS[id], props: { ...BOXES[id] } });
    return {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: FPS, duration: DURATION, background: '#000000', fonts: [],
      scenes: [{ id: 'all', start: 0, duration: DURATION }],
      tracks: [
        { id: 'videos', kind: 'video', clips: [video('v24', 'assets/v24.mp4'), video('v25', 'assets/v25.mp4'), video('vfr', 'assets/vfr.mp4'), video('trim', 'assets/v24.mp4'), video('seam', 'assets/v30.mp4')] },
        { id: 'audio', kind: 'audio', clips: [
          { id: 'a1', type: 'audio', src: 'assets/a1.wav', start: 0.5, duration: 1 },
          { id: 'a2', type: 'audio', src: 'assets/a2.wav', start: 1.2, duration: 0.5, trimStart: 0.6 },
          { id: 'a3', type: 'audio', src: 'assets/a3.wav', start: 1.9, duration: 0.4 },
          { id: 'a4', type: 'audio', src: 'assets/a4.wav', start: 0.85, duration: 0.6 },
        ] },
      ],
    } as unknown as Composition;
  };

  it('renders 69 frames over 4 segments; every frame shows the right source frame', async () => {
    provider = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 30 * 60_000 } });
    renderTemp = join(work, 'render-temp');
    mkdirSync(renderTemp);
    const progress: number[] = [];
    loads.push(loadavg()[0]!);
    const t0 = Date.now();
    result = await renderComposition({
      dir: creative, versionDir: VERSION_DIR, composition: composition(), format: FORMAT, out: join(creative, VERSION_DIR, `${FORMAT.id}.mp4`),
      provider, parallel: 4, signal: new AbortController().signal, onProgress: (p) => progress.push(p.frames), distDir: dist,
      ffmpeg: tools.ffmpeg!, encoder: 'libx264', tempDir: renderTemp,
    }).catch((e) => { console.error('STDERR', provider.stderr.slice(-4000)); throw e; });
    loads.push(loadavg()[0]!);
    if (process.env.MS_RENDER_DEBUG) console.info(`[render] ${FRAMES} frames ${W}x${H}, 4 pages: ${((Date.now() - t0) / 1000).toFixed(1)} s, load ${loads.map((l) => l.toFixed(0)).join('→')}`);
    expect(result).toMatchObject({ file: join(creative, VERSION_DIR, `${FORMAT.id}.mp4`), width: W, height: H, durationSec: DURATION, frames: FRAMES, encoder: 'libx264', audio: true });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.warnings).toEqual([]); // every declared sourceFps is right (the VFR clip declares none)
    expect(progress.at(-1)).toBe(FRAMES);

    const ff = tools.ffmpeg!;
    // +faststart: the index (moov) comes before the media data; H.264 yuv420p tagged BT.709; AAC audio.
    const head = readFileSync(result.file).subarray(0, 64 * 1024).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat') < 0 ? Infinity : head.indexOf('mdat'));
    const probe = JSON.parse(execFileSync(join(ff.path, '..', 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,color_space,sample_rate,bit_rate', '-of', 'json', result.file], { encoding: 'utf8' })) as { streams: Array<Record<string, string>> };
    expect(probe.streams.map((x) => x.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(probe.streams.find((x) => x.codec_name === 'h264')).toMatchObject({ pix_fmt: 'yuv420p', color_space: 'bt709' });
    expect(probe.streams.find((x) => x.codec_name === 'aac')).toMatchObject({ sample_rate: '48000' });
    const strips = (box: keyof typeof BOXES) => decodeStrips(ff, result.file, BOXES[box], 2).map(readCode);
    const seam = strips('seam');
    // Seams: exactly 69 frames, frame i shows source frame i (code i + 1).
    expect(seam).toEqual(Array.from({ length: FRAMES }, (_, i) => i + 1));

    const expected = (id: 'v24' | 'v25' | 'trim', i: number) => {
      const t = i / FPS;
      const c = CLIPS[id];
      if (t < c.start - 1e-6) return 0;
      return sourceFrameIndex(videoSourceTime(c, t), c.sourceFps) + 1;
    };
    const expectedVfr = (i: number) => {
      const s = i / FPS + VFR_NUDGE;
      let n = 0;
      for (let k = 0; k < vfrTimes.length; k++) if (vfrTimes[k]! <= s + 1e-9) n = k;
      return n + 1;
    };
    const frames = Array.from({ length: FRAMES }, (_, i) => i);
    if (process.env.MS_RENDER_DEBUG) {
      for (const [id, exp] of [['v24', frames.map((i) => expected('v24', i))], ['v25', frames.map((i) => expected('v25', i))], ['trim', frames.map((i) => (i / FPS >= CLIPS.trim.start + CLIPS.trim.duration - 1e-6 ? 0 : expected('trim', i)))], ['vfr', frames.map(expectedVfr)]] as const) {
        const got = strips(id);
        console.info(id, got.map((g, i) => (g === exp[i] ? '.' : `[${i}:${g}≠${exp[i]}]`)).join(''));
      }
    }
    expect(strips('v24')).toEqual(frames.map((i) => expected('v24', i)));
    expect(strips('v25')).toEqual(frames.map((i) => expected('v25', i)));
    expect(strips('trim')).toEqual(frames.map((i) => (i / FPS >= CLIPS.trim.start + CLIPS.trim.duration - 1e-6 ? 0 : expected('trim', i))));
    expect(strips('vfr')).toEqual(frames.map(expectedVfr));
    // The 25 fps clip ends exactly with the composition: still visible on the last frame.
    expect(strips('v25').at(-1)).toBeGreaterThan(0);
  }, 1_800_000);

  it('places audio to the sample after AAC, cuts a longer source at its clip end, and lasts exactly the composition', () => {
    const x = decodeAudio(tools.ffmpeg!, result.file);
    const sr = 48_000;
    const at = (sec: number) => Math.round(sec * sr);
    const quiet = (a: number, b: number) => { let m = 0; for (let i = at(a); i < at(b); i++) m = Math.max(m, Math.abs(x[i]!)); return m; };
    const onsets = { a1: onset(x, at(0.6)) - at(0.75), a4: onset(x, at(1.0)) - at(1.15), a2: onset(x, at(1.5)) - at(1.6), a3: onset(x, at(1.9)) - at(2.0) };
    if (process.env.MS_RENDER_DEBUG) console.info(`[render] audio onset errors (samples): ${JSON.stringify(onsets)}; decoded length ${x.length} (expected ${at(DURATION)})`);
    for (const err of Object.values(onsets)) expect(Math.abs(err)).toBeLessThanOrEqual(1);
    expect(quiet(0, 0.7)).toBeLessThan(0.05); // nothing before the first burst
    expect(quiet(0.85, 1.1)).toBeLessThan(0.05); // a1's burst is 50 ms
    expect(quiet(1.25, 1.55)).toBeLessThan(0.05); // so is a4's (44.1 kHz) at 1.15 s
    // a2's source keeps bursting until 1.6 s of the file (= 2.2 s of the composition): cut at its clip end, 1.7 s.
    expect(quiet(1.72, 1.98)).toBeLessThan(0.05);
    // a3 is 0.2 s long in a 0.4 s clip: its burst plays from 2.0 to 2.1 s, then silence to the end.
    expect(quiet(2.0, 2.09)).toBeGreaterThan(0.3);
    expect(quiet(2.12, 2.29)).toBeLessThan(0.05);
    // AAC decodes whole 1024-sample frames: the tail may carry up to one frame of padding (silence).
    expect(x.length).toBeGreaterThanOrEqual(at(DURATION));
    expect(x.length - at(DURATION)).toBeLessThan(1024);
  });

  it('left nothing behind: no browser process, no temp output, no work folder', async () => {
    expect(await leftovers({ pgids: [provider.pgid!], markers: [provider.profileDir!, renderTemp] })).toEqual([]);
    expect(readdirSync(renderTemp)).toEqual([]);
    expect(existsSync(provider.profileDir!)).toBe(false);
    expect(readdirSync(join(creative, VERSION_DIR)).sort()).toEqual(['compositions', `${FORMAT.id}.mp4`]);
  });

  it('macOS: with `auto`, VideoToolbox is used only behind its quality check; its segments join exactly too', async () => {
    const ff = tools.ffmpeg!;
    const check = await checkVideotoolbox(ff, W, H, FPS, 800);
    if (process.env.MS_RENDER_DEBUG) console.info(`[render] ffmpeg ${ff.version} ${ff.arch}${ff.translated ? ' (Rosetta)' : ''}; VideoToolbox check: ${JSON.stringify(check)}`);
    const p = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 30 * 60_000 } });
    const out = join(creative, VERSION_DIR, `${FORMAT.id}-auto.mp4`);
    const r = await renderComposition({ dir: creative, versionDir: VERSION_DIR, composition: composition(), format: FORMAT, out, provider: p, parallel: 3, signal: new AbortController().signal, distDir: dist, ffmpeg: ff, encoder: 'auto' });
    expect(r.encoder).toBe(check.ok ? 'h264_videotoolbox' : 'libx264');
    expect(decodeStrips(ff, out, BOXES.seam, 2).map(readCode)).toEqual(Array.from({ length: FRAMES }, (_, i) => i + 1));
    rmSync(out);
  }, 1_800_000);

  it('a wrong declared sourceFps or a source starting at 0.1 s render the frames Chrome shows, never a stall; only a target before the first frame warns', async () => {
    // A: a 25 fps file declared as 30 fps. B: a file whose first frame is at 0.1 s, declared without sourceStart.
    // C: the same file with sourceStart 0.1 (what the core will set from ffprobe, Task 5): exact.
    const ff = tools.ffmpeg!;
    const id = 'test-declared';
    const dir = join(creative, VERSION_DIR, 'compositions', id);
    frameCodedVideo(ff, join(dir, 'assets', 'v25.mp4'), { fps: 25, frames: 40 });
    frameCodedVideo(ff, join(dir, 'assets', 'late.mp4'), { fps: 30, frames: 45, offset: 0.1 });
    const late = framePts(ff, join(dir, 'assets', 'late.mp4'));
    expect(late[0]).toBeCloseTo(0.1, 6);
    const D = 1;
    const comp = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: FPS, duration: D, background: '#000000', fonts: [],
      scenes: [{ id: 'all', start: 0, duration: D }],
      tracks: [{ id: 'v', kind: 'video', clips: [
        { id: 'a', type: 'video', src: 'assets/v25.mp4', start: 0, duration: D, sourceFps: 30, props: { ...BOXES.v24 } },
        { id: 'b', type: 'video', src: 'assets/late.mp4', start: 0, duration: D, sourceFps: 30, props: { ...BOXES.v25 } },
        { id: 'c', type: 'video', src: 'assets/late.mp4', start: 0, duration: D, sourceFps: 30, sourceStart: 0.1, props: { ...BOXES.vfr } },
      ] }],
    } as unknown as Composition;
    const p = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 30 * 60_000 } });
    const out = join(creative, VERSION_DIR, `${id}.mp4`);
    const r = await renderComposition({ dir: creative, versionDir: VERSION_DIR, composition: comp, format: { ...FORMAT, id }, out, provider: p, parallel: 2, signal: new AbortController().signal, distDir: dist, ffmpeg: ff, encoder: 'libx264' });
    const frames = Array.from({ length: Math.round(D * FPS) }, (_, i) => i);
    const target = (i: number) => (i + 0.5) / FPS; // what the declared 30 fps (and no sourceStart) asks for
    // A: Chrome shows the 25 fps frame containing the target.
    expect(decodeStrips(ff, out, BOXES.v24, 2).map(readCode)).toEqual(frames.map((i) => Math.floor(target(i) * 25 + 1e-9) + 1));
    // B: the frame at or before the target on the media timeline (the first one before 0.1 s).
    const shownLate = (t: number) => { let k = 0; for (let j = 0; j < late.length; j++) if (late[j]! <= t + 1e-9) k = j; return k + 1; };
    if (process.env.MS_RENDER_DEBUG) console.info('[render] B got', decodeStrips(ff, out, BOXES.v25, 2).map(readCode).join(','), 'exp', frames.map((i) => shownLate(target(i))).join(','), 'warnings', JSON.stringify(r.warnings.map((w) => `${w.clipId}:${w.message}`)));
    expect(decodeStrips(ff, out, BOXES.v25, 2).map(readCode)).toEqual(frames.map((i) => shownLate(target(i))));
    // C: sourceStart puts every frame where it belongs.
    expect(decodeStrips(ff, out, BOXES.vfr, 2).map(readCode)).toEqual(frames.map((i) => i + 1));
    // Frames are checked by their own duration: the wrong declared rate (A) is not even a warning. Only B's targets before
    // its first frame (0.1 s) warn: the first frame is drawn for them.
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.every((w) => w.code === 'videoFrameMismatch' && w.clipId === 'b' && /first frame at 0\.100/.test(w.message))).toBe(true);
    rmSync(out);
  }, 1_800_000);

  it('renders a still (duration 0) as one PNG of the format size', async () => {
    const stillDir = join(creative, VERSION_DIR, 'compositions', STILL.id);
    mkdirSync(stillDir, { recursive: true });
    const still = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: FPS, duration: 0, background: '#102030', fonts: [], scenes: [],
      tracks: [{ id: 't', kind: 'visual', clips: [{ id: 's', type: 'shape', start: 0, duration: 0, props: { x: 100, y: 50, width: 60, height: 40, fill: '#ff8000' } }] }],
    } as unknown as Composition;
    const p = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 10 * 60_000 } });
    const out = join(creative, VERSION_DIR, `${STILL.id}.png`);
    const r = await renderComposition({ dir: creative, versionDir: VERSION_DIR, composition: still, format: STILL, out, provider: p, signal: new AbortController().signal, distDir: dist });
    expect(r).toMatchObject({ file: out, width: W, height: H, durationSec: null, frames: 1, encoder: null });
    const img = decodePng(readFileSync(out));
    expect([img.w, img.h]).toEqual([W, H]);
    const near = (a: readonly number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 2);
    expect(near(img.px(130, 70), [0xff, 0x80, 0x00])).toBe(true);
    expect(near(img.px(10, 10), [0x10, 0x20, 0x30])).toBe(true);
    expect(await leftovers({ pgids: [p.pgid!], markers: [p.profileDir!] })).toEqual([]);
  }, 900_000);
});
