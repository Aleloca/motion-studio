import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
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

/**
 * Demuxers accepted for agent and user media (names as ffmpeg prints them; one name of a multi-name demuxer is enough): the
 * real ingest containers and the single-image demuxers that read one file by its content. Never `image2` (pattern and glob
 * expansion on the path), `concat`/`ffconcat`, `hls`, `dash`, other playlists or anything that opens further files or URLs.
 */
export const MEDIA_DEMUXERS: readonly string[] = [
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'mpegts', 'flv',
  'wav', 'mp3', 'aac', 'flac', 'ogg',
  'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif', 'bmp_pipe', 'tiff_pipe',
];

export type FfKind = 'ffmpeg' | 'ffprobe';

/** The single-file demuxer of a still image, from its first bytes. */
function stillByContent(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg_pipe';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png_pipe';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp_pipe';
  if (head.length >= 2 && head.subarray(0, 2).toString('latin1') === 'BM') return 'bmp_pipe';
  if (head.length >= 4 && (head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return 'tiff_pipe';
  return null;
}
const STILL_BY_EXT: Record<string, string> = {
  jpg: 'jpeg_pipe', jpeg: 'jpeg_pipe', jpe: 'jpeg_pipe', jfif: 'jpeg_pipe', png: 'png_pipe', webp: 'webp_pipe', gif: 'gif', bmp: 'bmp_pipe', tif: 'tiff_pipe', tiff: 'tiff_pipe',
};

/**
 * The forced single-file demuxer of a still image at `file` (content first, then the extension), or null. ffmpeg's own
 * probe picks `image2` for a `.jpg` by its extension, and image2 expands `%d` and glob characters in the path: a still is
 * therefore always opened with an explicit single-file demuxer, whatever its path (final wave N1/P1).
 */
export function stillDemuxer(file: string): string | null {
  let head = Buffer.alloc(0);
  try {
    // Non-blocking, and only a regular file is read (M6): a FIFO, socket or device never stalls the core here.
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (fstatSync(fd).isFile()) { const b = Buffer.alloc(16); head = b.subarray(0, readSync(fd, b, 0, 16, 0)); }
      else return null;
    } finally { closeSync(fd); }
  } catch { /* unreadable here: ffmpeg reports it */ }
  const byContent = stillByContent(head);
  if (byContent) return byContent;
  if (head.length > 0) return null; // other content: not a still, whatever its name
  const ext = /\.([^./\\]+)$/.exec(file)?.[1]?.toLowerCase();
  return ext ? STILL_BY_EXT[ext] ?? null : null;
}

/**
 * Whether `file` is a regular file, checked without blocking (opened `O_NONBLOCK`, then `fstat`): what the media tools ask
 * before handing a path to ffmpeg, so a FIFO, socket or device is refused at once (M6).
 */
export function isRegularFileNow(file: string): boolean {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try { return fstatSync(fd).isFile(); } finally { closeSync(fd); }
  } catch { return false; }
}

/**
 * Input options for agent or user media: an open descriptor handed to the child as `fd` (3, 4, …), probed by content, or a
 * path. A path to a still image is forced to its single-file demuxer (`stillDemuxer`); any other path is probed among
 * `demuxers`, none of which reads a file name as a pattern.
 */
