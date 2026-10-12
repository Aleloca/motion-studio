/**
 * The ONLY place the core writes an ffmpeg filtergraph (final wave part 3, S: structural filtergraphs, decisions log 191).
 *
 * Every builder takes typed, validated values (finite numbers in a range, enums mapped from fixed tables) and returns a
 * `FilterArg`: an opaque object holding the whole option (`-vf graph`, `-filter_complex graph`, `-lavfi graph`) or the whole
 * lavfi input (whitelists, `-f lavfi -i graph`). No builder takes free text that ends up in a graph.
 *
 * `media/ffmpeg-exec.ts` accepts the filter options and lavfi inputs ONLY as a `FilterArg` made here: a raw string for them is
 * refused by the type system and at run time (the brand is checked against a module-private registry, so a look-alike
 * object is refused too). `test/ffmpeg-exec.test.ts` fails when another core module writes a filter flag or a graph.
 */

declare const filterArgBrand: unique symbol;
/** Builder-produced ffmpeg arguments carrying a filtergraph. Opaque: only this module creates one. */
export interface FilterArg { readonly [filterArgBrand]: 'FilterArg' }

const MINTED = new WeakMap<object, readonly string[]>();
function mint(argv: readonly string[]): FilterArg {
  const arg = Object.freeze(Object.create(null) as object);
  MINTED.set(arg, Object.freeze([...argv]));
  return arg as FilterArg;
}

/** The arguments of a `FilterArg` made by this module, or undefined for anything else (a string, a look-alike object). */
export function filterArgv(x: unknown): readonly string[] | undefined {
  return typeof x === 'object' && x !== null ? MINTED.get(x) : undefined;
}

/** The filters these builders use (the source scan refuses a graph-like literal naming one of them anywhere else). */
export const BUILT_FILTERS: readonly string[] = [
  'setpts', 'fps', 'colorspace', 'zscale', 'format', 'tonemap', 'scale', 'setsar', 'setparams',
  'aresample', 'aformat', 'atrim', 'asetpts', 'volume', 'afade', 'adelay', 'amix', 'apad', 'alimiter',
  'ssim', 'testsrc', 'overlay',
];

// ---------- values ----------

function int(v: number, min: number, max: number, what: string): string {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RangeError(`ffmpeg filter: ${what} must be an integer in ${min}..${max}`);
  return String(v);
}
function rate(v: number, what: string): string {
  if (!Number.isFinite(v) || v <= 0 || v > 240) throw new RangeError(`ffmpeg filter: ${what} must be a number in (0, 240]`);
  return String(v);
}
function oneOf<T extends string>(v: T, allowed: readonly T[], what: string): T {
  if (!allowed.includes(v)) throw new RangeError(`ffmpeg filter: ${what} is not one of ${allowed.join(', ')}`);
  return v;
}

/** Largest picture side a builder accepts (a normalised clip is at most 4096, a composition at most 8192). */
const MAX_SIDE = 16384;
/** Upper bound of a sample count (a day at 192 kHz). */
const MAX_SAMPLES = 192_000 * 86_400;

// ---------- colour stages (normalisation of HDR and wide-gamut sources) ----------

const PRIMARIES = ['bt709', 'bt2020'] as const;
const SPACES = ['bt709', 'bt2020ncl', 'smpte170m', 'bt470bg'] as const;
const TRANSFERS = ['bt709', 'bt2020-10', 'bt2020-12', 'smpte170m', 'bt470bg'] as const;

/** The colour stage of a normalisation, before the scale: a tone map (zscale + tonemap) or a `colorspace` conversion. */
export type ColourStage =
  | { readonly kind: 'tonemap' }
  | { readonly kind: 'colorspace'; readonly primaries: (typeof PRIMARIES)[number]; readonly space: (typeof SPACES)[number]; readonly trc: (typeof TRANSFERS)[number] };

/** The colour description of a source stream (ffprobe names, untrusted: only looked up in fixed tables). */
export interface HdrInfo { primaries: string; transfer: string; space: string }

