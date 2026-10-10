/**
 * Shared set-up of the renderer's integration tests (real Chrome and ffmpeg, never downloaded): the runtime bundle built
 * into a temp folder, a canary server standing in for the core API, frame-coded media made with ffmpeg, and process checks
 * with `ps`. Everything lives under the OS temp folder.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';
import { runtimeBuildOptions } from '../../../composition-runtime/tsup.config.ts';
import { findSystemChrome, type ChromeInstall } from '../../src/render/system-chrome.ts';
import { findFfmpeg, type FfmpegInfo } from '../../src/render/encode.ts';
import { listProcesses } from '../../src/render/watchdog.ts';

export const RUNTIME_PKG = join(import.meta.dirname, '../../../composition-runtime');
export const FONT = join(RUNTIME_PKG, 'test/fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');

/** System Chrome and ffmpeg, or a failing test when MS_REQUIRE_CHROME=1 and one is missing. */
export async function renderTools(label: string): Promise<{ chrome: ChromeInstall | null; ffmpeg: FfmpegInfo | null; ok: boolean }> {
  const [chrome, ffmpeg] = await Promise.all([findSystemChrome(), findFfmpeg()]);
  const required = process.env.MS_REQUIRE_CHROME === '1';
  if (!chrome || !ffmpeg) {
    const what = !chrome ? 'Chrome (set CHROME_PATH)' : 'ffmpeg (set FFMPEG_PATH)';
    if (required) it(`${label}: ${what} is required (MS_REQUIRE_CHROME=1)`, () => { throw new Error(`missing ${what}`); });
    else console.warn(`[core] ${label} SKIPPED: no ${what}. Required on CI (MS_REQUIRE_CHROME=1).`);
  }
  return { chrome, ffmpeg, ok: !!chrome && !!ffmpeg };
}

/** Builds the runtime bundle (index.html, runtime.js, layer.js, clock.js) into `dist`. */
export async function buildRuntime(dist: string): Promise<void> {
  const { build } = await import(pathToFileURL(createRequire(join(RUNTIME_PKG, 'package.json')).resolve('tsup')).href) as { build(o: unknown): Promise<void> };
  await build({ ...runtimeBuildOptions(dist), config: false });
}

export interface Canary { origin: string; hits: string[]; close(): Promise<void> }

