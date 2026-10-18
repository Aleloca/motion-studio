import { z } from 'zod';

/** How many variants of one group work at once (a parallelism limit: there is no cap on the number of variants, decision 978). */
export const MAX_RUNNING_VARIANTS = 2;

/**
 * How many variants one request may add at once (a size bound on one call, not a cap on the group: decision 1152). It
 * is also the most directions one directions turn writes.
 */
export const MAX_NEW_VARIANTS = 26;

/**
 * A variant's id (decisions 978, 1143): `a`…`z`, then `aa`, `ab`…`zz`, `aaa`… — a bijective base-26 sequence, lower-case in
 * folders and slugs (`promo~ab`), upper-case on screen. `a` is the host. Ids are never reused (`nextLetter`).
 */
export type VariantId = string;
/** At most three letters: 18 278 ids, far more than a group can use, and slugs stay short (decision 1150). */
export const VARIANT_ID_RE = /^[a-z]{1,3}$/;
export const isVariantId = (v: unknown): v is VariantId => typeof v === 'string' && VARIANT_ID_RE.test(v);
/** The id at a 0-based position: 0 → a, 25 → z, 26 → aa, 27 → ab. */
export const variantIdAt = (i: number): VariantId => {
  let n = Math.floor(i) + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};
/** The 0-based position of an id (the inverse of `variantIdAt`); -1 for anything that is not an id. */
export const variantIndex = (id: string): number => {
  if (!VARIANT_ID_RE.test(id)) return -1;
  let n = 0;
  for (const ch of id) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n - 1;
};
/** Sorts ids in creation order (`b` before `aa`), not alphabetically. */
export const compareVariantIds = (x: string, y: string): number => variantIndex(x) - variantIndex(y);

/** Slug of a user-created creative (same rule as the core's creative store): never contains `~`. */
export const creativeSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
/** Slug of a sister creative: `<host slug>~<variant id other than a>`. */
export const sisterSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}~(?!a$)[a-z]{1,3}$/);
const memberSlugSchema = z.union([creativeSlugSchema, sisterSlugSchema]);

export const variantIdSchema = z.string().regex(VARIANT_ID_RE);

export interface VariantMember {
  slug: string;
  letter: VariantId;
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
  letter: variantIdSchema,
  direction: z.string().nullable(),
  directionSource: z.enum(['agent', 'user']).nullable(),
  status: z.enum(['active', 'discarded']),
  createdAt: z.iso.datetime(),
});
const pickSchema = z.object({ slug: memberSlugSchema, version: z.number().int().min(1) });

export const variantGroupSchema: z.ZodType<VariantGroup> = z.object({
  members: z.array(memberSchema).min(1),
  picks: z.record(z.string().min(1), pickSchema),
  layout: z.enum(['variant', 'format']),
}).superRefine((g, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (g.members[0]?.letter !== 'a') issue('variant.hostNotFirst');
  if (new Set(g.members.map((m) => m.letter)).size !== g.members.length) issue('variant.duplicateLetter');
  if (new Set(g.members.map((m) => m.slug)).size !== g.members.length) issue('variant.duplicateSlug');
  if (!g.members.some((m) => m.status === 'active')) issue('variant.noActiveMember');
  const slugs = new Set(g.members.map((m) => m.slug));
  for (const [format, p] of Object.entries(g.picks)) if (!slugs.has(p.slug)) ctx.addIssue({ code: 'custom', message: 'variant.unknownPick', path: ['picks', format] });
});

export const sisterSlug = (hostSlug: string, letter: VariantId): string => (letter === 'a' ? hostSlug : `${hostSlug}~${letter}`);
export const isSisterSlug = (slug: string): boolean => slug.includes('~');
export const hostOf = (slug: string): string => {
  const i = slug.indexOf('~');
  return i < 0 ? slug : slug.slice(0, i);
};
/** A member's id from its slug: everything after a sister's `~`, else `a` (the host). */
export const letterOfSlug = (slug: string): VariantId => {
  const i = slug.indexOf('~');
  return i < 0 ? 'a' : slug.slice(i + 1);
};

/** The id after the group's highest one: ids are never reused, even after a member is removed (decision 1151). */
export const nextLetter = (g: VariantGroup): VariantId =>
  variantIdAt(Math.max(-1, ...g.members.map((m) => variantIndex(m.letter))) + 1);

export const activeMembers = (g: VariantGroup): VariantMember[] => g.members.filter((m) => m.status === 'active');

/**
 * Whether a member can be discarded. Checked in order: unknown letter, running, last active.
 * A member that is already discarded is not "the last active" one: discarding it again is allowed (idempotent no-op),
 * unless it is running.
 */
export const canDiscard = (g: VariantGroup, letter: VariantId, running: boolean): { ok: true } | { ok: false; reason: 'last-active' | 'running' | 'unknown' } => {
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