const ISPACE: Record<string, (typeof SPACES)[number]> = { bt2020nc: 'bt2020ncl', bt2020c: 'bt2020ncl', bt709: 'bt709', smpte170m: 'smpte170m', bt470bg: 'bt470bg' };
const ITRC: Record<string, (typeof TRANSFERS)[number]> = { bt709: 'bt709', 'bt2020-10': 'bt2020-10', 'bt2020-12': 'bt2020-12', smpte170m: 'smpte170m', bt470bg: 'bt470bg' };

/** A wide-gamut SDR source (BT.2020 primaries, an SDR transfer): a gamut conversion to BT.709, no tone mapping, exact. */
export function gamutStage(c: HdrInfo): ColourStage {
  return { kind: 'colorspace', primaries: 'bt2020', space: Object.hasOwn(ISPACE, c.space) ? ISPACE[c.space]! : 'bt2020ncl', trc: Object.hasOwn(ITRC, c.transfer) ? ITRC[c.transfer]! : 'bt709' };
}

/** The colour stage for an HDR source (PQ or HLG transfer), and whether its colours are only approximate. */
export function hdrStage(hdr: HdrInfo, filters: ReadonlySet<string> | undefined): { stage: ColourStage; approximate: boolean } {
  if (filters?.has('zscale') && filters.has('tonemap')) return { stage: { kind: 'tonemap' }, approximate: false };
  // The colorspace filter has no PQ or HLG curve: the transfer (always PQ or HLG here) is read as BT.2020's SDR one
  // (primaries and matrix exact).
  return {
    stage: {
      kind: 'colorspace', primaries: hdr.primaries === 'bt2020' ? 'bt2020' : 'bt709',
      space: hdr.space === 'bt2020nc' || hdr.space === 'bt2020c' ? 'bt2020ncl' : 'bt709', trc: 'bt2020-10',
    },
    approximate: true,
  };
}

function colourText(s: ColourStage): string {
  if (s.kind === 'tonemap') return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,';
  if (s.kind !== 'colorspace') throw new RangeError('ffmpeg filter: unknown colour stage');
  return `colorspace=all=bt709:iprimaries=${oneOf(s.primaries, PRIMARIES, 'primaries')}:ispace=${oneOf(s.space, SPACES, 'space')}`
    + `:itrc=${oneOf(s.trc, TRANSFERS, 'transfer')}:format=yuv420p,`;
}

// ---------- builders ----------

/**
 * The `-vf` of a normalisation: zero-based timestamps, constant `fps` (round=up), the optional colour stage, a Lanczos scale to
 * `width`×`height` into BT.709 limited range (`yuv420p`, square pixels), tagged BT.709 / sRGB transfer. After a colour stage,
 * or for an `untagged` source, the input is read as BT.709 limited range.
 */
export function normalizeVideoFilter(o: { fps: number; width: number; height: number; colour?: ColourStage; untagged?: boolean }): FilterArg {
  const input = o.colour || o.untagged ? 'in_color_matrix=bt709:in_range=tv:' : '';
  return mint(['-vf', `setpts=PTS-STARTPTS,fps=fps=${rate(o.fps, 'fps')}:round=up,${o.colour ? colourText(o.colour) : ''}`
    + `scale=${int(o.width, 1, MAX_SIDE, 'width')}:${int(o.height, 1, MAX_SIDE, 'height')}:flags=lanczos:${input}out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,`
    + 'setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv']);
}

/** The `-vf` of a final H.264 encode: BT.709 limited range `yuv420p`, with the stream's colour properties set (`setparams`). */
export function h264ColourFilter(): FilterArg {
  return mint(['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv']);
}

/** The `-vf` of a still frame (storyboards, reference frames, posters): at most `maxWidth` wide, even height, aspect kept. */
export function frameScaleFilter(maxWidth: number): FilterArg {
  return mint(['-vf', `scale='min(${int(maxWidth, 1, MAX_SIDE, 'width')},iw)':-2`]);
}

