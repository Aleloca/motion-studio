import type { Composition } from './schema.ts';

/** A font weight as a number (`normal` is 400, `bold` 700; unset is 400). */
export const weightNumber = (w: number | 'normal' | 'bold' | undefined): number => (w === 'bold' ? 700 : typeof w === 'number' ? w : 400);

/**
 * The weights a family declares: those of its `fonts[]` entries that name a `weight`. null when none does (a family declared
 * without weights makes no promise about them: agent-written compositions often use one file for regular and bold).
 */
export function declaredWeights(fonts: Composition['fonts'], family: string): number[] | null {
  const lower = family.toLowerCase();
  const list = fonts.filter((f) => f.family.toLowerCase() === lower && f.weight !== undefined).map((f) => weightNumber(f.weight));
  return list.length > 0 ? [...new Set(list)].sort((a, b) => a - b) : null;
}
