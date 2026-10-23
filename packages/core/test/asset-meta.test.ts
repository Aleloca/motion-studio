import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
import { assetWaveform, peaksOf, readAssetMeta, WAVEFORM_PEAKS } from '../src/library/asset-meta.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { createFfmpegTools, displaySize, NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';
import { sourceInfoOf } from '../src/render/media-normalize.ts';
import { ffArgv } from '../src/media/ffmpeg-exec.ts';
import { waveformPcmFilter } from '../src/media/ffmpeg-filters.ts';

const hasFfmpeg = (await execCommand('ffmpeg', ['-version'])).code === 0;

/** A mono 16-bit WAV: `sec` seconds of a sine at `amp` (0..1). */
function wav(sec: number, amp: number, rate = 8000): Buffer {
  const n = Math.round(sec * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('peaksOf', () => {
  it('is bounded to 400 values in 0..1 and keeps each slice maximum', () => {
    const pcm = Buffer.alloc(10_000 * 2);
    pcm.writeInt16LE(32767, 4_000 * 2);
    const peaks = peaksOf(pcm);
    expect(peaks).toHaveLength(WAVEFORM_PEAKS);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks.filter((p) => p > 0)).toHaveLength(1);
    expect(peaksOf(Buffer.alloc(20))).toHaveLength(10);
    expect(peaksOf(Buffer.alloc(0))).toEqual([]);
  });
});

describe('waveformPcmFilter', () => {
  it('is a typed -af mono s16 and refuses wild rates', () => {
    expect(ffArgv('ffmpeg', [waveformPcmFilter(4000)])).toEqual(['-af', 'aresample=4000,aformat=sample_fmts=s16:channel_layouts=mono']);
    expect(() => waveformPcmFilter(0)).toThrow(RangeError);
    expect(() => waveformPcmFilter(1e9)).toThrow(RangeError);
    expect(() => waveformPcmFilter(4000.5)).toThrow(RangeError);
  });
});

describe.skipIf(!hasFfmpeg)('metadata and waveforms with real ffmpeg', () => {
  let project: string;
  let media: MediaTools;
  beforeAll(async () => { media = await createFfmpegTools(); });
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ms-meta è '));
    await mkdir(join(project, 'assets'), { recursive: true });
  });
  const put = async (name: string, data: Buffer | string) => { await writeFile(join(project, 'assets', name), data); return join(project, 'assets', name); };

  it('reads duration, size and bytes for image, video, audio, svg and font', async () => {
    const png = join(project, 'assets', 'p.png');
    await execCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x32:d=1', '-frames:v', '1', png]);
    const mp4 = join(project, 'assets', 'v.mp4');
    await execCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', mp4]);
    const audio = await put('a.wav', wav(1.5, 0.5));
    const svg = await put('s.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>');
    const font = await put('f.woff2', 'not really a font');
    const deps = { media };
    expect(await readAssetMeta(deps, png, 'image')).toMatchObject({ width: 64, height: 32, durationSec: null, bytes: expect.any(Number) });
    const v = await readAssetMeta(deps, mp4, 'video');
    expect(v).toMatchObject({ width: 320, height: 240 });
    expect(v.durationSec).toBeGreaterThan(1.5);
    const a = await readAssetMeta(deps, audio, 'audio');
    expect(a.durationSec).toBeCloseTo(1.5, 1);
    expect(a.bytes).toBe(44 + 1.5 * 8000 * 2);
    expect(await readAssetMeta(deps, svg, 'svg')).toMatchObject({ width: 40, height: 20, durationSec: null });
    expect(await readAssetMeta(deps, font, 'font')).toEqual({ width: null, height: null, durationSec: null, bytes: 17 });
  });

  it('stores the metadata at registration', async () => {
    await put('a.wav', wav(1, 0.5));
    const lib = new LibraryStore(project, media);
    const [entry] = await lib.registerAssets([{ file: 'a.wav', origin: 'upload' }]);
    expect(entry).toMatchObject({ kind: 'audio', bytes: 44 + 16000 });
    expect(entry!.durationSec).toBeCloseTo(1, 1);
  });

  it('fills an old entry once and never reads it again', async () => {
    await put('a.wav', wav(1, 0.5));
    const lib = new LibraryStore(project, media);
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [
      { file: 'a.wav', kind: 'audio', origin: 'upload', sourceUrl: null, description: 'old', tags: [], width: null, height: null, addedAt: '2026-01-01T00:00:00.000Z', attribution: null },
    ] }));
    const first = await lib.fillMissingMeta();
    expect(first.changed).toBe(true);
    expect(first.assets[0]).toMatchObject({ description: 'old', bytes: 16044 });
    let probes = 0;
    const counting: MediaTools = { ...media, probe: async (f) => { probes++; return media.probe(f); }, probeAudio: async (f) => { probes++; return media.probeAudio!(f); } };
    const second = await new LibraryStore(project, counting).fillMissingMeta();
    expect(second.changed).toBe(false);
    expect(probes).toBe(0);
    expect(JSON.parse(await readFile(join(project, 'assets', 'assets.json'), 'utf8')).assets[0].bytes).toBe(16044);
  });

  it('leaves a missing file alone and an unreadable one with nulls', async () => {
    await put('broken.mp4', 'garbage');
    const lib = new LibraryStore(project, media);
    const old = (file: string, kind: string) => ({ file, kind, origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-01-01T00:00:00.000Z', attribution: null });
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [old('gone.png', 'image'), old('broken.mp4', 'video')] }));
    const r = await lib.fillMissingMeta();
    expect(r.assets[0]!.bytes).toBeUndefined();
    expect(r.assets[1]).toMatchObject({ bytes: 7, durationSec: null, width: null });
  });

  it('computes bounded peaks, caches them under .studio/cache/waveforms and removes the PCM', async () => {
    const abs = await put('a.wav', wav(3, 0.8));
    const deps = { media, projectDir: project };
    const peaks = await assetWaveform(deps, 'a.wav', abs);
    expect(peaks.length).toBeGreaterThan(0);
    expect(peaks.length).toBeLessThanOrEqual(WAVEFORM_PEAKS);
    expect(Math.max(...peaks)).toBeGreaterThan(0.5);
    const dir = join(project, '.studio', 'cache', 'waveforms');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    // The second call is served from the cache: a media double that cannot decode still answers.
    const cached = await assetWaveform({ media: { ...NoMediaTools, available: true }, projectDir: project }, 'a.wav', abs);
    expect(cached).toEqual(peaks);
    // A replaced file is decoded again.
    await writeFile(abs, wav(3, 0.1));
    const changed = await assetWaveform(deps, 'a.wav', abs);
    expect(Math.max(...changed)).toBeLessThan(Math.max(...peaks));
  });

  it('refuses a file that is not audio and a cache folder that is a link', async () => {
    const abs = await put('notes.wav', 'not audio');
    await expect(assetWaveform({ media, projectDir: project }, 'notes.wav', abs)).rejects.toMatchObject({ status: 422 });
    expect(await readdir(join(project, '.studio', 'cache', 'waveforms'))).toEqual([]);
    const other = await mkdtemp(join(tmpdir(), 'ms-meta-out '));
    const project2 = await mkdtemp(join(tmpdir(), 'ms-meta2 '));
    await mkdir(join(project2, '.studio', 'cache'), { recursive: true });
    await symlink(other, join(project2, '.studio', 'cache', 'waveforms'));
    await expect(assetWaveform({ media, projectDir: project2 }, 'a.wav', abs)).rejects.toMatchObject({ status: 422 });
    expect(await readdir(other)).toEqual([]);
  });
});

