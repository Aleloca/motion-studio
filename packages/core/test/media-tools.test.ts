import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
import { createFfmpegTools, NoMediaTools } from '../src/media/media-tools.ts';

const hasFfmpeg = (await execCommand('ffmpeg', ['-version'])).code === 0;

describe('createFfmpegTools', () => {
  it('returns NoMediaTools when ffprobe is missing', async () => {
    const exec: CommandExec = async () => ({ code: -1, stdout: '', stderr: '', notFound: true });
    expect(await createFfmpegTools(exec)).toBe(NoMediaTools);
  });
  it('parses ffprobe JSON', async () => {
    const exec: CommandExec = async (cmd, args) => {
      if (args.includes('-version')) return { code: 0, stdout: 'ffprobe version 8', stderr: '', notFound: false };
      return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920 }], format: { duration: '15.04' } }), stderr: '', notFound: false };
    };
    const tools = await createFfmpegTools(exec);
    expect(await tools.probe('/x.mp4')).toEqual({ width: 1080, height: 1920, durationSec: 15.04 });
  });
  it('treats still images as having no duration', async () => {
    const exec: CommandExec = async (_c, args) => args.includes('-version')
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', width: 300, height: 250 }], format: { duration: '0.04' } }), stderr: '', notFound: false };
    expect(await (await createFfmpegTools(exec)).probe('/x.png')).toEqual({ width: 300, height: 250, durationSec: null });
  });
  it('returns null for unreadable files', async () => {
    const exec: CommandExec = async (_c, args) => args.includes('-version')
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : { code: 1, stdout: '', stderr: 'Invalid data', notFound: false };
    expect(await (await createFfmpegTools(exec)).probe('/x.mp4')).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)('with real ffmpeg', () => {
  it('probes a generated video and extracts a poster', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-media è '));
    const video = join(dir, 'clip.mp4');
    await execCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', video]);
    const tools = await createFfmpegTools();
    const info = await tools.probe(video);
    expect(info).toMatchObject({ width: 320, height: 240 });
    expect(info!.durationSec).toBeGreaterThan(1.5);
    const poster = join(dir, '.previews', 'clip.jpg');
    expect(await tools.poster(video, poster)).toBe(true);
    expect((await stat(poster)).size).toBeGreaterThan(0);
  });
});

describe('NoMediaTools', () => {
  it('is inert', async () => {
    expect(NoMediaTools.available).toBe(false);
    expect(await NoMediaTools.probe('/x')).toBeNull();
    expect(await NoMediaTools.poster('/x', '/y')).toBe(false);
  });
});
