import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandExec, CommandResult } from '../exec.ts';
import { filterArgv, type FilterArg } from './ffmpeg-filters.ts';

export type { ChildProcess, StdioOptions } from 'node:child_process';

/**
 * The ONE place the core starts ffmpeg or ffprobe (final review I1). Every input an invocation opens carries an input
 * `-protocol_whitelist` and `-format_whitelist`, so a file whose bytes are a playlist or a script (HLS, DASH, concat, SDP,
 * tty, image sequences, …) cannot make ffmpeg fetch a URL or read another file: it is refused (`Format not on whitelist`),
 * and the caller sees an unreadable file. Both options are AVFormatContext options, inherited by nested contexts.
 *
 * - Agent or user media (composition assets, library files, agent outputs): `mediaInput`, with only the demuxers we accept
 *   (`MEDIA_DEMUXERS`) and only the protocol of the open (`fd` for a verified descriptor, `file` for a path).
 * - Files the core made itself (render segments, the mix, a frame pipe): `ownInput`, with exactly the demuxer(s) the file is.
 * - A generated source (the VideoToolbox test pattern): a lavfi input from `media/ffmpeg-filters.ts`, never `ownInput`.
 *
 * Filtergraphs are structural (decisions log 191): `-vf`/`-af`/`-filter*`/`-lavfi` and lavfi inputs exist only as `FilterArg`s
 * built by `media/ffmpeg-filters.ts`. `spawnFf`, `execFf` and `execFfVia` refuse (throw) a raw string for them, an `-i` that
 * lacks either whitelist, and an ffprobe run with an input not given by `-i` (`ffArgv`). `test/ffmpeg-exec.test.ts` fails when another core module starts ffmpeg or ffprobe.
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
 * `options` other input options (e.g. `-framerate`). `-` reads stdin (`pipe`/`fd` protocols). Never `lavfi` (a generated
 * source comes from `media/ffmpeg-filters.ts`).
 */
export function ownInput(target: string, o: { formats: readonly string[]; force?: boolean; options?: readonly string[] }): string[] {
  if (o.formats.includes('lavfi')) throw new Error('ownInput: a lavfi input must be built by media/ffmpeg-filters.ts');
  // ffmpeg 8 opens `-` through the `fd` protocol (older builds: `pipe`).
  const protocol = target === '-' ? 'pipe,fd' : 'file';
  return ['-protocol_whitelist', protocol, '-format_whitelist', o.formats.join(','), ...(o.force ? ['-f', o.formats[0]!] : []), ...(o.options ?? []), '-i', target];
}

/** The MP4/MOV demuxer (our render segments and outputs). */
export const MP4_DEMUXERS: readonly string[] = ['mov', 'mp4'];

const INFO_FLAGS = new Set(['-version', '-encoders', '-decoders', '-protocols', '-filters', '-formats', '-demuxers', '-muxers', '-buildconf']);

/** The kind of a binary path (`…/ffprobe`, `ffprobe.exe` → ffprobe). */
export const ffKindOf = (cmd: string): FfKind => (/ffprobe/i.test(cmd.split(/[\\/]/).pop() ?? '') ? 'ffprobe' : 'ffmpeg');

/**
 * Filter options: their value is a filtergraph. Every spelling ffmpeg accepts: a stream specifier may follow
 * (`-filter:v`, `-vf:v`, `-af:0`, `-filter:v:#1`). Accepted only inside a `FilterArg` from `media/ffmpeg-filters.ts`.
 */
const FILTER_FLAG = /^-(vf|af|filter|filter_complex|lavfi)(:.*)?$/;
/** The script forms of the same options: their value is a FILE with a graph. Refused outright. */
const FILTER_SCRIPT_FLAG = /^-(filter|filter_complex|lavfi)_script(:.*)?$/;
/** Input options that would let a container open other files (mov external tracks): never passed. */
const FORBIDDEN_OPTIONS = new Set(['-enable_drefs', '-use_absolute_path']);

/**
 * One ffmpeg/ffprobe argument: a plain string, or a filter option / lavfi input built by `media/ffmpeg-filters.ts` (decisions
 * log 191). A filtergraph is never a string here.
 */
export type FfArg = string | FilterArg;
type FilterOption = 'vf' | 'af' | 'filter' | 'filter_complex' | 'lavfi';
/** The literals refused in an argument list at compile time: the filter options, their script forms, `-/opt` and `lavfi`. */
export type RawFilterArg = `-${FilterOption}` | `-${FilterOption}:${string}` | `-${string}_script` | `-${string}_script:${string}` | `-/${string}` | 'lavfi';
/**
 * `A` with every literal of `RawFilterArg` turned into `never`: `spawnFf(cmd, ['-vf', graph])` does not compile. A string
 * known only at run time is refused by `ffArgv`.
 */
