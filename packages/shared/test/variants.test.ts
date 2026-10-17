import { describe, expect, it } from 'vitest';
import {
  MAX_VARIANTS, VARIANT_LETTERS, activeMembers, canDiscard, creativeFileSchema, creativeSlugSchema, directionLine, hostOf, isSisterSlug,
  messages, nextLetter, sisterSlug, sisterSlugSchema, variantGroupSchema, type VariantGroup, type VariantLetter, type VariantMember,
} from '../src/index.ts';

const now = '2026-10-16T10:00:00.000Z';
const member = (letter: VariantLetter, over: Partial<VariantMember> = {}): VariantMember => ({
  slug: sisterSlug('promo', letter), letter, direction: null, directionSource: null, status: 'active', createdAt: now, ...over,
});
const group = (letters: VariantLetter[], over: Partial<VariantGroup> = {}): VariantGroup => ({
  members: letters.map((l) => member(l)), picks: {}, layout: 'variant', ...over,
});

describe('variantGroupSchema', () => {
  it('accepts 1 to 5 members with a as host', () => {
    expect(variantGroupSchema.safeParse(group(['a'])).success).toBe(true);
    expect(variantGroupSchema.safeParse(group(['a', 'b', 'c', 'd', 'e'])).success).toBe(true);
  });
  it('refuses 6 members by the cap itself (a too_big issue on members), not only by a duplicate', () => {
    const g = group(['a', 'b', 'c', 'd', 'e']);
    g.members.push(member('e', { slug: 'promo~e' }));
    const r = variantGroupSchema.safeParse(g);
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.code === 'too_big' && i.path.join('.') === 'members')).toBe(true);
  });
  it('refuses duplicate letters and duplicate slugs', () => {
    const g = group(['a', 'b']);
    g.members[1] = member('a', { slug: 'promo~b' });
    expect(variantGroupSchema.safeParse(g).success).toBe(false);
    const h = group(['a', 'b']);
    h.members[1] = member('b', { slug: 'promo' });
    expect(variantGroupSchema.safeParse(h).success).toBe(false);
  });
  it('refuses a first member that is not a', () => {
    expect(variantGroupSchema.safeParse(group(['b', 'a'])).success).toBe(false);
  });
  it('refuses a group with no active member', () => {
    const g = group(['a', 'b']);
    g.members.forEach((m) => { m.status = 'discarded'; });
    expect(variantGroupSchema.safeParse(g).success).toBe(false);
  });
  it('allows the host a to be discarded while another member is active', () => {
    const g = group(['a', 'b']);
    g.members[0]!.status = 'discarded';
    expect(variantGroupSchema.safeParse(g).success).toBe(true);
  });
  it('refuses a pick to an unknown slug and accepts one to a member', () => {
    const g = group(['a', 'b']);
    expect(variantGroupSchema.safeParse({ ...g, picks: { 'instagram-post-1x1': { slug: 'promo~b', version: 2 } } }).success).toBe(true);
    const bad = variantGroupSchema.safeParse({ ...g, picks: { 'instagram-post-1x1': { slug: 'other~b', version: 2 } } });
    expect(bad.success).toBe(false);
    // The issue names the pick (minor, Task 1).
    expect(bad.error!.issues.find((i) => i.message === 'variant.unknownPick')?.path).toEqual(['picks', 'instagram-post-1x1']);
  });
  it('refuses ~ in a user slug and ~f in a sister slug', () => {
    expect(creativeSlugSchema.safeParse('promo~b').success).toBe(false);
    expect(creativeSlugSchema.safeParse('promo').success).toBe(true);
    expect(sisterSlugSchema.safeParse('promo~b').success).toBe(true);
    expect(sisterSlugSchema.safeParse('promo~a').success).toBe(false);
    expect(sisterSlugSchema.safeParse('promo~f').success).toBe(false);
    expect(sisterSlugSchema.safeParse('promo').success).toBe(false);
    const g = group(['a', 'b']);
    g.members[1] = member('b', { slug: 'promo~f' });
    expect(variantGroupSchema.safeParse(g).success).toBe(false);
  });
});

describe('slug helpers', () => {
  it('builds and splits sister slugs', () => {
    expect(sisterSlug('promo', 'a')).toBe('promo');
    expect(sisterSlug('promo', 'c')).toBe('promo~c');
    expect(isSisterSlug('promo~c')).toBe(true);
    expect(isSisterSlug('promo')).toBe(false);
    expect(hostOf('promo~c')).toBe('promo');
    expect(hostOf('promo')).toBe('promo');
  });
});