describe('lazy fill without ffmpeg and under concurrency', () => {
  const old = (file: string, kind: string) => ({ file, kind, origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-01-01T00:00:00.000Z', attribution: null });
  it('leaves media unmeasured for a later listing when no media tools exist, and fills a font anyway', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ms-fill '));
    await mkdir(join(project, 'assets'));
    await writeFile(join(project, 'assets', 'p.png'), 'x');
    await writeFile(join(project, 'assets', 'f.woff2'), 'ff');
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [old('p.png', 'image'), old('f.woff2', 'font')] }));
    const r = await new LibraryStore(project, NoMediaTools).fillMissingMeta();
    expect(r.assets[0]!.bytes).toBeUndefined();
    expect(r.assets[1]).toMatchObject({ bytes: 2 });
  });
  it('concurrent listings read each file once', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ms-fill2 '));
    await mkdir(join(project, 'assets'));
    await writeFile(join(project, 'assets', 'a.png'), 'x');
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [old('a.png', 'image')] }));
    let probes = 0;
    const media: MediaTools = { ...NoMediaTools, available: true, probe: async () => { probes++; return { width: 10, height: 10, durationSec: null }; } };
    await Promise.all([1, 2, 3].map(() => new LibraryStore(project, media).fillMissingMeta()));
    expect(probes).toBe(1);
  });
});

