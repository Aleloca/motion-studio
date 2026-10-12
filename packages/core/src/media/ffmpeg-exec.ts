import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandExec, CommandResult } from '../exec.ts';

export type { ChildProcess, StdioOptions } from 'node:child_process';

/**
 * The ONE place the core starts ffmpeg or ffprobe (final review I1). Every input an invocation opens carries an input
 * `-protocol_whitelist` and `-format_whitelist`, so a file whose bytes are a playlist or a script (HLS, DASH, concat, SDP,
 * tty, image sequences, …) cannot make ffmpeg fetch a URL or read another file: it is refused (`Format not on whitelist`),
 * and the caller sees an unreadable file. Both options are AVFormatContext options, inherited by nested contexts.
 *
 * - Agent or user media (composition assets, library files, agent outputs): `mediaInput`, with only the demuxers we accept
 *   (`MEDIA_DEMUXERS`) and only the protocol of the open (`fd` for a verified descriptor, `file` for a path).
 * - Files the core made itself (render segments, the mix, a frame pipe, a test pattern): `ownInput`, with exactly the
 *   demuxer(s) the file is.
 *
 * `spawnFf`, `execFf` and `execFfVia` refuse (throw) an argument list with an `-i` that lacks either option, and an ffprobe
 * run with an input not given by `-i`. `test/ffmpeg-exec.test.ts` fails when another core module starts ffmpeg or ffprobe.
 */

/** Demuxers accepted for agent and user media (names as ffmpeg prints them; one name of a multi-name demuxer is enough). */
export const MEDIA_DEMUXERS: readonly string[] = [
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm',
  'wav', 'mp3', 'aac', 'flac', 'ogg',
  'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif', 'bmp_pipe', 'tiff_pipe',
];

export type FfKind = 'ffmpeg' | 'ffprobe';

/** A path image2 reads as one file: no sequence pattern (`%d`) and no glob character anywhere in it. */
const singleImagePath = (file: string) => !/[%*?[\]{}]/.test(file);

/**
 * Input options for agent or user media: an open descriptor handed to the child as `fd` (3, 4, …) or a path. With the
 * default list, a path also allows `image2` (ffmpeg picks it for the JPEGs it writes itself) when image2 can only read that
 * one file (`singleImagePath`); never an image sequence.
 */
export function mediaInput(src: { fd: number } | { file: string }, demuxers: readonly string[] = MEDIA_DEMUXERS): string[] {
  const list = demuxers === MEDIA_DEMUXERS && 'file' in src && singleImagePath(src.file) ? [...demuxers, 'image2'] : demuxers;
  const wl = ['-protocol_whitelist', 'fd' in src ? 'fd' : 'file', '-format_whitelist', list.join(',')];
  return 'fd' in src ? [...wl, '-fd', String(src.fd), '-i', 'fd:'] : [...wl, '-i', src.file];
}

/**
 * Input options for a file the core made: `formats` are the demuxers allowed (the first is forced with `-f` when `force`),
 * `options` other input options (e.g. `-framerate`). `-` reads stdin (`pipe`/`fd` protocols); a lavfi graph opens no protocol.
 */
export function ownInput(target: string, o: { formats: readonly string[]; force?: boolean; options?: readonly string[] }): string[] {
  // ffmpeg 8 opens `-` through the `fd` protocol (older builds: `pipe`).
  const protocol = target === '-' ? 'pipe,fd' : 'file';
  return ['-protocol_whitelist', protocol, '-format_whitelist', o.formats.join(','), ...(o.force ? ['-f', o.formats[0]!] : []), ...(o.options ?? []), '-i', target];
}

/** The MP4/MOV demuxer (our render segments and outputs). */
export const MP4_DEMUXERS: readonly string[] = ['mov', 'mp4'];

const INFO_FLAGS = new Set(['-version', '-encoders', '-decoders', '-protocols', '-filters', '-formats', '-demuxers', '-muxers', '-buildconf']);

/** The kind of a binary path (`…/ffprobe`, `ffprobe.exe` → ffprobe). */
export const ffKindOf = (cmd: string): FfKind => (/(^|[\\/])ffprobe(\.exe)?$/i.test(cmd) ? 'ffprobe' : 'ffmpeg');

/**
 * Throws unless every `-i` of `args` has `-protocol_whitelist` and `-format_whitelist` among the options since the previous
 * `-i`. ffprobe must name its input with `-i` (a bare positional input could not be checked), unless it only prints info.
 */
export function assertSafeInputs(kind: FfKind, args: readonly string[]): void {
  let seenProtocol = false, seenFormat = false, inputs = 0;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-protocol_whitelist') { seenProtocol = true; k++; continue; }
    if (a === '-format_whitelist') { seenFormat = true; k++; continue; }
    if (a === '-i') {
      if (!seenProtocol || !seenFormat) throw new Error(`${kind} input ${JSON.stringify(args[k + 1] ?? '')} has no protocol/format whitelist`);
      seenProtocol = seenFormat = false;
      inputs++;
      k++;
    }
  }
  if (kind === 'ffprobe' && inputs === 0 && !args.some((a) => INFO_FLAGS.has(a))) throw new Error('ffprobe must name its input with -i');
}

/** The ffprobe next to an ffmpeg binary, else `ffprobe` from PATH. */
export function ffprobeOf(ffmpegPath: string): string {
  const p = join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return existsSync(p) ? p : 'ffprobe';
}

/** Starts ffmpeg/ffprobe (`cmd` is its path) after `assertSafeInputs`. */
export function spawnFf(cmd: string, args: string[], options: SpawnOptions): ChildProcess {
  assertSafeInputs(ffKindOf(cmd), args);
  return spawn(cmd, args, options);
}

/** Runs ffmpeg/ffprobe to completion (exit code, stdout, stderr) after `assertSafeInputs`. */
export function execFf(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  assertSafeInputs(ffKindOf(cmd), args);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Runs `ffmpeg`/`ffprobe` from PATH through an injected `CommandExec` (media tools, doctor), after `assertSafeInputs`. */
export function execFfVia(exec: CommandExec, kind: FfKind, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult> {
  assertSafeInputs(kind, args);
  return exec(kind, args, opts);
}
