import { compositionProblem, type CompositionProblem } from '../problems.ts';
import { normalizeComposition } from '../normalize.ts';
import { declaredWeights, weightNumber } from '../fonts.ts';
import { isCompositionPath } from '../paths.ts';
import { COMPOSITION_LIMITS, compositionSchema, trackLocked, type Clip, type Composition, type Scene, type Track } from '../schema.ts';
import { ADD_FONT_MAX_WEIGHTS, type EditContext, type EditOp, type EditResult } from './ops.ts';

/** Tolerance on times (seconds), well below one frame at 60 fps (same as the validator). */
const EPS = 1e-4;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_EXT = ['.ttf', '.otf', '.woff', '.woff2'];

const BOX_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity'];
const TEXT_KEYS = ['text', 'fontFamily', 'fontSize', 'fontWeight', 'color', 'align'];
const SHAPE_KEYS = ['fill', 'radius'];
const KEYS_BY_TYPE: Record<Clip['type'], string[]> = {
  text: [...BOX_KEYS, ...TEXT_KEYS], shape: [...BOX_KEYS, ...SHAPE_KEYS], image: BOX_KEYS, svg: BOX_KEYS, video: BOX_KEYS, html: BOX_KEYS, audio: [], subtitles: [],
};

class Refusal extends Error {
  constructor(readonly problem: CompositionProblem) { super(problem.key); }
}
function refuse(key: string, params: CompositionProblem['params'] = {}): never { throw new Refusal(compositionProblem(key, params)); }
const r = (n: number) => Math.round(n * 1e6) / 1e6;
/** One frame, rounded up to the precision of times so a clamped clip is never shorter than a frame. */
const frameOf = (fps: number) => Math.ceil(1e6 / fps) / 1e6;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown, clip: string, key: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : refuse('editor.badValue', { clip, key }));

/**
 * Applies one edit to a composition. Pure: `c` is never mutated, the result is a normalized copy. Either the edited
 * composition (which passes the composition schema and keeps the rules the editor can break: contiguous scenes, clips inside
 * their scene and the duration, animations inside their clip) or one refusal. Format rules (maximum duration, size) and file
 * checks beyond `ctx.files` stay with `validateComposition`, which the caller runs on the result.
 *
 * - A locked clip, or a clip on a locked track, refuses every op but `clipFlags` and `trackFlags` (`editor.locked`). Scene ops
 *   move locked clips along with their scene, but refuse to resize one.
 * - `ctx.files`, when given, is the set of paths a new `src`, image param or font may point to.
 */
export function applyEdit(c: Composition, op: EditOp, ctx: EditContext = {}): EditResult {
  try {
    const w = normalizeComposition(structuredClone(c));
    run(w, op, ctx);
    const out = normalizeComposition(w);
    const parsed = compositionSchema.safeParse(out);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return { ok: false, problem: compositionProblem('editor.invalid', { path: issue.path.map(String).join('.') || '$' }) };
    }
    return { ok: true, composition: out };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, problem: e.problem };
    throw e;
  }
}

// ---------- lookups ----------

function locate(w: Composition, clipId: string): { track: Track; clip: Clip } {
  for (const track of w.tracks) for (const clip of track.clips) if (clip.id === clipId) return { track, clip };
  return refuse('editor.unknownClip', { clip: clipId });
}
function locateUnlocked(w: Composition, clipId: string): { track: Track; clip: Clip } {
  const found = locate(w, clipId);
  if (found.clip.locked || trackLocked(found.track)) refuse('editor.locked', { clip: clipId });
  return found;
}
const byTime = (w: Composition): Scene[] => [...w.scenes].sort((a, b) => a.start - b.start);
const allClips = (w: Composition): Array<{ track: Track; clip: Clip }> => w.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));

/** The scene a clip moves with: its `scene`, or the only scene that contains it. */
function owner(k: Clip, scenes: Scene[]): Scene | undefined {
  if (k.scene !== undefined) return scenes.find((s) => s.id === k.scene);
  const end = k.start + k.duration;
  const inside = scenes.filter((s) => k.start >= s.start - EPS && end <= s.start + s.duration + EPS);
  return inside.length === 1 ? inside[0] : undefined;
}