export type CheckedFfArgs<A extends readonly FfArg[]> = { readonly [K in keyof A]: A[K] extends RawFilterArg ? never : A[K] };

/**
 * The argument list ffmpeg/ffprobe receives, after the checks (throws when one fails):
 * - a filter option (`-vf`, `-af`, `-filter[:spec]`, `-filter_complex`, `-lavfi`) or a lavfi input (`-f lavfi`, a
 *   `-format_whitelist` naming `lavfi`) only inside a `FilterArg` made by `media/ffmpeg-filters.ts`; any other object is refused;
 * - never an option whose value comes from a file (`-/opt`, `-filter_script[:spec]`, `-filter_complex_script`, `-lavfi_script`)
 *   nor one letting a container open other files (`-enable_drefs`, `-use_absolute_path`);
 * - every `-i` has `-protocol_whitelist` and `-format_whitelist` among the options since the previous `-i`; ffprobe names its
 *   input with `-i` (a bare positional input could not be checked), unless it only prints info.
 */
export function ffArgv(kind: FfKind, args: readonly FfArg[]): string[] {
  const argv: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (typeof a !== 'string') {
      const built = filterArgv(a);
      if (!built) throw new Error(`${kind}: argument ${k} is neither a string nor a filter built by media/ffmpeg-filters.ts`);
      argv.push(...built);
      continue;
    }
    if (a.startsWith('-/') || FILTER_SCRIPT_FLAG.test(a)) throw new Error(`${kind}: option ${a} reads its value from a file`);
    if (FILTER_FLAG.test(a)) throw new Error(`${kind}: option ${a} takes only a filtergraph built by media/ffmpeg-filters.ts, not a string`);
    if (FORBIDDEN_OPTIONS.has(a)) throw new Error(`${kind}: option ${a} lets a container open other files`);
    const next = args[k + 1];
    if ((a === '-f' || a === '-format_whitelist') && typeof next === 'string' && next.split(',').some((f) => f.trim() === 'lavfi')) {
      throw new Error(`${kind}: a lavfi input must be built by media/ffmpeg-filters.ts`);
    }
    argv.push(a);
  }
  let seenProtocol = false, seenFormat = false, inputs = 0;
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === '-protocol_whitelist') { seenProtocol = true; k++; continue; }
    if (a === '-format_whitelist') { seenFormat = true; k++; continue; }
    if (a === '-f') { k++; continue; }
    if (a === '-i') {
      if (!seenProtocol || !seenFormat) throw new Error(`${kind} input ${JSON.stringify(argv[k + 1] ?? '')} has no protocol/format whitelist`);
      seenProtocol = seenFormat = false;
      inputs++;
      k++;
    }
  }
  if (kind === 'ffprobe' && inputs === 0 && !argv.some((a) => INFO_FLAGS.has(a))) throw new Error('ffprobe must name its input with -i');
  return argv;
}

/** Throws when `ffArgv` would refuse `args`. */
export function assertSafeInputs(kind: FfKind, args: readonly FfArg[]): void {
  ffArgv(kind, args);
}

/** The ffprobe next to an ffmpeg binary, else `ffprobe` from PATH. */
export function ffprobeOf(ffmpegPath: string): string {
  const p = join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return existsSync(p) ? p : 'ffprobe';
}

/** Starts ffmpeg/ffprobe (`cmd` is its path) with the arguments checked and expanded by `ffArgv`. */
export function spawnFf<const A extends readonly FfArg[]>(cmd: string, args: A & CheckedFfArgs<A>, options: SpawnOptions): ChildProcess {
  return spawn(cmd, ffArgv(ffKindOf(cmd), args), options);
}

/** Runs ffmpeg/ffprobe to completion (exit code, stdout, stderr) with the arguments checked and expanded by `ffArgv`. */
export function execFf<const A extends readonly FfArg[]>(cmd: string, args: A & CheckedFfArgs<A>, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = ffArgv(ffKindOf(cmd), args);
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Runs `ffmpeg`/`ffprobe` from PATH through an injected `CommandExec` (media tools, doctor), arguments checked by `ffArgv`. */
export function execFfVia<const A extends readonly FfArg[]>(exec: CommandExec, kind: FfKind, args: A & CheckedFfArgs<A>, opts?: { timeoutMs?: number }): Promise<CommandResult> {
  return exec(kind, ffArgv(kind, args), opts);
}
