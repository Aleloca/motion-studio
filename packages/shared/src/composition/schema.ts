import { z } from 'zod';
import { COMPOSITION_PATH_MAX, isCompositionPath } from './paths.ts';

/** The `$schema` tag of a composition file. */
export const COMPOSITION_SCHEMA_ID = 'motion-studio/composition@1';

/**
 * Bounds of a composition, enforced by the schema and checked first by `validateComposition` (before anything walks the
 * input), so validation stays linear and bounded on any file:
 * - `jsonBytes`: size of `composition.json` (`parseCompositionText`);
 * - `tracks`, `scenes`, `fonts`: array lengths; `clipsPerTrack` and `clips` (all tracks together);
 * - `animations` per clip, `keyframes` per animation, `params` per html clip;
 * - `text` (text clip content and text params), `name` (scene, track, clip and param labels), `id` (ids), `family`;
 * - `durationSec`: composition length; `problems`: problems reported at most (one more says that others were omitted).
 */
export const COMPOSITION_LIMITS = {
  jsonBytes: 5 * 1024 * 1024,
  tracks: 64,
  scenes: 200,
  fonts: 32,
  clipsPerTrack: 500,
  clips: 2000,
  animations: 32,
  keyframes: 64,
  params: 32,
  text: 2000,
  name: 200,
  id: 64,
  family: 80,
  durationSec: 600,
  problems: 100,
} as const;

/** Composition pixel coordinates are bounded so a typo cannot ask the renderer for absurd layouts. */
const COORD = 100_000;
/** The numeric bounds of the editable properties, for the editor's controls (one copy: the schema below uses them). */
export const COMPOSITION_BOUNDS = { coord: COORD, size: COORD, rotation: 3600, opacity: 1, fontSize: 2000, trimStart: 36_000, volume: 2 } as const;
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** One font family name, no quotes, commas or fallbacks: the family must be one of `fonts[]`. */
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;
/** CSS easing keywords and functions (`ease-out`, `cubic-bezier(.3,1.5,.6,1)`, `steps(4, end)`): a safe character set only. */
const EASE_RE = /^[a-z][a-z0-9(),. -]{0,63}$/;
const PARAM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Path shape for the JSON Schema, so the agent's own validator agrees with `isCompositionPath` in the common cases: no `.`
 * or `..` segment, no empty segment or trailing slash, no control characters. The authoritative check is still
 * `isCompositionPath` (refine below), which also rejects invisible characters, unpaired surrogates and blank segments.
 * Linear: the lookaheads are anchored at the start and each scans the (at most 512-character) string once.
 */