/**
 * Whether scenes can be reordered: every clip that is not audio (or subtitles) lies inside exactly one scene (its `scene`, or the only one
 * that contains it). Audio clips spanning several scenes are fine: they stay where they are.
 */
export function sceneOrderAllowed(c: Composition): { ok: true } | { ok: false; clipId: string } {
  const w = normalizeComposition(c);
  if (w.duration === 0) return { ok: true };
  const scenes = byTime(w);
  for (const { clip } of allClips(w)) {
    if (clip.type === 'audio' || clip.type === 'subtitles') continue;
    if (!owner(clip, scenes)) return { ok: false, clipId: clip.id };
  }
  return { ok: true };
}

// ---------- animations ----------

type Anim = NonNullable<Extract<Clip, { animations?: unknown }>['animations']>[number];
const isPreset = (a: Anim): a is Extract<Anim, { preset: string }> => 'preset' in a;
const animationsOf = (k: Clip): Anim[] | undefined => (k.type === 'audio' || k.type === 'subtitles' ? undefined : k.animations);

/** Refits a clip's animations to a new duration. Presets are moved or shortened; a custom animation that would end past the clip refuses. */
function fitAnimations(k: Clip, newDuration: number, fps: number): void {
  const list = animationsOf(k);
  if (!list || newDuration === k.duration) return;
  const old = k.duration;
  const frame = 1 / fps;
  for (const a of list) {
    const start = a.start ?? 0;
    if (!isPreset(a)) {
      const end = start + a.duration;
      if (end > newDuration + frame + EPS) refuse('composition.animationOutside', { clip: k.id, end: r(end), duration: r(newDuration) });
      continue;
    }
    if (start <= EPS) { a.duration = r(Math.min(a.duration, newDuration)); continue; }
    if (Math.abs(start + a.duration - old) <= EPS) {
      a.duration = r(Math.min(a.duration, newDuration));
      a.start = r(newDuration - a.duration);
      continue;
    }
    const s = clamp(start, 0, newDuration - frame);
    a.start = r(s);
    a.duration = r(Math.min(a.duration, newDuration - s));
  }
}

// ---------- scenes ----------

function shift(k: Clip, delta: number): void { k.start = r(k.start + delta); }

/**
 * Resizes a scene: later scenes and their clips shift, clips that ran to the end of the composition (or past this scene's
 * end) stretch, clips that would stick out of a shrunk scene are clamped. `skip` is a clip the caller places itself.
 */
function resizeScene(w: Composition, sceneId: string, newDuration: number, skip?: string): void {
  const scenes = byTime(w);
  const index = scenes.findIndex((s) => s.id === sceneId);
  if (index < 0) refuse('editor.unknownScene', { scene: sceneId });
  const scene = scenes[index]!;
  const oldEnd = scene.start + scene.duration;
  const newEnd = scene.start + newDuration;
  const delta = newEnd - oldEnd;
  if (Math.abs(delta) <= EPS) return;
  const last = index === scenes.length - 1;
  const oldTotal = w.duration;
  const minD = frameOf(w.fps);
  const owners = allClips(w).map(({ track, clip }) => ({ track, clip, owner: owner(clip, scenes) }));

  const setEnd = (track: Track, k: Clip, end: number): void => {
    const d = r(end - k.start);
    if (d < minD - EPS) refuse('composition.clipOutsideScene', { clip: k.id, scene: scene.id, start: r(scene.start), end: r(newEnd) });
    if (k.locked || trackLocked(track)) refuse('editor.locked', { clip: k.id });
    fitAnimations(k, d, w.fps);
    k.duration = d;
  };

  for (const { track, clip, owner: o } of owners) {
    if (clip.id === skip || clip.type === 'subtitles') continue; // it follows the duration below
    const end = clip.start + clip.duration;
    const oi = o ? scenes.indexOf(o) : -1;
    if (o && oi > index) { shift(clip, delta); continue; }
    if (o && oi < index) continue;
    if (o) { if (end > newEnd + EPS) setEnd(track, clip, newEnd); continue; }
    // A clip that belongs to no single scene (audio, a background spanning scenes).
    if (clip.start >= oldEnd - EPS) shift(clip, delta);
    else if (clip.type === 'audio') {
      // Audio keeps its place and length, except when it ran to the end of the composition (it follows) or would pass the new end.
      if (end >= oldTotal - EPS) { if (delta < 0 || !(clip.locked || trackLocked(track))) setEnd(track, clip, end + delta); }
      else if (end > oldTotal + delta + EPS) setEnd(track, clip, oldTotal + delta);
    } else if (end > oldEnd + EPS || (last && end >= oldEnd - EPS)) {
      if (delta > 0 && (clip.locked || trackLocked(track))) continue;
      setEnd(track, clip, end + delta);
    } else if (end > newEnd + EPS) setEnd(track, clip, newEnd);
  }
  scene.duration = r(newDuration);
  for (let i = index + 1; i < scenes.length; i++) scenes[i]!.start = r(scenes[i]!.start + delta);
  w.duration = r(scenes.reduce((m, s) => Math.max(m, s.start + s.duration), 0));
  for (const { clip } of allClips(w)) if (clip.type === 'subtitles') clip.duration = w.duration;
}

