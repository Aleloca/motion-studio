import { mkdtemp, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
import { createFfmpegTools, NoMediaTools } from '../src/media/media-tools.ts';

const hasFfmpeg = (await execCommand('ffmpeg', ['-version'])).code === 0;

// Probed paths must be regular files (M6): real placeholders under the OS temp folder.
const PH = mkdtempSync(join(tmpdir(), 'ms-test-mt-'));
const ph = (name: string) => { const f = join(PH, name); writeFileSync(f, 'x'); return f; };
afterAll(() => { rmSync(PH, { recursive: true, force: true }); });

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
    expect(await tools.probe(ph('x.mp4'))).toEqual({ width: 1080, height: 1920, durationSec: 15.04 });
  });
  it('treats still images as having no duration', async () => {
    const exec: CommandExec = async (_c, args) => args.includes('-version')
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', width: 300, height: 250 }], format: { duration: '0.04' } }), stderr: '', notFound: false };
    expect(await (await createFfmpegTools(exec)).probe(ph('x.png'))).toEqual({ width: 300, height: 250, durationSec: null });
  });
  it('returns null for unreadable files', async () => {
    const exec: CommandExec = async (_c, args) => args.includes('-version')
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : { code: 1, stdout: '', stderr: 'Invalid data', notFound: false };
    expect(await (await createFfmpegTools(exec)).probe(ph('y.mp4'))).toBeNull();
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

describe.skipIf(process.platform === 'win32')('special files (M6)', () => {
  it('a FIFO, a socket or a device is never handed to ffmpeg, and the sniff never waits', async () => {
    const { execFileSync } = await import('node:child_process');
    const { createServer } = await import('node:net');
    const { stillDemuxer, isRegularFileNow } = await import('../src/media/ffmpeg-exec.ts');
    const fifo = join(PH, 'pipe.jpg');
    execFileSync('mkfifo', [fifo]);
    const sock = join(PH, 's.mp4');
    const server = createServer();
    await new Promise<void>((r) => server.listen(sock, () => r()));
    try {
      const calls: string[][] = [];
      const exec: CommandExec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '{}', stderr: '', notFound: false }; };
      const tools = await createFfmpegTools(exec);
      calls.length = 0;
      const t0 = performance.now();
      for (const f of [fifo, sock, '/dev/zero']) {
        expect(await tools.probe(f), f).toBeNull();
        expect(await tools.frame(f, join(PH, 'o.jpg'), 0), f).toBe(false);
        expect(isRegularFileNow(f), f).toBe(false);
      }
      // The still sniff of a FIFO named .jpg returns without waiting for a writer.
      expect(stillDemuxer(fifo)).toBeNull();
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(calls).toEqual([]);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});
