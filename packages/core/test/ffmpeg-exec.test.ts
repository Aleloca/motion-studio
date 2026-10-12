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
import { assertSafeInputs, ffKindOf, filterNames, mediaInput, ownInput } from '../src/media/ffmpeg-exec.ts';
import { createFfmpegTools } from '../src/media/media-tools.ts';
import { findFfmpeg, h264Args, vtTestPattern, type FfmpegInfo } from '../src/render/encode.ts';
import { mixAudio, mixGraph } from '../src/render/audio-mix.ts';
import { gamutFilter, hdrFilter, MediaNormalizer, normalizeArgs } from '../src/render/media-normalize.ts';
import { RenderError } from '../src/render/errors.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const HELPER = join('media', 'ffmpeg-exec.ts');

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
/** The source without comments (block and line), strings kept. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Literals that name the binaries as a command or path: allowed only as a PATH lookup, the helper's kind, a doctor id/label or the agent's tool lists. */
const COMMAND = /(['"`])((?:[^'"`\s]*[\\/])?ff(?:mpeg|probe)(?:\.exe)?)\1/gi;
const ALLOWED_BEFORE = /(\bwhich\s*\(\s*|\bexecFfVia\s*\(\s*\w+\s*,\s*|\bid:\s*|\blabel:\s*)$/;
const NAME_LISTS = new Set([join('approvals', 'permissions-store.ts')]);
/** The scan's findings for one module (`src`: its code without comments); empty when it never starts ffmpeg itself. */
function scanSource(rel: string, src: string): string[] {
  const out: string[] = [];
  const childProcess = /from\s+['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\)/.test(src);
  // A module that can spawn must have nothing to do with ffmpeg.
  if (childProcess && /ff(mpeg|probe)/i.test(src)) out.push(`${rel}: imports child_process and names ffmpeg/ffprobe`);
  // No way around the static import: dynamic import of child_process or of a computed module, createRequire, a computed
  // require, process.binding.
  if (/\bimport\s*\(\s*(?:[^'"\s)]|['"](node:)?child_process)/.test(src)) out.push(`${rel}: dynamic import of child_process or of a computed module`);
  if (/\bcreateRequire\b|\bprocess\.binding\b|\brequire\s*\(\s*[^'"\s)]/.test(src)) out.push(`${rel}: createRequire, process.binding or a computed require`);
  // The binary named as a command (a literal), except the allowed places.
  if (!NAME_LISTS.has(rel)) {
    for (const m of src.matchAll(COMMAND)) if (!ALLOWED_BEFORE.test(src.slice(Math.max(0, m.index! - 60), m.index!))) out.push(`${rel}: names ${m[2]} as a command`);
  }
  // Or built from pieces.
  if (/['"`]ff['"`]\s*\+|\bff\$\{|['"`]\s*\+\s*['"`](mpeg|probe)\b|['"`](mpeg|probe)(\.exe)?['"`]/.test(src)) out.push(`${rel}: builds an ffmpeg/ffprobe name from pieces`);
  if (/\b(?!execFf\b|spawnFf\b)(exec\w*|run\w*|spawn\w*)\s*\(\s*[\w.!]*\b(ff|ffmpeg|o\.ff)!?\.path\b/.test(src)) out.push(`${rel}: runs an FfmpegInfo path directly`);
  if (/\bprobePath\b/.test(src)) out.push(`${rel}: resolves an ffprobe path outside the helper`);
  return out;
}

describe('ffmpeg-exec: whitelists on every input', () => {
  it('media inputs carry the fd or file protocol and the accepted demuxers only; never image2, playlists or scripts', () => {
    expect(mediaInput({ fd: 3 })).toEqual(['-protocol_whitelist', 'fd', '-format_whitelist', expect.stringContaining('mov'), '-fd', '3', '-i', 'fd:']);
    const file = mediaInput({ file: '/x/a.mp4' });
    expect(file.slice(0, 2)).toEqual(['-protocol_whitelist', 'file']);
    for (const ok of ['mov', 'mp4', 'matroska', 'webm', 'avi', 'mpegts', 'flv', 'mp3', 'wav', 'aac', 'ogg', 'flac', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif']) expect(file[3]!.split(','), ok).toContain(ok);
    for (const bad of ['image2', 'hls', 'dash', 'concat', 'ffconcat', 'tty', 'sdp', 'rtsp', 'rtp', 'lavfi', 'ffmetadata', 'data', 'image2pipe', 'svg_pipe', 'webm_dash_manifest', 'mpjpeg']) {
      expect(file[3]!.split(','), bad).not.toContain(bad);
      expect(mediaInput({ fd: 3 })[3]!.split(','), bad).not.toContain(bad);
    }
    expect(ownInput('-', { formats: ['image2pipe'], force: true, options: ['-framerate', '30'] })).toEqual(['-protocol_whitelist', 'pipe,fd', '-format_whitelist', 'image2pipe', '-f', 'image2pipe', '-framerate', '30', '-i', '-']);
  });

  it('a still image path is forced to its single-file demuxer, by content, else by extension (N1/P1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-still-'));
    try {
      const put = (name: string, bytes: number[] | string) => { const f = join(dir, name); writeFileSync(f, typeof bytes === 'string' ? bytes : Buffer.from(bytes)); return f; };
      const forced = (f: string) => { const a = mediaInput({ file: f }); return a.includes('-f') ? a[a.indexOf('-f') + 1] : null; };
      expect(forced(put('logo [1].jpg', [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('jpeg_pipe');
      expect(forced(put('50%.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png_pipe');
      expect(forced(put('a.gif', 'GIF89a......'))).toBe('gif');
      expect(forced(put('b', 'RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('webp_pipe');
      expect(forced(put('c.bmp', 'BM..........'))).toBe('bmp_pipe');
      expect(forced(put('d.tif', [0x49, 0x49, 0x2a, 0x00, 1]))).toBe('tiff_pipe');
      // A JPEG named .png is read as what it is; a playlist named .jpg is not a still (probed among the safe demuxers).
      expect(forced(put('lie.png', [0xff, 0xd8, 0xff, 0xdb]))).toBe('jpeg_pipe');
      expect(forced(put('list.jpg', '#EXTM3U\n'))).toBeNull();
      // Missing (e.g. a temp name to come): by extension.
      expect(forced(join(dir, 'gone.JPEG'))).toBe('jpeg_pipe');
      expect(forced(join(dir, 'gone.mp4'))).toBeNull();
      const a = mediaInput({ file: join(dir, 'logo [1].jpg') });
      expect(a.slice(0, 4)).toEqual(['-protocol_whitelist', 'file', '-format_whitelist', 'jpeg_pipe']);
      expect(a).not.toContain('-pattern_type');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an -i without both whitelists, and an ffprobe input not named by -i', () => {
    expect(() => assertSafeInputs('ffmpeg', ['-i', 'a.mp4', 'out.mp4'])).toThrow(/whitelist/);
    expect(() => assertSafeInputs('ffmpeg', ['-protocol_whitelist', 'file', '-i', 'a.mp4'])).toThrow(/whitelist/);
    expect(() => assertSafeInputs('ffmpeg', [...mediaInput({ file: 'a.mp4' }), '-i', 'b.mp4'])).toThrow(/whitelist/);
    expect(() => assertSafeInputs('ffmpeg', [...mediaInput({ file: 'a.mp4' }), ...mediaInput({ fd: 4 }), 'o.wav'])).not.toThrow();
    expect(() => assertSafeInputs('ffprobe', ['-v', 'error', '-show_streams', 'a.mp4'])).toThrow(/-i/);
    expect(() => assertSafeInputs('ffprobe', ['-version'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', ['-hide_banner', '-encoders'])).not.toThrow();
    for (const [name, kind] of [['/usr/local/bin/ffprobe', 'ffprobe'], ['C:\\ff\\ffprobe.exe', 'ffprobe'], ['/opt/ffprobe-7', 'ffprobe'], ['FFPROBE.EXE', 'ffprobe'], ['/usr/local/bin/ffmpeg', 'ffmpeg'], ['C:\\ff\\ffmpeg.exe', 'ffmpeg']] as const) {
      expect(ffKindOf(name), name).toBe(kind);
    }
    expect(() => assertSafeInputs('ffprobe', ['-v', 'error', '/x/a.mp4'])).toThrow(/-i/);
  });

  it('only the filters the core builds may appear in a filtergraph or a lavfi input (allowlist), no option reads a file, no external tracks', () => {
    const inp = mediaInput({ file: 'a.mp4' });
    for (const g of [
      'movie=/etc/passwd[x];[0:v][x]overlay', '[0:a]amovie=http://x/a.mp3[b]', 'sendcmd=f=cmds.txt,scale=1:1', 'zmq', "scale='1:1',movie=x",
      "drawtext=textfile=/etc/passwd", "drawtext=fontfile=/x.ttf:text=a", 'subtitles=/x.srt', 'ass=/x.ass', 'lut3d=file=/x.cube', 'lut1d=file=/x.cube',
      'curves=psfile=/x.acv', 'arnndn=model=/x.rnnn', 'sofalizer=sofa=/x.sofa', 'metadata=mode=print:file=/tmp/out', 'ametadata=mode=print:file=/tmp/out',
      'psnr=stats_file=/tmp/out', 'ssim=stats_file=/tmp/out,unknownfilter', 'vidstabdetect=result=/tmp/t.trf', 'scale=1:1,  nullsrc',
    ]) {
      for (const flag of ['-vf', '-af', '-filter:v', '-filter_complex', '-lavfi']) expect(() => assertSafeInputs('ffmpeg', [...inp, flag, g, 'o.mp4']), `${flag} ${g}`).toThrow(/not one the core builds/);
      expect(() => assertSafeInputs('ffmpeg', ['-protocol_whitelist', 'file', '-format_whitelist', 'lavfi', '-f', 'lavfi', '-i', g, 'o.mp4']), g).toThrow(/not one the core builds/);
    }
    for (const opt of ['-/vf', '-filter_script', '-filter_complex_script', '-/filter_complex']) expect(() => assertSafeInputs('ffmpeg', [...inp, opt, 'graph.txt', 'o.mp4']), opt).toThrow(/from a file/);
    for (const opt of ['-enable_drefs', '-use_absolute_path']) {
      expect(() => assertSafeInputs('ffmpeg', [opt, '1', ...inp, 'o.mp4']), opt).toThrow(/open other files/);
      expect(() => assertSafeInputs('ffprobe', [opt, '1', ...inp]), opt).toThrow(/open other files/);
    }
    // Names inside quotes and labels are not filters; escapes are honoured.
    expect(filterNames("[0:v]scale='min(540,iw)':-2[a];[a]format=yuv420p,setsar=1[out]")).toEqual(['scale', 'format', 'setsar']);
    expect(filterNames('testsrc=size=1x1:rate=1[a];testsrc=size=1x1[b];[a][b]overlay=16:16[out0]')).toEqual(['testsrc', 'testsrc', 'overlay']);
    // The graphs the core builds pass.
    expect(() => assertSafeInputs('ffmpeg', [...inp, ...normalizeArgs({ fps: 30, width: 320, height: 180, allIntra: true, untagged: true, hdrVf: hdrFilter({ primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc' }, undefined).vf }), 'o.mp4'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', [...inp, ...normalizeArgs({ fps: 24, width: 320, height: 180, allIntra: false, hdrVf: hdrFilter({ primaries: 'bt2020', transfer: 'smpte2084', space: 'bt2020nc' }, new Set(['zscale', 'tonemap'])).vf }), 'o.mp4'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', [...inp, ...normalizeArgs({ fps: 24, width: 320, height: 180, allIntra: false, hdrVf: gamutFilter({ primaries: 'bt2020', transfer: 'bt709', space: 'bt2020nc' }) }), 'o.mp4'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', [...inp, '-filter_complex', mixGraph([{ start: 0, duration: 1, trimStart: 0, volume: 1, fadeIn: 0.5, fadeOut: 0.5 }], 48000), 'o.wav'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', [...ownInput(vtTestPattern(64, 64, 30), { formats: ['lavfi'], force: true }), ...h264Args('libx264', 800, 30), 'o.mp4'])).not.toThrow();
    expect(() => assertSafeInputs('ffmpeg', [...inp, '-vf', "scale='min(540,iw)':-2", '-f', 'mjpeg', 'o.jpg'])).not.toThrow();
  });

  it('no agent-controlled text reaches a filtergraph: the colour stages map probe values to fixed names, the mix uses numbers', () => {
    const hostile = 'bt709:x=1,movie=/etc/passwd[a];[a]';
    for (const vf of [gamutFilter({ primaries: hostile, transfer: hostile, space: hostile }), hdrFilter({ primaries: hostile, transfer: hostile, space: hostile }, undefined).vf]) {
      expect(vf).not.toContain('movie');
      expect(vf).not.toContain('passwd');
    }
    const g = mixGraph([{ start: Number('1e400'), duration: 1, trimStart: Number.NaN, volume: 0.5, fadeIn: 0, fadeOut: 0 }], 48000);
    expect(g).not.toMatch(/movie|NaN|Infinity/);
  });

  it('no core module other than the helper starts ffmpeg or ffprobe (source scan, hardened)', () => {
    const offenders = walk(SRC).flatMap((file) => { const rel = relative(SRC, file); return rel === HELPER ? [] : scanSource(rel, code(readFileSync(file, 'utf8'))); });
    expect(offenders).toEqual([]);
  });

  it('the scan catches the bypasses it is meant to catch (the very rules above, on samples: M4)', () => {
    const samples = [
      "import { spawn } from 'node:child_process'; spawn(ffmpegPath)", "await import('node:child_process')", 'await import(name)',
      "createRequire(import.meta.url)('child_process')", 'require(mod)', 'process.binding("spawn_sync")',
      "execCommand('ff' + 'mpeg', [])", 'execCommand(`ff${x}`, [])', "execCommand('/usr/bin/ffprobe.exe', [])", "run('FFMPEG', [])",
      'execCommand(ff.path, [])', 'probePath(ff)',
    ];
    for (const x of samples) expect(scanSource('sample.ts', x), x).not.toEqual([]);
    for (const ok of ["which('ffmpeg', env)", "execFfVia(exec, 'ffprobe', [])", "{ id: 'ffmpeg', label: 'FFmpeg' }", "import('./x.ts')"]) expect(scanSource('sample.ts', ok), ok).toEqual([]);
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

describe.skipIf(!ffmpeg)('every format read before still reads, under a workspace path with pattern characters (N1/P1)', () => {
  let root: string;
  let dir: string;
  const made: Array<{ name: string; video: boolean; still: boolean }> = [];
  const ff = (args: string[]) => { try { execFileSync(ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ms-test-ffpaths-'));
    dir = join(root, 'Cliente [2026] 50% {x}?*', 'assets');
    mkdirSync(dir, { recursive: true });
    const v = ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=1'];
    const a = ['-f', 'lavfi', '-i', 'sine=d=1'];
    const img = ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=1:d=1', '-frames:v', '1'];
    const cases: Array<[string, string[], boolean, boolean]> = [
      ['clip [1].mp4', [...v, '-c:v', 'libx264', '-preset', 'ultrafast'], true, false],
      ['clip %d.mov', [...v, '-c:v', 'libx264', '-preset', 'ultrafast'], true, false],
      ['clip*.3gp', [...v, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], true, false],
      ['clip?.mkv', [...v, '-c:v', 'libx264', '-preset', 'ultrafast'], true, false],
      ['clip {a}.webm', [...v, '-c:v', 'libvpx-vp9', '-deadline', 'realtime'], true, false],
      ['clip.avi', [...v, '-c:v', 'mpeg4'], true, false],
      ['clip.ts', [...v, '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts'], true, false],
      ['clip.flv', [...v, '-c:v', 'flv1'], true, false],
      ['voice [1].m4a', [...a, '-c:a', 'aac'], false, false],
      ['voice.mp3', [...a], false, false],
      ['voice 50%.wav', [...a], false, false],
      ['voice.aac', [...a, '-c:a', 'aac', '-f', 'adts'], false, false],
      ['voice.ogg', [...a, '-c:a', 'libopus'], false, false],
      ['voice.flac', [...a], false, false],
      ['logo [1].jpg', img, true, true],
      ['logo%d.jpeg', img, true, true],
      ['logo {1}.png', img, true, true],
      ['logo*.gif', img, true, true],
      ['logo?.bmp', img, true, true],
      ['logo [1].tiff', img, true, true],
      ['logo [1].webp', [...img, '-c:v', 'libwebp'], true, true],
    ];
    for (const [name, args, video, still] of cases) if (ff([...args, join(dir, name)])) made.push({ name, video, still });
  }, 300_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('ffprobe reads each one, through the helper', async () => {
    const { execFf, ffprobeOf } = await import('../src/media/ffmpeg-exec.ts');
    expect(made.length).toBeGreaterThanOrEqual(19); // webp needs an encoder this ffmpeg may lack
    for (const m of made) {
      const r = await execFf(ffprobeOf(ffmpeg!.path), ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', ...mediaInput({ file: join(dir, m.name) })]);
      expect(r.code, `${m.name}: ${r.stderr}`).toBe(0);
    }
  }, 300_000);

  it('media tools give the size of every video and still, and a frame of the JPEG and the mp4', async () => {
    const tools = await createFfmpegTools();
    for (const m of made.filter((x) => x.video)) expect(await tools.probe(join(dir, m.name)), m.name).toMatchObject({ width: 160, height: 90 });
    // The outputs go under the same path (a poster in `.previews/`): `%` there must not be read as a pattern either.
    for (const name of ['logo [1].jpg', 'clip [1].mp4', 'logo%d.jpeg']) {
      const out = join(dir, '.previews 50%', `${name}.jpg`);
      expect(await tools.frame(join(dir, name), out, 0.2), name).toBe(true);
      expect(statSync(out).size).toBeGreaterThan(0);
    }
  }, 300_000);
});
