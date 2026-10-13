import { declaredWeights, weightNumber } from './fonts.ts';
import type { FormatPreset } from '../formats.ts';
import { compositionProblem, type CompositionProblem } from './problems.ts';
import { implicitSceneId, normalizeComposition } from './normalize.ts';
import { COMPOSITION_LIMITS, compositionSchema, type Composition } from './schema.ts';

/** Default size limit of a composition folder (every file together): 500 MB. Callers may pass another `maxBytes`. */
export const COMPOSITION_MAX_BYTES = 500 * 1024 * 1024;
/** Tolerance on times (seconds) when comparing scene and clip edges, well below one frame at 60 fps. */
const EPS = 1e-4;
const MB = 1024 * 1024;
const FONT_EXT = ['.ttf', '.otf', '.woff', '.woff2'];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

export interface CompositionContext {
  /** The format the composition is for: size, kind (video or still image) and maximum duration are checked against it. */
  format: FormatPreset;
  /** Every regular file of the composition folder, by path relative to it (`composition.json`, `assets/…`, `layers/…`). */
  files: ReadonlyMap<string, { size: number }>;
  /** Size limit of the whole folder in bytes; default `COMPOSITION_MAX_BYTES`. */
  maxBytes?: number;
}
/**
 * `ok` is true when there are no `problems`. `warnings` never block: things the runtime ignores (scenes, animations and audio
 * on a still), shown to the agent and the user so they can tidy up.
 */
export interface CompositionValidation { ok: boolean; problems: CompositionProblem[]; warnings: CompositionProblem[] }

const p = (key: string, params: CompositionProblem['params'] = {}): CompositionProblem => compositionProblem(`composition.${key}`, params);
const round1 = (n: number) => Math.round(n * 10) / 10;
const secs = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Decodes `composition.json`: rejects a file over `COMPOSITION_LIMITS.jsonBytes`, bytes that are not valid UTF-8, an empty
 * (or BOM-only, or whitespace-only) file and invalid JSON, each with one translated problem. A leading UTF-8 BOM is skipped.
 */
/**
 * The one size rule of a draft (final review M5): the UTF-8 bytes of the COMPACT JSON of its normalised form, against
 * `COMPOSITION_LIMITS.jsonBytes`. The editor checks it before Save, the core at save (it then writes the file indented
 * only when that still fits), the runtime on the same compact text.
 */
export function draftJsonBytes(c: unknown): number {
  return new TextEncoder().encode(JSON.stringify(normalizeComposition(c))).length;
}
/** `composition.jsonTooLarge` for a draft over the limit (see `draftJsonBytes`), else null. */
export function draftSizeProblem(c: unknown): CompositionProblem | null {
  const bytes = draftJsonBytes(c);
  return bytes > COMPOSITION_LIMITS.jsonBytes ? p('jsonTooLarge', { sizeMB: round1(bytes / MB), maxMB: round1(COMPOSITION_LIMITS.jsonBytes / MB) }) : null;
}

export function parseCompositionText(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; problems: CompositionProblem[] } {
  if (bytes.length > COMPOSITION_LIMITS.jsonBytes) {
    return { ok: false, problems: [p('jsonTooLarge', { sizeMB: round1(bytes.length / MB), maxMB: round1(COMPOSITION_LIMITS.jsonBytes / MB) })] };
  }
  const bom = UTF8_BOM.every((b, i) => bytes[i] === b);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return { ok: false, problems: [p('jsonNotUtf8')] };
  }
  if (text.trim() === '') return { ok: false, problems: [p('jsonEmpty')] };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, problems: [p('jsonSyntax', { detail: String((err as Error).message).slice(0, 200) })] };
  }
}

