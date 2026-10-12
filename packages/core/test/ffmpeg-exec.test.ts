// @vitest-environment node
/**
 * Final review I1: every ffmpeg/ffprobe the core starts goes through `media/ffmpeg-exec.ts`, which gives every input a
 * protocol and a format whitelist. A file whose bytes are a playlist or a concat script (named `.mp4`) must not make ffmpeg
 * read another file or fetch a URL: no canary hit, no sentinel read, a clean refusal.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition } from '@motion-studio/shared';
import { assertSafeInputs, ffKindOf, mediaInput, ownInput } from '../src/media/ffmpeg-exec.ts';
import { createFfmpegTools } from '../src/media/media-tools.ts';
import { findFfmpeg, type FfmpegInfo } from '../src/render/encode.ts';
import { mixAudio } from '../src/render/audio-mix.ts';
import { MediaNormalizer } from '../src/render/media-normalize.ts';
import { RenderError } from '../src/render/errors.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const HELPER = join('media', 'ffmpeg-exec.ts');

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
/** The source without comments (block and line), strings kept. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

describe('ffmpeg-exec: whitelists on every input', () => {
  it('media inputs carry the fd or file protocol and the accepted demuxers only', () => {
    expect(mediaInput({ fd: 3 })).toEqual(['-protocol_whitelist', 'fd', '-format_whitelist', expect.stringContaining('mov'), '-fd', '3', '-i', 'fd:']);
    const file = mediaInput({ file: '/x/a.mp4' });
    expect(file.slice(0, 2)).toEqual(['-protocol_whitelist', 'file']);
    for (const bad of ['hls', 'dash', 'concat', 'tty', 'sdp', 'rtsp', 'lavfi', 'ffmetadata', 'data', 'image2pipe']) expect(file[3]!.split(',')).not.toContain(bad);
    // image2 reads one file only: never with a descriptor, a sequence pattern or a glob character in the path.
    expect(file[3]!.split(',')).toContain('image2');
    for (const p of ['/x/a%d.png', '/x%/a.png', '/x/a*.png', '/x/a?.png', '/x/[a].png', '/x/{a}.png']) expect(mediaInput({ file: p })[3]!.split(','), p).not.toContain('image2');
    expect(mediaInput({ fd: 3 })[3]!.split(',')).not.toContain('image2');
    expect(ownInput('-', { formats: ['image2pipe'], force: true, options: ['-framerate', '30'] })).toEqual(['-protocol_whitelist', 'pipe,fd', '-format_whitelist', 'image2pipe', '-f', 'image2pipe', '-framerate', '30', '-i', '-']);
  });

  it('refuses an -i without both whitelists, and an ffprobe input not named by -i', () => {
    expect(() => assertSafeInputs('ffmpeg', ['-i', 'a.mp4', 'out.mp4'])).toThrow(/whitelist/);
    expect(() => assertSafeInputs('ffmpeg', ['-protocol_whitelist', 'file', '-i', 'a.mp4'])).toThrow(/whitelist/);
    expect(() => assertSafeInputs('ffmpeg', [...mediaInput({ file: 'a.mp4' }), '-i', 'b.mp4'])).toThrow(/whitelist/);
    expect(() => assertSafeInputs('ffmpeg', [...mediaInput({ file: 'a.mp4' }), ...mediaInput({ fd: 4 }), 'o.wav'])).not.toThrow();
    expect(() => assertSafeInputs('ffprobe', ['-v', 'error', '-show_streams', 'a.mp4'])).toThrow(/-i/);
    expect(() => assertSafeInputs('ffprobe', ['-version'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', ['-hide_banner', '-encoders'])).not.toThrow();
    expect(ffKindOf('/usr/local/bin/ffprobe')).toBe('ffprobe');
    expect(ffKindOf('C:\\ff\\ffprobe.exe')).toBe('ffprobe');
    expect(ffKindOf('/usr/local/bin/ffmpeg')).toBe('ffmpeg');
  });

  it('no core module other than the helper starts ffmpeg or ffprobe (source scan)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel === HELPER) continue;
      const src = code(readFileSync(file, 'utf8'));
      const childProcess = /from\s+['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\)/.test(src);
      // A module that can spawn must have nothing to do with ffmpeg.
      if (childProcess && /ff(mpeg|probe)/i.test(src)) offenders.push(`${rel}: imports child_process and names ffmpeg/ffprobe`);
      // A generic runner (execCommand, an injected exec, run…) called with the ffmpeg/ffprobe name or an FfmpegInfo path.
      if (/(?<!\bwhich\s*)\(\s*['"`]ff(mpeg|probe)(\.exe)?['"`]\s*,/.test(src)) offenders.push(`${rel}: calls something with 'ffmpeg'/'ffprobe' as the command`);
      if (/\b(?!execFf\b|spawnFf\b)(exec\w*|run\w*|spawn\w*)\s*\(\s*[\w.!]*\b(ff|ffmpeg|o\.ff)!?\.path\b/.test(src)) offenders.push(`${rel}: runs an FfmpegInfo path directly`);
      if (/\bprobePath\b/.test(src)) offenders.push(`${rel}: resolves an ffprobe path outside the helper`);
    }
    expect(offenders).toEqual([]);
  });
});

const ffmpeg = await findFfmpeg();
if (!ffmpeg) {
  if (process.env.MS_REQUIRE_CHROME === '1') it('ffmpeg-exec canary: ffmpeg is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing ffmpeg'); });
  else console.warn('[core] ffmpeg canary tests SKIPPED: no ffmpeg. Required on CI (MS_REQUIRE_CHROME=1).');
}

describe.skipIf(!ffmpeg)('ffmpeg-exec canary: playlists and scripts disguised as media are refused', () => {
  let work: string;
  let compDir: string;
  let server: Server;
  let hits: string[];
  let origin: string;
  const ff = (args: string[]) => execFileSync(ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const noFd = (): FfmpegInfo => ({ ...ffmpeg!, fdProtocol: false });
  const comp = (src: string): Composition => ({
    $schema: 'motion-studio/composition@1', width: 160, height: 90, fps: 30, duration: 1, background: '#000000', fonts: [],
    scenes: [{ id: 's', start: 0, duration: 1 }], tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'c1', type: 'video', src, start: 0, duration: 1, props: { x: 0, y: 0, width: 160, height: 90 } }] }],
  } as unknown as Composition);

  beforeAll(async () => {
    hits = [];
    server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'video/mp2t' }); res.end('x'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    work = mkdtempSync(join(tmpdir(), 'ms-test-ffcanary-'));
    compDir = join(work, 'project', 'creatives', 'c', 'outputs', 'v1', 'compositions', 'story');
    const assets = join(compDir, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(compDir, 'composition.json'), '{}');
    // The sentinel: a real video with sound, next to the hostile files (a relative concat entry reaches it).
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', join(assets, 'sentinel.mov')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', join(assets, 'real.mp4')]);
    const hls = (target: string) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n${target}\n#EXT-X-ENDLIST\n`;
    writeFileSync(join(assets, 'concat.mp4'), 'ffconcat version 1.0\nfile sentinel.mov\n');
    writeFileSync(join(assets, 'hls-http.mp4'), hls(`${origin}/hls-mp4.ts`));
    writeFileSync(join(assets, 'hls-file.mp4'), hls(`file://${join(assets, 'sentinel.mov')}`));
    // A standard playlist extension: ffmpeg 8 detects it by content and would fetch the segment.
    writeFileSync(join(assets, 'list.m3u8'), hls(`${origin}/hls-m3u8.ts`));
    // An image sequence pattern: image2 would read seq1.png, seq2.png… (refused: image2 is not allowed for such a path).
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=1:d=2', join(assets, 'seq%d.png')]);
  }, 300_000);
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const hostile = ['concat.mp4', 'hls-http.mp4', 'hls-file.mp4', 'list.m3u8', 'seq%d.png'];

  it('media tools (library, outputs, reference frames, posters): probe null, no frame, no canary hit', async () => {
    const tools = await createFfmpegTools();
    expect(await tools.probe(join(compDir, 'assets', 'real.mp4'))).toMatchObject({ width: 160, height: 90 });
    expect(await tools.probe(join(compDir, 'assets', 'seq1.png'))).toMatchObject({ width: 160, height: 90 });
    for (const name of hostile) {
      const file = join(compDir, 'assets', name);
      expect(await tools.probe(file), name).toBeNull();
      const out = join(work, `${name}.jpg`);
      expect(await tools.frame(file, out, 0.2), name).toBe(false);
      expect(await tools.poster(file, out), name).toBe(false);
      expect(() => statSync(out), name).toThrow();
    }
    expect(hits).toEqual([]);
  }, 300_000);

  it('normalisation (fd and copy paths): mediaUnreadable, no canary hit; a real clip still normalises', async () => {
    for (const info of [ffmpeg!, noFd()]) {
      const n = new MediaNormalizer({ ffmpeg: async () => info });
      try {
        for (const name of hostile.slice(0, 3)) {
          const e = await n.prepare({ projectDir: join(work, 'project'), compDir, composition: comp(`assets/${name}`), signal: new AbortController().signal }).then(() => null, (x: unknown) => x);
          expect(e, `${name} fd=${info.fdProtocol}`).toBeInstanceOf(RenderError);
          expect((e as RenderError).code, `${name} fd=${info.fdProtocol}`).toBe('mediaUnreadable');
        }
        const ok = await n.prepare({ projectDir: join(work, 'project'), compDir, composition: comp('assets/real.mp4'), signal: new AbortController().signal });
        expect(ok.media.clips.size, `fd=${info.fdProtocol}`).toBe(1);
        ok.release();
      } finally { await n.close(); }
    }
    expect(hits).toEqual([]);
  }, 600_000);

  it('the audio mix (fd and copy paths) refuses a concat script; a real clip still mixes', async () => {
    for (const info of [ffmpeg!, noFd()]) {
      const workDir = mkdtempSync(join(work, 'mix-')), okDir = mkdtempSync(join(work, 'mix-'));
      const clip = (src: string) => ({ src, start: 0, duration: 1, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0, fromVideo: false });
      const bad = await mixAudio({ ff: info, compDir, clips: [clip('assets/concat.mp4')], durationSec: 1, outWav: join(workDir, 'bad.wav'), workDir, signal: new AbortController().signal }).then(() => 'mixed', (e: RenderError) => e.code);
      expect(bad, `fd=${info.fdProtocol}`).toBe('ffmpegFailed');
      expect(await mixAudio({ ff: info, compDir, clips: [clip('assets/sentinel.mov')], durationSec: 1, outWav: join(okDir, 'ok.wav'), workDir: okDir, signal: new AbortController().signal })).toBe(true);
    }
    expect(hits).toEqual([]);
  }, 300_000);
});
