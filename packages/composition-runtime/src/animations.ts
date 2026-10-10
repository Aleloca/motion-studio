import type { Animation as CompositionAnimation } from '@motion-studio/shared';

/**
 * Compiles the JSON animations of a clip (spec §3.2) to WAAPI keyframes. Every animation becomes one or more
 * single-property WAAPI animations, created paused by the mount and driven by `seek(t)` through `currentTime`.
 *
 * Property mapping (on the clip's content element, inside the box element that carries the static box):
 * - `opacity` → `opacity` (multiplies the box opacity);
 * - `x`, `y` → `--ms-x`, `--ms-y`: offsets in composition pixels from the box position (`translate`);
 * - `scale` → `--ms-scale` (multiplies the box scale), `rotation` → `--ms-rotate` (degrees, added to the box rotation);
 * - `color` → `color` (text colour; a shape's fill is `currentColor`, so it animates the fill too);
 * - `blur` → `--ms-blur` (pixels, `filter: blur()`).
 * The custom properties are registered (`CSS.registerProperty`) so they interpolate, and x and y never fight over
 * one `translate` value.
 */

export interface CompiledAnimation {
  /** The animated CSS property (one per WAAPI animation), or `kenBurns` for the media element's own animation. */
  property: string;
  keyframes: Array<Record<string, string | number>>;
  /** Seconds, relative to the clip start. */
  start: number;
  /** Seconds. */
  duration: number;
  easing: string;
  fill: 'both' | 'forwards';
}

export interface AnimationContext {
  /** Composition size: the slide presets move by a tenth of it. */
  width: number;
  height: number;
  clipDuration: number;
}

/** Default easing of presets and tweens. Keyframes are linear between keyframes unless a keyframe says otherwise. */
export const DEFAULT_EASE = 'ease-out';

type Prop = 'opacity' | 'x' | 'y' | 'scale' | 'rotation' | 'color' | 'blur' | 'clip';
interface PresetStep { prop: Prop; from: number | string; to: number | string; easing?: string }
interface PresetDef { steps: (ctx: AnimationContext) => PresetStep[]; /** Ends with the clip unless a start is given. */ atEnd?: boolean }

/** The one table of presets. Slides move by `SLIDE_FRACTION` of the composition, from the side they come from. */
export const SLIDE_FRACTION = 0.1;
export const PRESET_TABLE: Record<string, PresetDef> = {
  fadeIn: { steps: () => [{ prop: 'opacity', from: 0, to: 1 }] },
  fadeOut: { steps: () => [{ prop: 'opacity', from: 1, to: 0 }], atEnd: true },
  slideUp: { steps: (c) => [{ prop: 'y', from: Math.round(c.height * SLIDE_FRACTION), to: 0 }] },
  slideDown: { steps: (c) => [{ prop: 'y', from: -Math.round(c.height * SLIDE_FRACTION), to: 0 }] },
  slideLeft: { steps: (c) => [{ prop: 'x', from: Math.round(c.width * SLIDE_FRACTION), to: 0 }] },
  slideRight: { steps: (c) => [{ prop: 'x', from: -Math.round(c.width * SLIDE_FRACTION), to: 0 }] },
  popIn: { steps: () => [{ prop: 'scale', from: 0.5, to: 1, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }, { prop: 'opacity', from: 0, to: 1 }] },
  scaleIn: { steps: () => [{ prop: 'scale', from: 0, to: 1 }] },
  wipe: { steps: () => [{ prop: 'clip', from: 'inset(0px 100% 0px 0px)', to: 'inset(0px 0% 0px 0px)' }] },
};

const CSS_PROPERTY: Record<Prop, string> = {
  opacity: 'opacity', x: '--ms-x', y: '--ms-y', scale: '--ms-scale', rotation: '--ms-rotate', color: 'color', blur: '--ms-blur', clip: 'clipPath',
};
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The CSS value of `v` for `prop`, or null when the value has the wrong kind (a number for `color`, a colour elsewhere). */
function cssValue(prop: Prop, v: unknown): string | null {
  if (prop === 'clip') return typeof v === 'string' ? v : null;
  if (prop === 'color') return typeof v === 'string' && HEX.test(v) ? v : null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  switch (prop) {
    case 'x': case 'y': case 'blur': return `${v}px`;
    case 'rotation': return `${v}deg`;
    default: return String(v);
  }
}