describe('nextLetter, activeMembers, canDiscard, directionLine', () => {
  it('nextLetter skips used letters and returns null at 5', () => {
    expect(nextLetter(group(['a']))).toBe('b');
    expect(nextLetter(group(['a', 'c']))).toBe('b');
    expect(nextLetter(group(['a', 'b', 'c', 'd', 'e']))).toBeNull();
    expect(VARIANT_LETTERS).toHaveLength(MAX_VARIANTS);
  });
  it('activeMembers drops discarded ones', () => {
    const g = group(['a', 'b', 'c']);
    g.members[1]!.status = 'discarded';
    expect(activeMembers(g).map((m) => m.letter)).toEqual(['a', 'c']);
  });
  it('canDiscard reports unknown, running, last-active, ok in that order', () => {
    const g = group(['a', 'b']);
    expect(canDiscard(g, 'c', false)).toEqual({ ok: false, reason: 'unknown' });
    expect(canDiscard(g, 'c', true)).toEqual({ ok: false, reason: 'unknown' });
    expect(canDiscard(g, 'b', true)).toEqual({ ok: false, reason: 'running' });
    expect(canDiscard(g, 'b', false)).toEqual({ ok: true });
    expect(canDiscard(g, 'a', false)).toEqual({ ok: true });
    g.members[1]!.status = 'discarded';
    expect(canDiscard(g, 'a', false)).toEqual({ ok: false, reason: 'last-active' });
    expect(canDiscard(g, 'a', true)).toEqual({ ok: false, reason: 'running' });
    expect(canDiscard(group(['a']), 'a', false)).toEqual({ ok: false, reason: 'last-active' });
  });
  it('canDiscard on an already discarded member is ok (idempotent), unless running', () => {
    const g = group(['a', 'b']);
    g.members[1]!.status = 'discarded';
    expect(canDiscard(g, 'b', false)).toEqual({ ok: true });
    expect(canDiscard(g, 'b', true)).toEqual({ ok: false, reason: 'running' });
  });
  it('directionLine', () => {
    expect(directionLine(member('b', { direction: 'Più ritmo' }))).toBe('B · Più ritmo');
    expect(directionLine(member('b'))).toBe('B');
    expect(directionLine(member('c', { direction: '' }))).toBe('C');
  });
});

describe('creativeFileSchema variant fields', () => {
  const old = {
    schemaVersion: 1, title: 'Lancio app', status: 'draft', error: null, createdAt: now, updatedAt: now, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Goal', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' },
  };
  it('parses an old file unchanged', () => { expect(creativeFileSchema.parse(old)).toEqual(old); });
  it('parses variantGroup and variantOf', () => {
    expect(creativeFileSchema.parse({ ...old, variantGroup: group(['a', 'b']) }).variantGroup?.members).toHaveLength(2);
    expect(creativeFileSchema.parse({ ...old, variantOf: 'promo' }).variantOf).toBe('promo');
    expect(creativeFileSchema.safeParse({ ...old, variantOf: 'promo~b' }).success).toBe(false);
  });
});

describe('variant group i18n', () => {
  for (const loc of ['it', 'en'] as const) {
    it(`has the labels and reasons in ${loc}`, () => {
      const v = messages(loc).web.variantGroup;
      for (const k of ['groupBy', 'variant', 'format', 'all', 'addVariant', 'addVariantMenu', 'discard', 'restore', 'showDiscarded', 'useForAllFormats', 'finalSelection', 'missing'] as const) {
        expect(v[k]).toBeTruthy();
      }
      expect(v.discardRefused.running).toBeTruthy();
      expect(v.discardRefused.lastActive).toBeTruthy();
      expect(v.letterLabel({ letter: 'B' })).toContain('B');
      expect(v.count({ count: 1 })).not.toBe(v.count({ count: 3 }));
    });
  }
  it('uses the user wording in Italian', () => {
    const v = messages('it').web.variantGroup;
    expect([v.groupBy, v.addVariant, v.discard, v.restore, v.showDiscarded, v.useForAllFormats, v.finalSelection, v.missing]).toEqual([
      'Raggruppa per', '+ Variante', 'Scarta', 'Ripristina', 'Mostra scartate', 'Usa questa variante per tutti i formati', 'Selezione finale', 'mancante',
    ]);
  });
});