/** A loopback HTTP server that records every request (and WebSocket upgrade) it gets. */
export async function startCanary(): Promise<Canary> {
  const hits: string[] = [];
  const s: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'text/html' }); res.end('canary'); });
  s.on('upgrade', (req, socket) => { hits.push(`upgrade ${req.url ?? ''}`); socket.destroy(); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return {
    origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits,
    close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
}

const ff = (ffmpeg: FfmpegInfo, args: string[]) => execFileSync(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

/**
 * A 64×32 H.264 video whose frame n shows two grey blocks coding n + 1 (left: units, right: tens; luma 16 + 20 × digit;
 * so an all-black area reads 0, "not visible"),
 * `frames` frames. `pts` (seconds per frame index) makes it variable-frame-rate; otherwise constant at `fps`. `offset`
 * shifts every timestamp (a first frame at 0.1 s).
 */
export function frameCodedVideo(ffmpeg: FfmpegInfo, file: string, o: { fps: number; frames: number; pts?: string; offset?: number }): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const code = "geq=lum='16+20*if(lt(X,32),mod(N+1,10),floor((N+1)/10))':cb=128:cr=128";
  const vf = o.pts ? `${code},setpts='(${o.pts})/TB',format=yuv420p` : `${code},format=yuv420p`;
  ff(ffmpeg, ['-f', 'lavfi', '-i', `color=c=black:s=64x32:r=${o.fps}`, '-frames:v', String(o.frames), '-vf', vf,
    ...(o.pts ? ['-fps_mode', 'passthrough', '-video_track_timescale', '90000'] : []),
    ...(o.offset ? ['-output_ts_offset', String(o.offset)] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-g', '12', '-movflags', '+faststart', file]);
}

/** The presentation times (s) of every frame of `file`. */
export function framePts(ffmpeg: FfmpegInfo, file: string): number[] {
  const probe = join(ffmpeg.path, '..', 'ffprobe');
  const out = execFileSync(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((l) => parseFloat(l));
}

/**
 * A mono WAV (48 kHz, or `rate`) of `seconds`: silence, then from sample `at` a 1 kHz cosine of amplitude `amp` (so the very first
 * sample of the burst is at full amplitude: a sharp, exactly placed onset), lasting `burst` seconds (or to the end).
 */
export function burstWav(ffmpeg: FfmpegInfo, file: string, o: { seconds: number; at: number; burst?: number; amp?: number; rate?: number }): void {
  const rate = o.rate ?? 48000;
  const s = Math.round(o.at * rate);
  const e = o.burst ? s + Math.round(o.burst * rate) : 1e12;
  const amp = o.amp ?? 0.5;
  ff(ffmpeg, ['-f', 'lavfi', '-i', `aevalsrc='if(between(n,${s},${e - 1}),${amp}*cos(2*PI*1000*(n-${s})/${rate}),0)':s=${rate}:d=${o.seconds}`, '-c:a', 'pcm_s16le', file]);
}

/** Decodes the left channel of `file`'s audio as 48 kHz float samples. */
export function decodeAudio(ffmpeg: FfmpegInfo, file: string): Float32Array {
  const out = ff(ffmpeg, ['-i', file, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', '-']);
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
}

/** First sample index at or after `from` whose magnitude exceeds `thr`, or -1. */
export function onset(x: Float32Array, from: number, thr = 0.25): number {
  for (let i = Math.max(0, from); i < x.length; i++) if (Math.abs(x[i]!) > thr) return i;
  return -1;
}

/** Decodes every video frame of `file`, cropped to `box` and averaged down to `cols`×1 grey values (one byte each). */
export function decodeStrips(ffmpeg: FfmpegInfo, file: string, box: { x: number; y: number; width: number; height: number }, cols: number): Uint8Array[] {
  const raw = ff(ffmpeg, ['-i', file, '-vf', `crop=${box.width}:${box.height}:${box.x}:${box.y},scale=${cols}:1:flags=area,format=gray`, '-f', 'rawvideo', '-']);
  const frames: Uint8Array[] = [];
  for (let i = 0; i + cols <= raw.length; i += cols) frames.push(new Uint8Array(raw.subarray(i, i + cols)));
  return frames;
}

/**
 * Reads the frame code of a box showing a `frameCodedVideo`: the box is split in two halves (units, tens), each averaged.
 * The source luma 16 + 20d (limited range) is shown by Chrome as grey 20d × 255/219 and decoded back to full-range grey,
 * so the digit is round(grey × 219/255 / 20).
 */
export function readCode(strip: Uint8Array): number {
  const digit = (v: number) => Math.max(0, Math.min(9, Math.round((v * 219) / 255 / 20)));
  return digit(strip[1]!) * 10 + digit(strip[0]!);
}

/** Processes still alive in group `pgid`, or whose command line mentions `marker`. */
export async function leftovers(o: { pgids?: number[]; markers?: string[] }): Promise<string[]> {
  const rows = await listProcesses();
  return rows.filter((r) => r.pid !== process.pid && ((o.pgids ?? []).includes(r.pgid) || (o.markers ?? []).some((m) => r.command.includes(m))))
    .map((r) => `${r.pid}/${r.pgid} ${r.command.slice(0, 160)}`);
}

/** Writes a file, creating its folder. */
export function put(file: string, data: string | Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
}

export interface UdpCanary { port: number; packets: Array<{ bytes: number; from: number }>; close(): Promise<void> }

/** A loopback UDP socket that records every datagram (WebRTC STUN/TURN, WebTransport QUIC) it receives. */
export async function startUdpCanary(): Promise<UdpCanary> {
  const { createSocket } = await import('node:dgram');
  const sock = createSocket('udp4');
  const packets: Array<{ bytes: number; from: number }> = [];
  sock.on('message', (m, r) => packets.push({ bytes: m.length, from: r.port }));
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return { port: sock.address().port, packets, close: () => new Promise((r) => sock.close(() => r())) };
}