/**
 * Compiles a clip's animations. Each result animates one property; the list is ordered by start (stable), which is
 * also the creation order, so among animations of one property the latest started wins (WAAPI composite order).
 * Only the first animation of each property fills backwards: before it starts the element shows its first keyframe
 * (a delayed fadeIn keeps the clip hidden), while a later one (a fadeOut) never overrides an earlier one before it starts.
 * Bad entries (unknown preset, a value of the wrong kind) are skipped and reported through `report`.
 */
export function compileAnimations(animations: readonly CompositionAnimation[] | undefined, ctx: AnimationContext, report?: (message: string) => void): CompiledAnimation[] {
  const out: CompiledAnimation[] = [];
  for (const [index, a] of (animations ?? []).entries()) {
    const compiled = compileOne(a, ctx);
    if (compiled) out.push(...compiled);
    else report?.(`animation ${index} skipped: unknown preset or a value of the wrong kind`);
  }
  out.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  for (const a of out) {
    a.fill = seen.has(a.property) ? 'forwards' : 'both';
    seen.add(a.property);
  }
  return out;
}

function compileOne(a: CompositionAnimation, ctx: AnimationContext): CompiledAnimation[] | null {
  if (!(a.duration > 0)) return null;
  if ('preset' in a) {
    const def = PRESET_TABLE[a.preset];
    if (!def) return null;
    const start = a.start ?? (def.atEnd ? ctx.clipDuration - a.duration : 0);
    const result: CompiledAnimation[] = [];
    for (const step of def.steps(ctx)) {
      const from = cssValue(step.prop, step.from); const to = cssValue(step.prop, step.to);
      if (from === null || to === null) return null;
      const property = CSS_PROPERTY[step.prop];
      result.push({ property, keyframes: [{ [property]: from }, { [property]: to }], start, duration: a.duration, easing: a.ease ?? step.easing ?? DEFAULT_EASE, fill: 'both' });
    }
    return result;
  }
  const prop = a.prop as Prop;
  const property = CSS_PROPERTY[prop];
  if (!property) return null;
  if ('keyframes' in a) {
    const keyframes: Array<Record<string, string | number>> = [];
    for (const k of a.keyframes) {
      const v = cssValue(prop, k.v);
      if (v === null) return null;
      keyframes.push({ [property]: v, offset: k.t, easing: k.ease ?? 'linear' });
    }
    return [{ property, keyframes, start: a.start ?? 0, duration: a.duration, easing: 'linear', fill: 'both' }];
  }
  const from = cssValue(prop, a.from); const to = cssValue(prop, a.to);
  if (from === null || to === null) return null;
  return [{ property, keyframes: [{ [property]: from }, { [property]: to }], start: a.start ?? 0, duration: a.duration, easing: a.ease ?? DEFAULT_EASE, fill: 'both' }];
}

export interface KenBurnsEnd { scale?: number; x?: number; y?: number }

/** Ken Burns: a linear move of the picture inside its box over the whole clip (`scale` and `translate` of the media element). */
export function compileKenBurns(kb: { from: KenBurnsEnd; to: KenBurnsEnd }, clipDuration: number): CompiledAnimation {
  const frame = (e: KenBurnsEnd) => ({ scale: String(e.scale ?? 1), translate: `${e.x ?? 0}px ${e.y ?? 0}px` });
  return { property: 'kenBurns', keyframes: [frame(kb.from), frame(kb.to)], start: 0, duration: clipDuration, easing: 'linear', fill: 'both' };
}

/** The registered custom properties the content element uses (see the module comment). */
export const REGISTERED_PROPERTIES: ReadonlyArray<{ name: string; syntax: string; initialValue: string }> = [
  { name: '--ms-x', syntax: '<length>', initialValue: '0px' },
  { name: '--ms-y', syntax: '<length>', initialValue: '0px' },
  { name: '--ms-scale', syntax: '<number>', initialValue: '1' },
  { name: '--ms-rotate', syntax: '<angle>', initialValue: '0deg' },
  { name: '--ms-blur', syntax: '<length>', initialValue: '0px' },
];
