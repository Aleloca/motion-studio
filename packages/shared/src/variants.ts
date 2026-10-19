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
/**
 * Decision 1169: one log copied before a chat merge, in merge order: the member, the copy's file, the variant its entries
 * were merged as, and `own` (every entry forced to that variant; false only for an already merged host log).
 */
export interface ChatMergeCopy { slug: string; file: string; letter: VariantId; own: boolean }
export interface VariantGroup {
  members: VariantMember[];
  /** Final selection per format id. */
  picks: Record<string, VariantPick>;
  layout: 'variant' | 'format';
  /**
   * Decision 982: `single` once the members' conversations were merged into the host's (lazy, one time; absent: not yet,
   * each member still writes its own file and readers merge them in memory).
   */
  chat?: 'single';
  /**
   * Decision 1163: a merge of the chats past its commit point and not yet finished: the merged log's hash and size (only a
   * file that matches is ever adopted), the copy of each log taken before it (by member slug) and the members whose own log
   * is still to retire. Cleared when the merge is finished.
   */
  chatMerge?: { sha256: string; size: number; copies: ChatMergeCopy[]; retire: string[] };
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
  chat: z.literal('single').optional(),
  chatMerge: z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0),
    copies: z.array(z.object({
      slug: memberSlugSchema, file: z.string().regex(/^conversation\.premerge(?:-[0-9a-z]+)?\.jsonl$/), letter: variantIdSchema, own: z.boolean(),
    })),
    retire: z.array(memberSlugSchema),
  }).optional(),
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

/**
 * The id after the group's highest member (decision 1151). The core also keeps a high-water mark on the host
 * (`variantNext`, decision 1162) so an id is never given twice, even after members left or the group dissolved.
 */
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

// ---------------------------------------------------------------------------------------------------------------------
// Phase 3 of the single agent (spec §7, decision 979): the variants a user's words name. The core's ask guard reads them; it
// is a safety net, not the decision (the coordinator decides): a miss only makes the agent ask, so the reading is
// conservative and never guesses.

const ID_TOKEN = '[A-Za-z]{1,3}';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}])';
/** What joins two ids of a list: a comma, "e"/"ed"/"and", "&", "/". */
const LIST_SEP = '\\s*(?:,|&|\\/|\\be\\b|\\bed\\b|\\band\\b)\\s*';
const RANGE_SEP = '\\s*[-\u2013\u2014]\\s*';
const ALL_WORDS = '(?:tutte|tutti|ogni|all|every)';
const VARIANT_WORDS = '(?:variant[ei]?|variants?)';

/** The existing ids from `a` to `b` (both ends included, in either order). */
function rangeOf(a: VariantId, b: VariantId, known: ReadonlySet<VariantId>): VariantId[] {
  const [from, to] = [variantIndex(a), variantIndex(b)].sort((x, y) => x - y) as [number, number];
  return [...known].filter((id) => variantIndex(id) >= from && variantIndex(id) <= to);
}

/**
 * The variants of the group (`ids`) that `text` names:
 * - after "variante/varianti/variant(s)": a list of ids in any case ("varianti B e C", "variant b, c and d"), ranges too;
 * - bare upper-case ids that are variants of the group ("in B", "B: …", "B-D", "AA"). A sentence that starts with A, E, I or O
 *   followed by a word is an Italian or English word ("A destra…", "E il logo?", "I colori…"), not an id, unless a list or a
 *   colon follows ("A e B…", "A: …");
 * - every variant: "tutte/tutti/ogni/all/every" followed, within four words, by "variante/varianti/variant(s)" ("tutte le
 *   varianti", "all variants"), or alone as the whole text ("Tutte"). "tutti i colori" names none.
 */