describe('display orientation (report 70, round 1)', () => {
  /** An ffprobe that answers `streams` for every file (and its version check). */
  const fakeProbe = (streams: unknown[]): CommandExec => async (_cmd, args) => (args.includes('-version')
    ? { code: 0, stdout: 'ffprobe version 7', stderr: '', notFound: false }
    : { code: 0, stdout: JSON.stringify({ streams, format: { duration: '3.0' } }), stderr: '', notFound: false });
  const file = async () => { const d = await mkdtemp(join(tmpdir(), 'ms-rot-')); const f = join(d, 'v.mp4'); await writeFile(f, 'x'); return f; };

  it('probe gives the shown size by the render normalisation\'s rule: a quarter turn swaps the sides, the SAR widens (round 2, N3)', async () => {
    const f = await file();
    const probe = async (stream: Record<string, unknown>) => (await createFfmpegTools(fakeProbe([{ codec_type: 'video', codec_name: 'h264', ...stream }]))).probe(f);
    const matrix = await probe({ width: 1920, height: 1080, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] });
    expect(matrix).toMatchObject({ width: 1920, height: 1080, display: { width: 1080, height: 1920 } });
    expect(displaySize(matrix!)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize((await probe({ width: 1920, height: 1080, tags: { rotate: '180' } }))!)).toEqual({ width: 1920, height: 1080 });
    const anamorphic = await probe({ width: 1440, height: 1080, sample_aspect_ratio: '4:3' });
    expect(displaySize(anamorphic!)).toEqual({ width: 1920, height: 1080 });
    // The same numbers as the normalisation's own reading of the stream.
    expect(sourceInfoOf({ streams: [{ codec_type: 'video', width: 1440, height: 1080, sample_aspect_ratio: '4:3' }] })).toMatchObject({ width: 1920, height: 1080 });
    const plain = await probe({ width: 1920, height: 1188, sample_aspect_ratio: '1:1' });
    expect(plain?.display).toBeUndefined();
    expect(displaySize(plain!)).toEqual({ width: 1920, height: 1188 });
  });

  it('the library stores a rotated video at the size it is shown', async () => {
    const media: MediaTools = { ...NoMediaTools, available: true, probe: async () => ({ width: 1920, height: 1080, durationSec: 12, display: { width: 1080, height: 1920 } }) };
    expect(await readAssetMeta({ media }, await file(), 'video')).toMatchObject({ width: 1080, height: 1920, durationSec: 12 });
  });
});

describe.skipIf(!hasFfmpeg)('display orientation with real ffmpeg (report 70, round 1)', () => {
  it('a clip stored 320×240 with a quarter-turn display matrix is 240×320 in the library', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ms-rot-real-'));
    const plain = join(d, 'plain.mp4'), turned = join(d, 'turned.mp4');
    await execCommand('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-pix_fmt', 'yuv420p', plain]);
    await execCommand('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', plain, '-c', 'copy', turned]);
    const media = await createFfmpegTools();
    expect((await media.probe(turned))?.display).toEqual({ width: 240, height: 320 });
    expect(await readAssetMeta({ media }, turned, 'video')).toMatchObject({ width: 240, height: 320 });
    expect(await readAssetMeta({ media }, plain, 'video')).toMatchObject({ width: 320, height: 240 });
  });
});