// ---------- ops ----------

function run(w: Composition, op: EditOp, ctx: EditContext): void {
  switch (op.kind) {
    case 'clipProps': return clipProps(w, op);
    case 'clipTiming': return clipTiming(w, op);
    case 'clipMedia': return clipMedia(w, op, ctx);
    case 'clipFlags': {
      const { clip } = locate(w, op.clipId);
      setFlag(clip, 'hidden', op.hidden);
      setFlag(clip, 'locked', op.locked);
      return;
    }
    case 'trackFlags': {
      const track = w.tracks.find((t) => t.id === op.trackId) ?? refuse('editor.unknownTrack', { track: op.trackId });
      setFlag(track, 'hidden', op.hidden);
      setFlag(track, 'locked', op.locked);
      setFlag(track, 'muted', op.muted);
      return;
    }
    case 'sceneDuration': {
      if (w.duration === 0) refuse('editor.stillTiming', { clip: op.sceneId });
      if (!(typeof op.duration === 'number' && Number.isFinite(op.duration) && op.duration > 0 && op.duration <= COMPOSITION_LIMITS.durationSec)) {
        refuse('editor.badValue', { clip: op.sceneId, key: 'duration' });
      }
      return resizeScene(w, op.sceneId, r(op.duration));
    }
    case 'sceneOrder': return sceneOrder(w, op);
    case 'animationPreset': return animationPreset(w, op);
    case 'htmlParam': return htmlParam(w, op, ctx);
    case 'addFont': return addFont(w, op, ctx);
    case 'svgContent': {
      // The summary's counts only (the file changes through clipMedia): the clip must be an editable svg clip.
      const { clip } = locateUnlocked(w, op.clipId);
      if (clip.type !== 'svg') refuse('editor.wrongType', { clip: clip.id, type: clip.type });
      for (const key of ['colors', 'texts', 'hidden'] as const) {
        const v = op[key];
        if (!(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000)) refuse('editor.badValue', { clip: clip.id, key });
      }
      return;
    }
    default: return refuse('editor.badOp');
  }
}

function setFlag(target: { hidden?: boolean; locked?: boolean; muted?: boolean }, key: 'hidden' | 'locked' | 'muted', value: boolean | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') refuse('editor.badValue', { clip: '', key });
  if (value) target[key] = true; else delete target[key];
}

function clipProps(w: Composition, op: Extract<EditOp, { kind: 'clipProps' }>): void {
  const { clip } = locateUnlocked(w, op.clipId);
  if (!isObject(op.props)) refuse('editor.badValue', { clip: clip.id, key: 'props' });
  const allowed = KEYS_BY_TYPE[clip.type];
  const props = (clip as { props?: Record<string, unknown> }).props;
  for (const key of Object.keys(op.props)) {
    if (!allowed.includes(key) || !props) refuse('editor.badProp', { clip: clip.id, key });
  }
  for (const [key, value] of Object.entries(op.props)) {
    if (value === undefined) { delete props![key]; continue; }
    if (key === 'fontFamily') {
      const family = String(value).toLowerCase();
      if (!w.fonts.some((f) => f.family.toLowerCase() === family)) refuse('composition.unknownFont', { clip: clip.id, family: String(value) });
    }
    props![key] = value;
  }
  // A text weight the family does not declare is refused (the editor never produces one); families without declared weights are free.
  if (clip.type === 'text' && ('fontWeight' in op.props || 'fontFamily' in op.props)) {
    const family = clip.props.fontFamily ?? w.fonts[0]?.family;
    const declared = family ? declaredWeights(w.fonts, family) : null;
    const weight = weightNumber(clip.props.fontWeight);
    if (family && declared && !declared.includes(weight)) refuse('editor.badWeight', { clip: clip.id, family, weight, declared: declared.join(', ') });
  }
}