/** One mixed clip, in samples: where its audio starts (`trimStart`), how long it plays, its gain, fades and delay. */
export interface MixSamples { trimStart: number; length: number; volume: number; fadeIn: number; fadeOut: number; delay: number }

/**
 * The `-filter_complex` of the audio mix: input i is `[i:a]`, output `[out]` of exactly `totalSamples` samples at `sampleRate`.
 * Per clip `aresample → aformat → atrim → asetpts → volume → afade in/out → adelay`, then `amix normalize=0`, `apad`, a limiter
 * and a final trim.
 */
export function audioMixFilter(clips: readonly MixSamples[], totalSamples: number, sampleRate: number): FilterArg {
  int(clips.length, 1, 32_767, 'clip count');
  const sr = int(sampleRate, 8000, 192_000, 'sample rate');
  const total = int(totalSamples, 0, MAX_SAMPLES, 'total samples');
  const parts = clips.map((c, i) => {
    const s0 = Number(int(c.trimStart, 0, MAX_SAMPLES, 'trim start'));
    const len = Number(int(c.length, 0, MAX_SAMPLES, 'length'));
    if (!Number.isFinite(c.volume) || c.volume < 0 || c.volume > 16) throw new RangeError('ffmpeg filter: volume must be a number in 0..16');
    const f = [
      `aresample=${sr}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=start_sample=${s0}:end_sample=${s0 + len}`, 'asetpts=N/SR/TB', `volume=${Number(c.volume.toFixed(6)).toString()}`,
    ];
    const fi = Number(int(c.fadeIn, 0, MAX_SAMPLES, 'fade in')), fo = Number(int(c.fadeOut, 0, MAX_SAMPLES, 'fade out'));
    if (fi > 0) f.push(`afade=t=in:start_sample=0:nb_samples=${fi}`);
    if (fo > 0) f.push(`afade=t=out:start_sample=${Math.max(0, len - fo)}:nb_samples=${fo}`);
    f.push(`adelay=delays=${int(c.delay, 0, MAX_SAMPLES, 'delay')}S:all=1`);
    return `[${i}:a]${f.join(',')}[a${i}]`;
  });
  const inputs = clips.map((_, i) => `[a${i}]`).join('');
  return mint(['-filter_complex', `${parts.join(';')};${inputs}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,`
    + `apad=whole_len=${total},alimiter=limit=0.89:level=false:latency=1,atrim=end_sample=${total},asetpts=N/SR/TB[out]`]);
}

/**
 * The VideoToolbox check's test pattern as a lavfi INPUT (whitelists, `-f lavfi -i graph`): seven-segment counters at two
 * sizes over colour bars (`testsrc`, a quarter-size one overlaid), 2 s, closer to the text of motion graphics than `testsrc2`.
 * Only lavfi sources: `drawtext` needs a freetype build.
 */
export function testPatternInput(width: number, height: number, fps: number): FilterArg {
  const w = int(width, 16, MAX_SIDE, 'width'), h = int(height, 16, MAX_SIDE, 'height'), r = rate(fps, 'fps');
  const qw = Math.max(16, Math.round(width / 4 / 2) * 2), qh = Math.max(16, Math.round(height / 4 / 2) * 2);
  return mint(['-protocol_whitelist', 'file', '-format_whitelist', 'lavfi', '-f', 'lavfi', '-i',
    `testsrc=size=${w}x${h}:rate=${r}:duration=2[a];testsrc=size=${qw}x${qh}:rate=${r}:duration=2[b];[a][b]overlay=16:16[out0]`]);
}

/** The `-lavfi` of the VideoToolbox check: SSIM of input 0 (the encode) against input 1 (the pattern, converted as encoded). */
export function ssimCompareFilter(): FilterArg {
  return mint(['-lavfi', '[0:v]format=yuv420p[a];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[b];[a][b]ssim']);
}
