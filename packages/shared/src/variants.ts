import { z } from 'zod';

export const MAX_VARIANTS = 5;
export const MAX_RUNNING_VARIANTS = 2;

export type VariantLetter = 'a' | 'b' | 'c' | 'd' | 'e';
export const VARIANT_LETTERS: readonly VariantLetter[] = ['a', 'b', 'c', 'd', 'e'];

/** Slug of a user-created creative (same rule as the core's creative store): never contains `~`. */
export const creativeSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
/** Slug of a sister creative: `<host slug>~<letter b..e>`. */
export const sisterSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}~[b-e]$/);
const memberSlugSchema = z.union([creativeSlugSchema, sisterSlugSchema]);

const letterSchema = z.enum(['a', 'b', 'c', 'd', 'e']);

export interface VariantMember {
  slug: string;
  letter: VariantLetter;
  direction: string | null;
  directionSource: 'agent' | 'user' | null;
  status: 'active' | 'discarded';
  createdAt: string;
}
export interface VariantPick { slug: string; version: number }
export interface VariantGroup {
  members: VariantMember[];
  /** Final selection per format id. */
  picks: Record<string, VariantPick>;
  layout: 'variant' | 'format';
}

const memberSchema = z.object({
  slug: memberSlugSchema,
  letter: letterSchema,
  direction: z.string().nullable(),
  directionSource: z.enum(['agent', 'user']).nullable(),
  status: z.enum(['active', 'discarded']),
  createdAt: z.iso.datetime(),
});
const pickSchema = z.object({ slug: memberSlugSchema, version: z.number().int().min(1) });

export const variantGroupSchema: z.ZodType<VariantGroup> = z.object({
  members: z.array(memberSchema).min(1).max(MAX_VARIANTS),
  picks: z.record(z.string().min(1), pickSchema),
  layout: z.enum(['variant', 'format']),
}).superRefine((g, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (g.members[0]?.letter !== 'a') issue('variant.hostNotFirst');
  if (new Set(g.members.map((m) => m.letter)).size !== g.members.length) issue('variant.duplicateLetter');
  if (new Set(g.members.map((m) => m.slug)).size !== g.members.length) issue('variant.duplicateSlug');
  if (!g.members.some((m) => m.status === 'active')) issue('variant.noActiveMember');
  const slugs = new Set(g.members.map((m) => m.slug));
  for (const p of Object.values(g.picks)) if (!slugs.has(p.slug)) issue('variant.unknownPick');
});

export const sisterSlug = (hostSlug: string, letter: VariantLetter): string => (letter === 'a' ? hostSlug : `${hostSlug}~${letter}`);
export const isSisterSlug = (slug: string): boolean => slug.includes('~');
export const hostOf = (slug: string): string => {
  const i = slug.indexOf('~');
  return i < 0 ? slug : slug.slice(0, i);
};
/** A member's letter from its slug: a sister's `~x`, else `a` (the host). */
export const letterOfSlug = (slug: string): VariantLetter => (slug.includes('~') ? (slug.slice(-1) as VariantLetter) : 'a');

/** The first unused letter, or null when the group is full. */
export const nextLetter = (g: VariantGroup): VariantLetter | null => {
  const used = new Set(g.members.map((m) => m.letter));
  return VARIANT_LETTERS.find((l) => !used.has(l)) ?? null;
};

export const activeMembers = (g: VariantGroup): VariantMember[] => g.members.filter((m) => m.status === 'active');

/**
 * Whether a member can be discarded. Checked in order: unknown letter, running, last active.
 * A member that is already discarded is not "the last active" one: discarding it again is allowed (idempotent no-op),
 * unless it is running.
 */
export const canDiscard = (g: VariantGroup, letter: VariantLetter, running: boolean): { ok: true } | { ok: false; reason: 'last-active' | 'running' | 'unknown' } => {
  const m = g.members.find((x) => x.letter === letter);
  if (!m) return { ok: false, reason: 'unknown' };
  if (running) return { ok: false, reason: 'running' };
  if (m.status === 'active' && activeMembers(g).length === 1) return { ok: false, reason: 'last-active' };
  return { ok: true };
};

/** "B · direction", or just "B" without one (the title of a variant's row). */
export const directionLine = (m: Pick<VariantMember, 'letter' | 'direction'>): string => {
  const L = m.letter.toUpperCase();
  return m.direction ? `${L} · ${m.direction}` : L;
};
