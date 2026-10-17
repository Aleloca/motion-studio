// Fixtures of the variant UI tests (Phase 15): a group "lancio" of up to five variants with their details, as the core answers them.
import { sisterSlug, type CreativeDetail, type OutputFileInfo, type VariantGroup, type VariantLetter, type VariantMember, type VersionEntry } from '@motion-studio/shared';

export const at = '2026-10-08T10:00:00.000Z';
export const HOST = 'lancio';
export const out = (format: string, file: string, preview: string | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1080, durationSec: null, verified: true, preview });
export const version = (n: number, request = '', outputs: OutputFileInfo[] = [out('instagram-post-1x1', 'post.png'), out('tiktok-9x16', 'tiktok.mp4', '.previews/tiktok.mp4.jpg')]): VersionEntry =>
  ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request, outputs, problems: [], tools: [], renderCommand: null, basedOn: null });

export const member = (letter: VariantLetter, over: Partial<VariantMember> = {}): VariantMember => ({
  slug: sisterSlug(HOST, letter), letter, direction: null, directionSource: null, status: 'active', createdAt: at, ...over,
});
export const DIRECTIONS: Record<VariantLetter, string> = { a: 'Minimale', b: 'Audace', c: 'Giocosa', d: 'Notturna', e: 'Retro' };
export const groupOf = (letters: VariantLetter[], over: Partial<VariantGroup> = {}, memberOver: Partial<Record<VariantLetter, Partial<VariantMember>>> = {}): VariantGroup => ({
  members: letters.map((l) => member(l, { direction: DIRECTIONS[l], directionSource: 'user', ...memberOver[l] })),
  picks: {}, layout: 'variant', ...over,
});

const FORMATS = ['instagram-post-1x1', 'tiktok-9x16'];
/** The detail the core answers for the creative `slug` of the group (the group is in every member's detail). */
export function detailFor(slug: string, versions: VersionEntry[], group: VariantGroup | null, o: { missing?: VariantLetter[]; formats?: string[]; title?: string; status?: CreativeDetail['creative']['status'] } = {}): CreativeDetail {
  const letter = slug.includes('~') ? (slug.slice(-1) as VariantLetter) : 'a';
  return {
    slug, jobKey: `creative:/w:acme:${slug}`, versions,
    creative: {
      schemaVersion: 1, title: o.title ?? 'Lancio estivo', status: o.status ?? (versions.length ? 'ready' : 'draft'), error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
      brief: { goal: 'Mostrare la nuova app', message: 'Prenota in un tocco', formats: o.formats ?? FORMATS, durationSec: 6, assets: [], notes: '' },
      ...(group && slug === HOST ? { variantGroup: group } : {}),
      ...(group && slug !== HOST ? { variantOf: HOST } : {}),
    },
    ...(group ? { variants: { orphan: false as const, host: HOST, letter, group, missing: o.missing ?? [] } } : {}),
  };
}