/**
 * Validates a parsed composition for one format: structure (the zod schema) then the semantic rules the schema cannot say.
 * Bounded: the array sizes of `COMPOSITION_LIMITS` are checked first without walking the arrays, and at most
 * `COMPOSITION_LIMITS.problems` problems (and as many warnings) are returned (plus `composition.moreProblems`). It accepts
 * what `normalizeComposition` would fill in (a text clip without `fontFamily` uses `fonts[0]`; a video without scenes has
 * one implicit scene), so normalizing first changes nothing here. Semantic rules:
 * - ids are unique across scenes, tracks and clips;
 * - scenes, taken in time order, start at 0, each starts where the previous ends (no gap, no overlap) and the last ends at
 *   `duration`;
 * - each clip lies inside the duration and inside its scene; a clip's scene exists; audio clips are on audio tracks and only
 *   there. In a still (duration 0) every clip starts at 0; its scenes, animations and audio are only warnings (ignored);
 * - animations end within their clip (one frame of tolerance); keyframe times go up; `color` animates colours and every
 *   other prop numbers;
 * - every text clip's font (its `fontFamily`, or `fonts[0]`) is declared in `fonts[]`; generic CSS families are not fonts;
 *   every font is a font file under `assets/`;
 * - html clips point to an `.html` file under `layers/`, media clips (and image params) to a file under `assets/`;
 *   every referenced file exists in `ctx.files` (paths compared in NFC);
 * - the folder is within `ctx.maxBytes`;
 * - the size equals the format's; a video format needs a duration > 0 within its maximum, an image format a still.
 */
export function validateComposition(c: unknown, ctx: CompositionContext): CompositionValidation {
  const limit = preflight(c);
  if (limit) return { ok: false, problems: [limit], warnings: [] };
  const parsed = compositionSchema.safeParse(c);
  const { problems, warnings } = parsed.success
    ? semantic(parsed.data, ctx)
    : { problems: structural(parsed.error.issues as unknown as Issue[], c), warnings: [] };
  return { ok: problems.length === 0, problems: cap(dedupe(problems)), warnings: cap(dedupe(warnings)) };
}

function cap(problems: CompositionProblem[]): CompositionProblem[] {
  return problems.length <= COMPOSITION_LIMITS.problems ? problems : [...problems.slice(0, COMPOSITION_LIMITS.problems), p('moreProblems')];
}
function dedupe(problems: CompositionProblem[]): CompositionProblem[] {
  const seen = new Set<string>();
  return problems.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- bounds (before anything walks the input) ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lengthOver = (v: unknown, max: number) => Array.isArray(v) && v.length > max;

function preflight(c: unknown): CompositionProblem | null {
  if (!isObject(c)) return p('wrongType', { path: '$', expected: 'object' });
  if (lengthOver(c.tracks, COMPOSITION_LIMITS.tracks)) return p('limit', { path: 'tracks', max: COMPOSITION_LIMITS.tracks });
  if (lengthOver(c.scenes, COMPOSITION_LIMITS.scenes)) return p('limit', { path: 'scenes', max: COMPOSITION_LIMITS.scenes });
  if (lengthOver(c.fonts, COMPOSITION_LIMITS.fonts)) return p('limit', { path: 'fonts', max: COMPOSITION_LIMITS.fonts });
  if (!Array.isArray(c.tracks)) return null;
  let total = 0;
  for (let t = 0; t < c.tracks.length; t++) {
    const clips = isObject(c.tracks[t]) ? (c.tracks[t] as Record<string, unknown>).clips : undefined;
    if (!Array.isArray(clips)) continue;
    if (clips.length > COMPOSITION_LIMITS.clipsPerTrack) return p('limit', { path: `tracks[${t}].clips`, max: COMPOSITION_LIMITS.clipsPerTrack });
    total += clips.length;
  }
  if (total > COMPOSITION_LIMITS.clips) return p('limit', { path: 'tracks[].clips', max: COMPOSITION_LIMITS.clips });
  for (let t = 0; t < c.tracks.length; t++) {
    const clips = (c.tracks[t] as Record<string, unknown> | undefined)?.clips;
    if (!Array.isArray(clips)) continue;
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (!isObject(clip)) continue;
      const at = `tracks[${t}].clips[${i}]`;
      if (lengthOver(clip.animations, COMPOSITION_LIMITS.animations)) return p('limit', { path: `${at}.animations`, max: COMPOSITION_LIMITS.animations });
      if (isObject(clip.params)) {
        // Counting keys without materialising a huge key list.
        let keys = 0;
        for (const k in clip.params) { if (Object.hasOwn(clip.params, k) && ++keys > COMPOSITION_LIMITS.params) return p('limit', { path: `${at}.params`, max: COMPOSITION_LIMITS.params }); }
      }
      if (Array.isArray(clip.animations)) {
        for (let a = 0; a < clip.animations.length; a++) {
          const anim = clip.animations[a];
          if (isObject(anim) && lengthOver(anim.keyframes, COMPOSITION_LIMITS.keyframes)) return p('limit', { path: `${at}.animations[${a}].keyframes`, max: COMPOSITION_LIMITS.keyframes });
        }
      }
    }
  }
  return null;
}

