import { z } from 'zod';
import type { CompositionProblem } from '../problems.ts';
import { COMPOSITION_PATH_MAX } from '../paths.ts';
import { ANIMATION_PRESETS, COMPOSITION_LIMITS, fontRefSchema, type Composition, type FontRef } from '../schema.ts';

export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

/** The properties of a clip the editor may change (spec §6); every other key refuses. Which of them a clip takes depends on its type. */
export interface EditableProps {
  x?: number; y?: number; width?: number; height?: number; rotation?: number; scale?: number; opacity?: number;
  text?: string; fontFamily?: string; fontSize?: number; fontWeight?: number | 'normal' | 'bold'; color?: string; align?: 'left' | 'center' | 'right';
  fill?: string; radius?: number;
}

export type EditOp =
  | { kind: 'clipProps'; clipId: string; props: EditableProps }
  | { kind: 'clipTiming'; clipId: string; start: number; duration: number; ripple: boolean }
  | { kind: 'clipMedia'; clipId: string; src?: string; trimStart?: number; volume?: number; fadeIn?: number; fadeOut?: number }
  | { kind: 'clipFlags'; clipId: string; hidden?: boolean; locked?: boolean }
  | { kind: 'trackFlags'; trackId: string; hidden?: boolean; locked?: boolean; muted?: boolean }
  | { kind: 'sceneDuration'; sceneId: string; duration: number }
  | { kind: 'sceneOrder'; order: string[] }
  | { kind: 'animationPreset'; clipId: string; slot: 'in' | 'out'; preset: AnimationPreset | null; duration: number }
  | { kind: 'htmlParam'; clipId: string; key: string; value: string | number }
  /**
   * Declares a font file. `weights` (a variable font: several weights from one file) declares one entry per weight, each
   * with the same family and file, and `font.weight` is then ignored.
   */
  | { kind: 'addFont'; font: FontRef; weights?: number[] };

export type EditResult = { ok: true; composition: Composition } | { ok: false; problem: CompositionProblem };

/** What the caller knows beyond the composition: the files of the composition folder (plus staged ones), by relative path. */
export interface EditContext { files?: ReadonlySet<string> }

/** Most weights one `addFont` declares (100–900 in steps of 100). */
export const ADD_FONT_MAX_WEIGHTS = 9;
const id = z.string().min(1).max(COMPOSITION_LIMITS.id);
const time = z.number().min(0).max(COMPOSITION_LIMITS.durationSec);
const text = z.string().max(COMPOSITION_LIMITS.text);
const editablePropsSchema = z.strictObject({
  x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
  rotation: z.number().optional(), scale: z.number().optional(), opacity: z.number().optional(),
  text: text.optional(), fontFamily: z.string().max(COMPOSITION_LIMITS.family).optional(), fontSize: z.number().optional(),
  fontWeight: z.union([z.number().int(), z.enum(['normal', 'bold'])]).optional(),
  color: z.string().max(9).optional(), align: z.enum(['left', 'center', 'right']).optional(),
  fill: z.string().max(9).optional(), radius: z.number().optional(),
});

/**
 * The wire form of `EditOp` (the request body of a direct save): bounded strings and finite numbers. It only bounds the
 * shape; `applyEdit` still checks every value against the composition schema and the rules of the clip.
 */
export const editOpSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clipProps'), clipId: id, props: editablePropsSchema }),
  z.strictObject({ kind: z.literal('clipTiming'), clipId: id, start: time, duration: time, ripple: z.boolean() }),
  z.strictObject({
    kind: z.literal('clipMedia'), clipId: id, src: z.string().max(COMPOSITION_PATH_MAX).optional(),
    trimStart: z.number().min(0).max(36_000).optional(), volume: z.number().min(0).max(2).optional(), fadeIn: time.optional(), fadeOut: time.optional(),
  }),
  z.strictObject({ kind: z.literal('clipFlags'), clipId: id, hidden: z.boolean().optional(), locked: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('trackFlags'), trackId: id, hidden: z.boolean().optional(), locked: z.boolean().optional(), muted: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('sceneDuration'), sceneId: id, duration: time }),
  z.strictObject({ kind: z.literal('sceneOrder'), order: z.array(id).max(COMPOSITION_LIMITS.scenes) }),
  z.strictObject({
    kind: z.literal('animationPreset'), clipId: id, slot: z.enum(['in', 'out']), preset: z.enum(ANIMATION_PRESETS).nullable(), duration: time,
  }),
  z.strictObject({ kind: z.literal('htmlParam'), clipId: id, key: z.string().min(1).max(64), value: z.union([text, z.number()]) }),
  z.strictObject({ kind: z.literal('addFont'), font: fontRefSchema, weights: z.array(z.number().int().min(1).max(1000)).min(1).max(ADD_FONT_MAX_WEIGHTS).optional() }),
]);