function clipTiming(w: Composition, op: Extract<EditOp, { kind: 'clipTiming' }>): void {
  const { clip } = locateUnlocked(w, op.clipId);
  if (w.duration === 0) refuse('editor.stillTiming', { clip: clip.id });
  const wantStart = finite(op.start, clip.id, 'start');
  const wantDuration = finite(op.duration, clip.id, 'duration');
  const minD = frameOf(w.fps);
  const scene = clip.scene !== undefined ? w.scenes.find((s) => s.id === clip.scene) : undefined;
  const lo = scene ? scene.start : 0;
  const hi = scene ? scene.start + scene.duration : w.duration;
  const start = r(clamp(wantStart, lo, hi - minD));
  let duration = Math.max(wantDuration, minD);
  if (scene && op.ripple === true && start + duration > hi + EPS) {
    duration = r(duration);
    resizeScene(w, scene.id, r(scene.duration + (start + duration - hi)), clip.id);
  } else {
    duration = r(clamp(duration, minD, hi - start));
  }
  fitAnimations(clip, duration, w.fps);
  clip.start = start;
  clip.duration = duration;
}

function assetPath(clip: string, key: string, value: unknown, ctx: EditContext): string {
  if (typeof value !== 'string' || !isCompositionPath(value) || !value.startsWith('assets/')) return refuse('editor.badAsset', { clip, path: String(value).slice(0, 100) });
  if (ctx.files && !ctx.files.has(value) && !ctx.files.has(value.normalize('NFC'))) return refuse('editor.badAsset', { clip, path: value });
  void key;
  return value;
}

function clipMedia(w: Composition, op: Extract<EditOp, { kind: 'clipMedia' }>, ctx: EditContext): void {
  const { clip } = locateUnlocked(w, op.clipId);
  if (!(clip.type === 'image' || clip.type === 'svg' || clip.type === 'video' || clip.type === 'audio')) refuse('editor.wrongType', { clip: clip.id, type: clip.type });
  const timed = clip.type === 'video' || clip.type === 'audio';
  if (op.src !== undefined) clip.src = assetPath(clip.id, 'src', op.src, ctx);
  const set = (key: 'trimStart' | 'volume' | 'fadeIn' | 'fadeOut', value: number | undefined, ok: boolean): void => {
    if (value === undefined) return;
    if (!ok) refuse('editor.badProp', { clip: clip.id, key });
    (clip as unknown as Record<string, number>)[key] = finite(value, clip.id, key);
  };
  set('trimStart', op.trimStart, timed);
  set('volume', op.volume, timed);
  set('fadeIn', op.fadeIn, clip.type === 'audio');
  set('fadeOut', op.fadeOut, clip.type === 'audio');
}

function sceneOrder(w: Composition, op: Extract<EditOp, { kind: 'sceneOrder' }>): void {
  if (w.duration === 0) refuse('editor.stillTiming', { clip: '' });
  const scenes = byTime(w);
  const order = op.order;
  if (!Array.isArray(order) || order.length !== scenes.length || new Set(order).size !== order.length || !order.every((x) => scenes.some((s) => s.id === x))) {
    refuse('editor.badOrder');
  }
  const allowed = sceneOrderAllowed(w);
  if (!allowed.ok) refuse('editor.sceneOrderBlocked', { clip: allowed.clipId });
  const owners = allClips(w).map(({ clip }) => ({ clip, owner: owner(clip, scenes) }));
  const oldStart = new Map(scenes.map((s) => [s.id, s.start]));
  const next = order.map((x) => scenes.find((s) => s.id === x)!);
  let at = 0;
  for (const s of next) { s.start = r(at); at += s.duration; }
  for (const { clip, owner: o } of owners) if (o) shift(clip, o.start - oldStart.get(o.id)!);
  w.scenes = next;
}