export function namedVariants(text: string, ids: readonly VariantId[]): Set<VariantId> {
  const known = new Set(ids);
  const out = new Set<VariantId>();
  const add = (raw: string) => { const id = raw.toLowerCase(); if (known.has(id)) out.add(id); return known.has(id); };
  const whole = text.trim().replace(/[\s.!?,;:]+$/u, '').replace(/^[\s"'«“(]+/u, '');
  if (new RegExp(`^${ALL_WORDS}$`, 'iu').test(whole)) return new Set(ids);
  if (new RegExp(`${NOT_LETTER_BEFORE}${ALL_WORDS}(?:\\s+[\\p{L}\\p{N}]+){0,4}?\\s+${VARIANT_WORDS}${NOT_LETTER_AFTER}`, 'iu').test(text)) return new Set(ids);
  // After the word "variante": a list of ids, in any case, ranges included; the list stops at the first word that is no id.
  const keyword = new RegExp(`${NOT_LETTER_BEFORE}${VARIANT_WORDS}\\s+(${ID_TOKEN})${NOT_LETTER_AFTER}`, 'giu');
  for (const m of text.matchAll(keyword)) {
    let rest = text.slice(m.index! + m[0].length);
    let last = m[1]!;
    if (!add(last)) continue;
    for (;;) {
      const range = new RegExp(`^${RANGE_SEP}(${ID_TOKEN})${NOT_LETTER_AFTER}`, 'u').exec(rest);
      if (range && known.has(range[1]!.toLowerCase())) { for (const id of rangeOf(last.toLowerCase(), range[1]!.toLowerCase(), known)) out.add(id); last = range[1]!; rest = rest.slice(range[0].length); continue; }
      const next = new RegExp(`^${LIST_SEP}(${ID_TOKEN})${NOT_LETTER_AFTER}`, 'iu').exec(rest);
      if (!next || !add(next[1]!)) break;
      last = next[1]!;
      rest = rest.slice(next[0].length);
    }
  }
  // Bare upper-case ids.
  const bare = new RegExp(`${NOT_LETTER_BEFORE}([A-Z]{1,3})${NOT_LETTER_AFTER}`, 'gu');
  for (const m of text.matchAll(bare)) {
    const token = m[1]!;
    const id = token.toLowerCase();
    if (!known.has(id)) continue;
    const before = text.slice(0, m.index!);
    const after = text.slice(m.index! + token.length);
    const initial = /(?:^|[.!?;\n])[\s"'«“(]*$/u.test(before);
    if (initial && /^[AEIO]$/.test(token)) {
      const listed = new RegExp(`^(?:\\s*[:,)\\]]|\\s*$|${LIST_SEP}[A-Z]{1,3}${NOT_LETTER_AFTER}|${RANGE_SEP}[A-Z]{1,3}${NOT_LETTER_AFTER})`, 'u').test(after);
      if (!listed) continue;
    }
    out.add(id);
    const range = new RegExp(`^${RANGE_SEP}([A-Z]{1,3})${NOT_LETTER_AFTER}`, 'u').exec(after);
    if (range && known.has(range[1]!.toLowerCase())) for (const r of rangeOf(id, range[1]!.toLowerCase(), known)) out.add(r);
  }
  return out;
}

/**
 * The variants an answer to the agent's question picks: the labels of its options ("B · Calma", several joined with ", ")
 * and "Tutte"/"All"; any other text (the "Other" answer) is read like a message (`namedVariants`).
 */
export function answeredVariants(answer: string, ids: readonly VariantId[]): Set<VariantId> {
  const known = new Set(ids);
  const out = new Set<VariantId>();
  for (const part of answer.split(/,\s+/)) {
    const label = /^\s*([A-Za-z]{1,3})\s*\u00b7/.exec(part);
    if (label && known.has(label[1]!.toLowerCase())) { out.add(label[1]!.toLowerCase()); continue; }
    for (const id of namedVariants(part, ids)) out.add(id);
  }
  return out;
}

const COUNT_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, a: 1, an: 1, one: 1, due: 2, two: 2, tre: 3, three: 3, quattro: 4, four: 4, cinque: 5, five: 5,
  sei: 6, six: 6, sette: 7, seven: 7, otto: 8, eight: 8, nove: 9, nine: 9, dieci: 10, ten: 10,
};
const COUNT = `(\\d{1,2}|${Object.keys(COUNT_WORDS).join('|')})`;
/** Words that make a variant a new one. */
const FRESH_WORDS = '(?:nuov[aei]|new|additional|extra|another|aggiuntiv[aei])';
/**
 * "altre"/"more" ask for new variants only on their own ("altre due varianti", "4 more variants"); after an article or a
 * preposition they name the existing ones ("alle altre varianti", "the more variants"): re-review 1.
 */
const OTHER_WORDS = `(?<!(?<![\\p{L}\\p{N}])(?:${['le', 'alle', 'nelle', 'delle', 'dalle', 'sulle', 'per le', 'tra le', 'fra le', 'gli', 'agli', 'negli', 'degli', 'i', 'the', 'other'].join('|')})\\s+)(?:altr[aei]|more)`; // i18n-ignore: words the user may type, not UI text
const NEW_WORDS = `(?:${FRESH_WORDS}|${OTHER_WORDS})`;
const VARIANT_WORD = '(?:variant[ei]|variants?)';
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
/** After "variante": a variant's id ("variante B") or what it is a variant of ("variante del titolo"): an existing one. */
const EXISTING_AFTER = /^\s+(?:[A-Z]{1,3}(?![\p{L}\p{N}])|(?:of|del|della|dello|dei|delle|degli|di)(?![\p{L}\p{N}]))/u;

/**
 * Review M3 of phase 3: whether the user's words ask for NEW variants, and how many (0: they do not). The core lets the
 * coordinator add variants only then, and at most that many. Read: "una nuova variante", "altre due varianti", "3 nuove
 * varianti", "altre 2 nuove varianti", "un'altra variante", "due varianti nuove", "aggiungi/crea/fammi una variante",
 * "ancora una variante"; "a new variant", "another variant", "4 more variants", "add/create/make a variant". A count missing
 * is one. Phrases about the existing variants ask for none (re-review 1): "la variante nuova", "tutte le varianti", "alle
 * altre varianti", "the other variants", a variant named by its id ("fammi una variante B più scura") or by what it is a
 * variant of ("una variante del titolo", "a variant of the logo").
 */
export function askedNewVariants(text: string): number {
  const original = text.replace(/[’`]/g, "'");
  const s = original.toLowerCase();
  const num = (w: string | undefined) => (w === undefined ? 1 : /^\d+$/.test(w) ? Number(w) : COUNT_WORDS[w] ?? 1);
  let n = 0;
  const take = (re: RegExp, groups: number[]) => {
    for (const m of s.matchAll(re)) {
      // The case of the original text tells an id ("B") from a word ("b"); lower-casing keeps the positions.
      if (s.length === original.length && EXISTING_AFTER.test(original.slice(m.index! + m[0].length))) continue;
      const w = groups.map((g) => m[g]).find((x) => x !== undefined);
      n = Math.max(n, num(w));
    }
  };
  // "una nuova variante", "altre due varianti", "altre 2 nuove varianti", "another variant", "4 more variants".
  take(new RegExp(`${B}(?:${COUNT}\\s+)?${NEW_WORDS}\\s+(?:${COUNT}\\s+)?(?:${FRESH_WORDS}\\s+)?${VARIANT_WORD}${E}`, 'gu'), [1, 2]);
  // "due varianti nuove" (a count is needed: "la variante nuova" is an existing one).
  take(new RegExp(`${B}${COUNT}\\s+${VARIANT_WORD}\\s+(?:nuov[aei]|new|in più|aggiuntiv[aei])${E}`, 'gu'), [1]); // i18n-ignore: words the user may type, not UI text
  // "aggiungi una variante", "fammi due varianti", "ancora una variante", "add a variant", "make three variants".
  take(new RegExp(`${B}(?:crea(?:ne|mi)?|aggiungi(?:ne)?|fa(?:i|mmi|nne)|genera(?:ne)?|ancora|add|create|make)\\s+${COUNT}\\s+(?:${NEW_WORDS}\\s+)?${VARIANT_WORD}${E}`, 'gu'), [1]); // i18n-ignore: words the user may type, not UI text
  return n;
}

/**
 * Re-review 3: an answer that is only a number ("3", "Tre", "Quante? Due", "two."): its count, else null. Read as the number
 * of new variants when the user already asked for some in the turn.
 */
export function bareCount(text: string): number | null {
  const m = new RegExp(`^\\s*(?:[^?]*\\?\\s*)?${COUNT}\\s*[.!]?\\s*$`, 'iu').exec(text.toLowerCase());
  if (!m) return null;
  const w = m[1]!;
  return /^\d+$/.test(w) ? Number(w) : COUNT_WORDS[w] ?? null;
}