const PATH_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)(?![\s\S]*[\u0000-\u001f\u007f-\u009f])(?:assets|layers)\/[^\\:%?#]+$/;

const id = z.string().max(COMPOSITION_LIMITS.id).regex(ID_RE, 'composition.badId')
  .describe('Lowercase letters, digits and hyphens; unique in the composition.');
const color = z.string().max(9).regex(COLOR_RE, 'composition.badColor').describe('Hex colour: #rgb, #rgba, #rrggbb or #rrggbbaa.');
const path = z.string().max(COMPOSITION_PATH_MAX).regex(PATH_RE, 'composition.badPath').refine(isCompositionPath, 'composition.badPath')
  .describe('Relative to the composition folder, under assets/ or layers/; no scheme, no "..", no backslash.');
const family = z.string().max(COMPOSITION_LIMITS.family).regex(FAMILY_RE, 'composition.badFontFamily')
  .describe('A family declared in fonts[] (no fallbacks or generic families).');
const name = z.string().max(COMPOSITION_LIMITS.name);
const ease = z.string().max(64).regex(EASE_RE, 'composition.badEase').describe('CSS easing: linear, ease-out, cubic-bezier(...), steps(...).');
const coord = z.number().min(-COORD).max(COORD);
const seconds = z.number().min(0).max(COMPOSITION_LIMITS.durationSec);
const weight = z.union([z.number().int().min(1).max(1000), z.enum(['normal', 'bold'])]);

export const fontRefSchema = z.strictObject({
  family,
  src: path.describe('A font file (.ttf, .otf, .woff, .woff2) under assets/.'),
  weight: weight.optional(),
  style: z.enum(['normal', 'italic']).optional(),
});
export type FontRef = z.infer<typeof fontRefSchema>;

export const sceneSchema = z.strictObject({
  id,
  name: name.optional(),
  start: seconds,
  duration: z.number().gt(0).max(COMPOSITION_LIMITS.durationSec),
}).describe('A named time range. Scenes are listed in order, contiguous, and cover the whole duration.');
export type Scene = z.infer<typeof sceneSchema>;

export const ANIMATION_PRESETS = ['fadeIn', 'fadeOut', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'popIn', 'scaleIn', 'wipe'] as const;
export const ANIMATABLE_PROPS = ['opacity', 'x', 'y', 'scale', 'rotation', 'color', 'blur'] as const;
const animValue = z.union([z.number().min(-COORD).max(COORD), color]).describe('A number, or a hex colour for prop "color".');
const animDuration = z.number().gt(0).max(COMPOSITION_LIMITS.durationSec);

const presetAnimation = z.strictObject({
  preset: z.enum(ANIMATION_PRESETS), start: seconds.optional(), duration: animDuration, ease: ease.optional(),
});
const tweenAnimation = z.strictObject({
  prop: z.enum(ANIMATABLE_PROPS), from: animValue, to: animValue, start: seconds.optional(), duration: animDuration, ease: ease.optional(),
});
const keyframesAnimation = z.strictObject({
  prop: z.enum(ANIMATABLE_PROPS),
  keyframes: z.array(z.strictObject({ t: z.number().min(0).max(1), v: animValue, ease: ease.optional() })).min(2).max(COMPOSITION_LIMITS.keyframes),
  start: seconds.optional(),
  duration: animDuration,
});
export const animationSchema = z.union([presetAnimation, tweenAnimation, keyframesAnimation])
  .describe('Times relative to the clip start. A preset, a from/to tween of one prop, or keyframes (t from 0 to 1, ascending) of one prop.');
export type Animation = z.infer<typeof animationSchema>;

const boxShape = {
  x: coord.optional(), y: coord.optional(), width: z.number().min(0).max(COORD).optional(), height: z.number().min(0).max(COORD).optional(),
  rotation: z.number().min(-COMPOSITION_BOUNDS.rotation).max(COMPOSITION_BOUNDS.rotation).optional(), scale: z.number().min(0).max(100).optional(), opacity: z.number().min(0).max(1).optional(),
};
const box = z.strictObject(boxShape).describe('Composition pixels; rotation (degrees) and scale apply around the box centre.');
const clipBase = {
  id,
  name: name.optional(),
  scene: id.optional().describe('The scene this clip belongs to: moving the scene moves the clip. The clip must lie inside it.'),
  start: seconds.describe('Seconds, absolute on the composition timeline.'),
  duration: seconds,
  hidden: z.boolean().optional().describe('The editor hides the clip: it is not rendered. Set by the user; leave it as it is.'),
  locked: z.boolean().optional().describe('The user locked the clip against direct edits in the editor. Set by the user; leave it as it is.'),
};
const animations = z.array(animationSchema).max(COMPOSITION_LIMITS.animations).optional();
const kenBurnsEnd = z.strictObject({ scale: z.number().min(0).max(100).optional(), x: coord.optional(), y: coord.optional() });

const textClip = z.strictObject({
  ...clipBase, type: z.literal('text'),
  props: z.strictObject({
    ...boxShape,
    text: z.string().max(COMPOSITION_LIMITS.text),
    fontFamily: family.optional(),
    fontSize: z.number().gt(0).max(COMPOSITION_BOUNDS.fontSize).optional(),
    fontWeight: weight.optional(),
    color: color.optional(),
    align: z.enum(TEXT_ALIGNS).optional(),
  }),
  animations,
});
const shapeClip = z.strictObject({
  ...clipBase, type: z.literal('shape'),
  props: z.strictObject({ ...boxShape, fill: color.optional(), radius: z.number().min(0).max(COORD).optional() }),
  animations,
});
const pictureProps = z.strictObject({
  ...boxShape,
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  kenBurns: z.strictObject({ from: kenBurnsEnd, to: kenBurnsEnd }).optional(),
});
const imageClip = z.strictObject({ ...clipBase, type: z.literal('image'), src: path, props: pictureProps, animations });
const svgClip = z.strictObject({ ...clipBase, type: z.literal('svg'), src: path, props: pictureProps, animations });
const videoClip = z.strictObject({
  ...clipBase, type: z.literal('video'), src: path,
  trimStart: z.number().min(0).max(COMPOSITION_BOUNDS.trimStart).optional().describe('Seconds skipped at the start of the source.'),
  sourceFps: z.number().gt(0).max(240).optional(),
  volume: z.number().min(0).max(COMPOSITION_BOUNDS.volume).optional(),
  props: box, animations,
});
const htmlParam = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().max(COMPOSITION_LIMITS.text), label: name.optional() }),
  z.strictObject({ type: z.literal('color'), value: color, label: name.optional() }),
  z.strictObject({ type: z.literal('number'), value: z.number().min(-1e9).max(1e9), label: name.optional() }),
  z.strictObject({ type: z.literal('image'), value: path, label: name.optional() }),
]);
const htmlClip = z.strictObject({
  ...clipBase, type: z.literal('html'),
  src: path.describe('An .html file under layers/.'),
  params: z.record(z.string().regex(PARAM_KEY_RE, 'composition.badParamKey'), htmlParam).optional()
    .describe('The only values the editor exposes for a free layer; the layer reads them from window.msParams.'),
  props: box, animations,
});
const audioClip = z.strictObject({
  ...clipBase, type: z.literal('audio'), src: path,
  trimStart: z.number().min(0).max(COMPOSITION_BOUNDS.trimStart).optional(),
  volume: z.number().min(0).max(COMPOSITION_BOUNDS.volume).optional(),
  fadeIn: seconds.optional(),
  fadeOut: seconds.optional(),
  role: z.enum(['voice', 'music', 'sfx']).optional().describe('Lets the mixer duck music under voice.'),
  script: z.string().max(5000).optional().describe('The spoken text of a voice clip (role "voice" only); used to translate the voice.'),
}).refine((c) => c.script === undefined || c.role === 'voice', { message: 'composition.scriptNeedsVoice', path: ['script'] });