// ---------- structure (zod issues → problems) ----------

interface Issue { code: string; path: PropertyKey[]; message: string; [k: string]: unknown }

const pathText = (path: readonly PropertyKey[]) => {
  let out = '';
  for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : out === '' ? String(seg) : `.${String(seg)}`;
  return out === '' ? '$' : out;
};
function valueAt(root: unknown, path: readonly PropertyKey[]): { found: boolean; value: unknown } {
  let v: unknown = root;
  for (const seg of path) {
    if (typeof v !== 'object' || v === null || !Object.hasOwn(v, seg as PropertyKey)) return { found: false, value: undefined };
    v = (v as Record<PropertyKey, unknown>)[seg as PropertyKey];
  }
  return { found: true, value: v };
}

function structural(issues: readonly Issue[], root: unknown, prefix: PropertyKey[] = []): CompositionProblem[] {
  return issues.flatMap((issue) => mapIssue(issue, root, [...prefix, ...issue.path]));
}

function mapIssue(issue: Issue, root: unknown, path: PropertyKey[]): CompositionProblem[] {
  const at = pathText(path);
  if (issue.message.startsWith('composition.')) return [{ key: issue.message, params: { path: at } }];
  const missing = !valueAt(root, path).found;
  switch (issue.code) {
    case 'unrecognized_keys':
      return (issue.keys as string[]).map((field) => p('unknownField', { path: at, field }));
    case 'invalid_type':
      return [missing ? p('missingField', { path: at }) : p('wrongType', { path: at, expected: String(issue.expected) })];
    case 'invalid_value':
      return [missing ? p('missingField', { path: at }) : p('badValue', { path: at, allowed: (issue.values as unknown[]).map(String).join(', ') })];
    case 'too_big':
      if (issue.origin === 'array') return [p('limit', { path: at, max: Number(issue.maximum) })];
      if (issue.origin === 'string') return [p('tooLong', { path: at, max: Number(issue.maximum) })];
      return [p('tooBig', { path: at, max: Number(issue.maximum) })];
    case 'invalid_key':
      // A record key that failed its own schema (e.g. a param name): report the key's own issues, custom messages included.
      return structural((issue.issues as Issue[]) ?? [], root, path);
    case 'too_small':
      return [p(issue.inclusive === false ? 'notAbove' : 'tooSmall', { path: at, min: Number(issue.minimum) })];
    case 'invalid_union': {
      if (missing) return [p('missingField', { path: at })];
      if (issue.note === 'No matching discriminator') return [p('badValue', { path: at, allowed: (issue.options as unknown[]).map(String).join(', ') })];
      const n = path.length;
      if (n >= 2 && typeof path[n - 1] === 'number' && path[n - 2] === 'animations') return [p('badAnimation', { path: at })];
      const branches = (issue.errors as Issue[][]) ?? [];
      const simple = branches.every((b) => b.length === 1 && b[0]!.path.length === 0 && (b[0]!.code === 'invalid_type' || b[0]!.code === 'invalid_value'));
      if (simple) {
        const allowed = branches.map((b) => (b[0]!.code === 'invalid_value' ? (b[0]!.values as unknown[]).map(String).join(', ') : `a ${String(b[0]!.expected)}`));
        return [p('badValue', { path: at, allowed: allowed.join(', ') })];
      }
      // The closest branch: the one whose type matched (its first issue is not a type mismatch), with the fewest issues.
      const close = branches.filter((b) => b.length > 0 && b[0]!.code !== 'invalid_type').sort((a, b) => a.length - b.length)[0];
      return close ? structural(close, root, path) : [p('invalid', { path: at })];
    }
    default:
      return [p('invalid', { path: at })];
  }
}