export function mediaInput(src: { fd: number } | { file: string }, demuxers: readonly string[] = MEDIA_DEMUXERS): string[] {
  if ('fd' in src) return ['-protocol_whitelist', 'fd', '-format_whitelist', demuxers.join(','), '-fd', String(src.fd), '-i', 'fd:'];
  const still = demuxers === MEDIA_DEMUXERS ? stillDemuxer(src.file) : null;
  if (still) return ['-protocol_whitelist', 'file', '-format_whitelist', still, '-f', still, '-i', src.file];
  return ['-protocol_whitelist', 'file', '-format_whitelist', demuxers.join(','), '-i', src.file];
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
export const ffKindOf = (cmd: string): FfKind => (/ffprobe/i.test(cmd.split(/[\\/]/).pop() ?? '') ? 'ffprobe' : 'ffmpeg');

/** Filter options: their value is a filtergraph. */
const FILTER_FLAG = /^-(vf|af|filter(:[a-z])?(:\d+)?|filter_complex|lavfi)$/;
/**
 * The filters the core builds (normalisation, colour stages, the mix, the encode, the VideoToolbox check and its test
 * pattern): an ALLOWLIST (final wave M3). Any other filter name in a filtergraph or a lavfi input is refused, so no file
 * reader or writer (`movie`, `drawtext textfile=`, `subtitles`, `lut3d file=`, `metadata file=`, `psnr stats_file=`, …)
 * can ever run, whatever reaches a graph.
 */
export const ALLOWED_FILTERS: ReadonlySet<string> = new Set([
  'setpts', 'fps', 'colorspace', 'zscale', 'format', 'tonemap', 'scale', 'setsar', 'setparams',
  'aresample', 'aformat', 'atrim', 'asetpts', 'volume', 'afade', 'adelay', 'amix', 'apad', 'alimiter',
  'ssim', 'testsrc', 'testsrc2', 'overlay',
]);
/** Input options that would let a container open other files (mov external tracks): never passed. */
const FORBIDDEN_OPTIONS = new Set(['-enable_drefs', '-use_absolute_path']);

/**
 * The filter names of a filtergraph: link labels `[…]` removed, split at `;` and `,` outside single quotes (backslash
 * escapes honoured), each name the text before its first `=`. Linear.
 */
export function filterNames(graph: string): string[] {
  const names: string[] = [];
  let cur = '';
  let quoted = false;
  let label = false;
  const flush = () => { const name = cur.split('=')[0]!.trim(); if (name) names.push(name); cur = ''; };
  for (let i = 0; i < graph.length; i++) {
    const c = graph[i]!;
    if (c === '\\') { cur += c + (graph[i + 1] ?? ''); i++; continue; }
    if (quoted) { if (c === "'") quoted = false; cur += c; continue; }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (label) { if (c === ']') label = false; continue; }
    if (c === '[') { label = true; continue; }
    if (c === ';' || c === ',') { flush(); continue; }
    cur += c;
  }
  flush();
  return names.map((n) => n.split('@')[0]!.trim());
}
const badFilter = (graph: string) => filterNames(graph).find((n) => !ALLOWED_FILTERS.has(n));

/**
 * Throws unless every `-i` of `args` has `-protocol_whitelist` and `-format_whitelist` among the options since the previous
 * `-i`. ffprobe must name its input with `-i` (a bare positional input could not be checked), unless it only prints info.
 * Only filters of `ALLOWED_FILTERS` in a filter option or a lavfi input; never an option whose value comes from a file
 * (`-/opt`, `-filter_script`, `-filter_complex_script`) nor one letting a container open other files (`-enable_drefs`,
 * `-use_absolute_path`).
 */
export function assertSafeInputs(kind: FfKind, args: readonly string[]): void {
  let seenProtocol = false, seenFormat = false, inputs = 0, forced = '';
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a.startsWith('-/') || /^-(filter|filter_complex|lavfi)_script$/.test(a)) throw new Error(`${kind}: option ${a} reads its value from a file`);
    if (FORBIDDEN_OPTIONS.has(a)) throw new Error(`${kind}: option ${a} lets a container open other files`);
    if (FILTER_FLAG.test(a)) { const bad = badFilter(args[k + 1] ?? ''); if (bad !== undefined) throw new Error(`${kind}: filter ${JSON.stringify(bad.slice(0, 40))} is not one the core builds (source filter or file access)`); }
    if (a === '-f') { forced = args[k + 1] ?? ''; k++; continue; }
    if (a === '-protocol_whitelist') { seenProtocol = true; k++; continue; }
    if (a === '-format_whitelist') { seenFormat = true; k++; continue; }
    if (a === '-i') {
      if (!seenProtocol || !seenFormat) throw new Error(`${kind} input ${JSON.stringify(args[k + 1] ?? '')} has no protocol/format whitelist`);
      if (forced === 'lavfi') { const bad = badFilter(args[k + 1] ?? ''); if (bad !== undefined) throw new Error(`${kind}: lavfi input filter ${JSON.stringify(bad.slice(0, 40))} is not one the core builds (source filter or file access)`); }
      seenProtocol = seenFormat = false;
      forced = '';
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