export const CLIP_TYPES = ['text', 'shape', 'image', 'svg', 'video', 'html', 'audio'] as const;
export const clipSchema = z.discriminatedUnion('type', [textClip, shapeClip, imageClip, svgClip, videoClip, htmlClip, audioClip]);
export type Clip = z.infer<typeof clipSchema>;

export const trackSchema = z.strictObject({
  id,
  kind: z.enum(['visual', 'video', 'text', 'audio']),
  name: name.optional(),
  muted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  clips: z.array(clipSchema).max(COMPOSITION_LIMITS.clipsPerTrack),
});
export type Track = z.infer<typeof trackSchema>;

export const compositionSchema = z.strictObject({
  $schema: z.literal(COMPOSITION_SCHEMA_ID),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.literal([24, 25, 30, 50, 60]),
  duration: seconds.describe('Seconds. 0 for a still (image formats): one frame at t = 0.'),
  background: color,
  fonts: z.array(fontRefSchema).max(COMPOSITION_LIMITS.fonts),
  fontFallbacks: z.array(family).max(3).optional().describe('Declared families tried after a text clip\'s own family, before the generic fallback (per character). Set by localization for scripts the font lacks; leave it as it is.'),
  scenes: z.array(sceneSchema).max(COMPOSITION_LIMITS.scenes),
  tracks: z.array(trackSchema).max(COMPOSITION_LIMITS.tracks).describe('Stacking order: the first track is at the bottom. Audio tracks do not render.'),
});
export type Composition = z.infer<typeof compositionSchema>;

/**
 * The JSON Schema (2020-12) of `compositionSchema`, as given to the agent (`.studio/composition.schema.json`). The checked-in
 * `composition.schema.json` must equal this (a test enforces it); regenerate it with
 * `pnpm --filter @motion-studio/shared gen:composition-schema`. Semantic rules (contiguous scenes, clips in range, declared
 * fonts, assets present) are not expressible here: `validateComposition` checks them.
 */
export function compositionJsonSchema(): Record<string, unknown> {
  // Named $defs (a local registry, not zod's global one) keep the file readable and small for the agent.
  const defs = z.registry<{ id: string }>();
  const named: Array<[z.ZodType, string]> = [
    [id, 'id'], [color, 'color'], [path, 'path'], [family, 'fontFamily'], [ease, 'easing'], [animValue, 'animationValue'],
    [animationSchema, 'animation'], [box, 'box'], [pictureProps, 'pictureProps'], [kenBurnsEnd, 'kenBurnsEnd'], [weight, 'fontWeight'],
    [htmlParam, 'htmlParam'], [fontRefSchema, 'font'], [sceneSchema, 'scene'], [trackSchema, 'track'], [clipSchema, 'clip'],
    [textClip, 'textClip'], [shapeClip, 'shapeClip'], [imageClip, 'imageClip'], [svgClip, 'svgClip'], [videoClip, 'videoClip'],
    [htmlClip, 'htmlClip'], [audioClip, 'audioClip'],
  ];
  for (const [schema, name] of named) defs.add(schema, { id: name });
  // The generator only reads metadata with `get`: merge the local ids over the global registry so `.describe()` texts stay.
  // UPGRADE CHECKLIST (zod): this shim relies on a zod internal, namely that `z.toJSONSchema` reads the `metadata` registry
  // only through `.get(schema)` (zod 4.6, core/to-json-schema.js). After any zod upgrade, run
  // `pnpm --filter @motion-studio/shared gen:composition-schema` and check that the diff of composition.schema.json still has
  // the named $defs and the descriptions; the "equals the generated one" test catches a silent change in CI.
  const metadata = { get: (s: z.ZodType) => { const g = z.globalRegistry.get(s); const l = defs.get(s); return g || l ? { ...g, ...l } : undefined; } };
  const generated = z.toJSONSchema(compositionSchema, {
    target: 'draft-2020-12', io: 'input', unrepresentable: 'any', metadata: metadata as unknown as typeof defs,
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: COMPOSITION_SCHEMA_ID,
    title: 'Motion Studio composition',
    description: 'One composition.json per format. Semantic rules beyond this schema: scenes are contiguous from 0 to duration '
      + '(a video with no scenes gets one implicit scene); clips lie inside the duration (and inside their scene); every '
      + 'fontFamily is declared in fonts[] with a font file under assets/ (a text clip without fontFamily uses fonts[0]); every '
      + 'referenced file exists; html layers live in layers/ and never use the network, Workers, AudioContext or autoplaying '
      + 'media. A still (duration 0, image formats) shows t = 0 only: its scenes, animations and audio are ignored.',
    ...rest,
  };
}