// ---------- semantic rules ----------

function semantic(c: Composition, ctx: CompositionContext): { problems: CompositionProblem[]; warnings: CompositionProblem[] } {
  const out: CompositionProblem[] = [];
  const warnings: CompositionProblem[] = [];
  const still = c.duration === 0;
  /** One frame: the tolerance for an animation running past its clip. */
  const frame = 1 / c.fps;

  // Ids.
  const ids = new Set<string>();
  const dup = new Set<string>();
  const seeId = (id: string) => { if (ids.has(id) && !dup.has(id)) { dup.add(id); out.push(p('duplicateId', { id })); } ids.add(id); };
  for (const s of c.scenes) seeId(s.id);
  for (const t of c.tracks) { seeId(t.id); for (const k of t.clips) seeId(k.id); }

  // Scenes, in time order (a copy: the file's order is kept). A video without scenes has one implicit scene (see
  // `normalizeComposition`), so it is contiguous by definition.
  const ordered = c.scenes.length === 0 && !still
    ? [{ id: implicitSceneId(c), start: 0, duration: c.duration }]
    : [...c.scenes].sort((a, b) => a.start - b.start);
  const scenes = new Map<string, { start: number; end: number }>();
  for (const s of ordered) if (!scenes.has(s.id)) scenes.set(s.id, { start: s.start, end: s.start + s.duration });
  if (still) {
    if (c.scenes.length > 0) warnings.push(p('stillScenes'));
  } else {
    const first = ordered[0]!;
    if (first.start > EPS) out.push(p('sceneStart', { scene: first.id, start: secs(first.start) }));
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!; const s = ordered[i]!;
      const prevEnd = prev.start + prev.duration;
      const params = { scene: s.id, previous: prev.id, from: secs(prevEnd), to: secs(s.start) };
      if (s.start < prevEnd - EPS) out.push(p('sceneOverlap', params));
      else if (s.start > prevEnd + EPS) out.push(p('sceneGap', params));
    }
    const end = ordered.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
    if (Math.abs(end - c.duration) > EPS) out.push(p('scenesEnd', { end: secs(end), duration: c.duration }));
  }

  // Fonts.
  const families = new Set<string>();
  const referenced: string[] = [];
  for (const f of c.fonts) {
    families.add(f.family.toLowerCase());
    const lower = f.src.toLowerCase();
    if (!f.src.startsWith('assets/') || !FONT_EXT.some((e) => lower.endsWith(e))) out.push(p('fontNotAsset', { family: f.family, src: f.src }));
    referenced.push(f.src);
  }

  // Tracks and clips.
  for (const t of c.tracks) {
    let audioReported = false;
    for (const k of t.clips) {
      if ((t.kind === 'audio') !== (k.type === 'audio')) out.push(p('trackKind', { track: t.id, clip: k.id, kind: t.kind, type: k.type }));
      const end = k.start + k.duration;
      if (still) {
        if (k.type === 'audio' && !audioReported) { audioReported = true; warnings.push(p('stillAudio', { track: t.id })); }
        if (k.type !== 'audio' && k.animations && k.animations.length > 0) warnings.push(p('stillAnimations', { clip: k.id }));
        if (k.start > EPS) out.push(p('clipStill', { clip: k.id }));
      } else if (k.duration <= 0) {
        out.push(p('clipZero', { clip: k.id }));
      } else if (end > c.duration + EPS || k.start >= c.duration) {
        out.push(p('clipOutside', { clip: k.id, start: secs(k.start), end: secs(end), duration: c.duration }));
      }
      if (k.scene !== undefined) {
        const s = scenes.get(k.scene);
        if (!s) out.push(p('unknownScene', { clip: k.id, scene: k.scene }));
        else if (!still && (k.start < s.start - EPS || end > s.end + EPS)) out.push(p('clipOutsideScene', { clip: k.id, scene: k.scene, start: secs(s.start), end: secs(s.end) }));
      }
      if (!still && k.type !== 'audio' && k.animations) checkAnimations(k.id, k.duration, k.animations, frame, out);
      if (k.type === 'text') {
        const family = k.props.fontFamily ?? c.fonts[0]?.family;
        if (family === undefined) out.push(p('fontMissing', { clip: k.id }));
        else if (!families.has(family.toLowerCase())) out.push(p('unknownFont', { clip: k.id, family }));
        else {
          // A weight the family does not declare is drawn synthesised or from a neighbour: a warning, not a problem (one file for
          // regular and bold is common and renders), and only for families that declare weights at all.
          const declared = declaredWeights(c.fonts, family);
          const weight = weightNumber(k.props.fontWeight);
          if (declared && !declared.includes(weight)) warnings.push(p('fontWeightUndeclared', { clip: k.id, family, weight, declared: declared.join(', ') }));
        }
      }
      if (k.type === 'html') {
        if (!k.src.startsWith('layers/') || !k.src.toLowerCase().endsWith('.html')) out.push(p('layerNotHtml', { clip: k.id, src: k.src }));
        referenced.push(k.src);
        for (const param of Object.values(k.params ?? {})) {
          if (param.type !== 'image') continue;
          if (!param.value.startsWith('assets/')) out.push(p('mediaNotAsset', { clip: k.id, src: param.value }));
          referenced.push(param.value);
        }
      } else if (k.type === 'image' || k.type === 'svg' || k.type === 'video' || k.type === 'audio') {
        if (!k.src.startsWith('assets/')) out.push(p('mediaNotAsset', { clip: k.id, src: k.src }));
        referenced.push(k.src);
      }
    }
  }

  // Files.
  const present = new Set<string>();
  let total = 0;
  for (const [path, info] of ctx.files) { present.add(path.normalize('NFC')); total += Number.isFinite(info.size) && info.size > 0 ? info.size : 0; }
  const reported = new Set<string>();
  for (const path of referenced) {
    const key = path.normalize('NFC');
    if (present.has(key) || reported.has(key)) continue;
    reported.add(key);
    out.push(p('assetMissing', { path }));
  }
  const maxBytes = ctx.maxBytes ?? COMPOSITION_MAX_BYTES;
  if (total > maxBytes) out.push(p('assetsTooLarge', { sizeMB: round1(total / MB), maxMB: round1(maxBytes / MB) }));

  // Format.
  const f = ctx.format;
  if (c.width !== f.width || c.height !== f.height) {
    out.push(p('sizeMismatch', { width: c.width, height: c.height, expectedWidth: f.width, expectedHeight: f.height, format: f.id }));
  }
  if (f.kind === 'video') {
    if (still) out.push(p('stillForVideo', { format: f.id }));
    else if (f.maxDurationSec !== undefined && c.duration > f.maxDurationSec + EPS) out.push(p('durationOverMax', { duration: c.duration, max: f.maxDurationSec, format: f.id }));
  } else if (!still) {
    out.push(p('durationForImage', { format: f.id, duration: c.duration }));
  }
  return { problems: out, warnings };
}

type Anim = NonNullable<Extract<Composition['tracks'][number]['clips'][number], { animations?: unknown }>['animations']>[number];

function checkAnimations(clip: string, clipDuration: number, animations: Anim[], frame: number, out: CompositionProblem[]): void {
  let outside = false; let order = false; let value = false;
  for (const a of animations) {
    const end = (a.start ?? 0) + a.duration;
    if (!outside && end > clipDuration + frame + EPS) { outside = true; out.push(p('animationOutside', { clip, end: secs(end), duration: secs(clipDuration) })); }
    if (!('prop' in a)) continue;
    const wantColor = a.prop === 'color';
    const values = 'keyframes' in a ? a.keyframes.map((kf) => kf.v) : [a.from, a.to];
    if (!value && values.some((v) => (typeof v === 'string') !== wantColor)) { value = true; out.push(p('animationValue', { clip, prop: a.prop })); }
    if (!order && 'keyframes' in a && a.keyframes.some((kf, i) => i > 0 && kf.t < a.keyframes[i - 1]!.t)) { order = true; out.push(p('keyframesOrder', { clip })); }
  }
}