function animationPreset(w: Composition, op: Extract<EditOp, { kind: 'animationPreset' }>): void {
  const { clip } = locateUnlocked(w, op.clipId);
  if (clip.type === 'audio' || clip.type === 'subtitles') refuse('editor.wrongType', { clip: clip.id, type: clip.type });
  if (w.duration === 0) refuse('editor.stillTiming', { clip: clip.id });
  if (op.slot !== 'in' && op.slot !== 'out') refuse('editor.badValue', { clip: clip.id, key: 'slot' });
  const list = clip.animations ?? [];
  const inSlot = (a: Anim) => (op.slot === 'in' ? (a.start ?? 0) <= EPS : (a.start ?? 0) > EPS && Math.abs((a.start ?? 0) + a.duration - clip.duration) <= EPS);
  const occupying = list.filter(inSlot);
  const existing = occupying.find(isPreset);
  if (op.preset === null) {
    if (existing) clip.animations = list.filter((a) => a !== existing);
    if (clip.animations && clip.animations.length === 0) delete clip.animations;
    return;
  }
  if (!existing && occupying.length > 0) refuse('editor.customAnimation', { clip: clip.id, slot: op.slot });
  const duration = r(clamp(finite(op.duration, clip.id, 'duration'), frameOf(w.fps), clip.duration));
  if (existing) {
    existing.preset = op.preset;
    existing.duration = duration;
    if (op.slot === 'out') existing.start = r(clip.duration - duration);
    return;
  }
  const added = op.slot === 'in' ? { preset: op.preset, duration } : { preset: op.preset, start: r(clip.duration - duration), duration };
  clip.animations = [...list, added];
}

function htmlParam(w: Composition, op: Extract<EditOp, { kind: 'htmlParam' }>, ctx: EditContext): void {
  const { clip } = locateUnlocked(w, op.clipId);
  if (clip.type !== 'html') refuse('editor.wrongType', { clip: clip.id, type: clip.type });
  const param = clip.params && Object.hasOwn(clip.params, op.key) ? clip.params[op.key] : undefined;
  if (!param) return refuse('editor.unknownParam', { clip: clip.id, key: op.key });
  const bad = (): never => refuse('editor.badParam', { clip: clip.id, key: op.key });
  const v = op.value;
  switch (param.type) {
    case 'text': if (typeof v !== 'string' || v.length > COMPOSITION_LIMITS.text) bad(); param.value = v as string; break;
    case 'color': if (typeof v !== 'string' || !COLOR_RE.test(v)) bad(); param.value = v as string; break;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) bad(); param.value = v as number; break;
    case 'image': param.value = assetPath(clip.id, op.key, v, ctx); break;
  }
}

function addFont(w: Composition, op: Extract<EditOp, { kind: 'addFont' }>, ctx: EditContext): void {
  const font = op.font;
  if (!isObject(font) || typeof font.family !== 'string' || typeof font.src !== 'string') return refuse('editor.badFont', { family: '' });
  const src = assetPath('', 'src', font.src, ctx);
  if (!FONT_EXT.some((e) => src.toLowerCase().endsWith(e))) refuse('editor.badFont', { family: font.family });
  if (w.fonts.some((f) => f.family.toLowerCase() === font.family.toLowerCase())) refuse('editor.fontExists', { family: font.family });
  if (op.weights === undefined) { w.fonts.push({ ...font, src }); return; }
  const weights = op.weights;
  if (!Array.isArray(weights) || weights.length === 0 || weights.length > ADD_FONT_MAX_WEIGHTS || new Set(weights).size !== weights.length
    || !weights.every((x) => Number.isInteger(x) && x >= 1 && x <= 1000)) refuse('editor.badFont', { family: font.family });
  if (w.fonts.length + weights.length > COMPOSITION_LIMITS.fonts) refuse('editor.badFont', { family: font.family });
  for (const weight of [...weights].sort((a, b) => a - b)) w.fonts.push({ ...font, src, weight });
}
