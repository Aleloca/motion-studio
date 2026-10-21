import type { CreativeReferenceEntry } from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { LibraryStore } from './library-store.ts';

/**
 * Report 62: files added from the computer in a brief as a reference for that creative only. They live in `assets/` like any
 * library file (same names, analysis, prompt and composition copy), marked in assets.json with `referenceFor` (the creatives
 * they were added for; empty while their brief is not a creative yet). The library's lists leave them out; the Assets screen
 * shows them under "Riferimenti delle creatività". A creative's deletion takes the ones no other creative uses; an abandoned
 * brief's are swept at startup after `REFERENCE_MAX_AGE_MS`.
 */

/** How long a reference no creative and no open brief uses is kept (decision 1571). */
export const REFERENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const pathOf = (file: string) => `assets/${file}`;

/** The creative references with the creatives using them (their brief lists them, or they were added for them). */
export async function listCreativeReferences(projectDir: string, media: MediaTools): Promise<CreativeReferenceEntry[]> {
  const refs = (await new LibraryStore(projectDir, media).listAssets()).filter((a) => a.referenceFor !== undefined);
  if (refs.length === 0) return [];
  const { slugs, uses, titles } = await new CreativeStore(projectDir).briefAssetUses();
  return refs.map((a) => {
    const by = [...new Set([...a.referenceFor!.filter((s) => slugs.has(s)), ...(uses.get(pathOf(a.file)) ?? [])])];
    return { ...a, usedBy: by.map((slug) => ({ slug, title: titles.get(slug) ?? slug })) };
  });
}

/** The new creative `slug` takes the references among `paths` (its brief's assets and its brief session's files). */
export async function claimCreativeReferences(projectDir: string, media: MediaTools, slug: string, paths: readonly string[]): Promise<void> {
  const wanted = new Set(paths);
  await new LibraryStore(projectDir, media).settleReferences((a) => (
    wanted.has(pathOf(a.file)) && !a.referenceFor!.includes(slug) ? [...a.referenceFor!, slug] : a.referenceFor!
  ));
}

/**
 * The creatives `deleted` are gone (their folders already moved): each reference they had (added for them, or listed in
 * `deletedPaths`, their briefs' assets) goes too, unless another creative still has it or uses it. Nothing is deleted while
 * some creative cannot be read (its brief is unknown). Returns the files deleted.
 */
export async function releaseCreativeReferences(projectDir: string, media: MediaTools, deleted: readonly string[], deletedPaths: ReadonlySet<string>): Promise<string[]> {
  const { slugs, uses, unreadable } = await new CreativeStore(projectDir).briefAssetUses();
  return new LibraryStore(projectDir, media).settleReferences((a) => {
    const had = a.referenceFor!;
    if (!had.some((s) => deleted.includes(s)) && !deletedPaths.has(pathOf(a.file))) return had;
    const owners = [...new Set([...had.filter((s) => !deleted.includes(s) && slugs.has(s)), ...(uses.get(pathOf(a.file)) ?? [])])];
    return owners.length === 0 && !unreadable ? null : owners;
  });
}

/**
 * Startup (decision 1571): references no creative has or uses and no open brief holds (`inUse`, project paths), added more
 * than `maxAgeMs` ago, are deleted: a brief abandoned without making its creative. Returns the files deleted.
 */
export async function sweepCreativeReferences(projectDir: string, media: MediaTools, o: { inUse: ReadonlySet<string>; now?: number; maxAgeMs?: number }): Promise<string[]> {
  const lib = new LibraryStore(projectDir, media);
  if (!(await lib.listAssets().catch(() => [])).some((a) => a.referenceFor !== undefined)) return [];
  const { slugs, uses, unreadable } = await new CreativeStore(projectDir).briefAssetUses();
  if (unreadable) return [];
  const cutoff = (o.now ?? Date.now()) - (o.maxAgeMs ?? REFERENCE_MAX_AGE_MS);
  return lib.settleReferences((a) => {
    const path = pathOf(a.file);
    const owned = a.referenceFor!.some((s) => slugs.has(s)) || uses.has(path) || o.inUse.has(path);
    return owned || Date.parse(a.addedAt) > cutoff ? a.referenceFor! : null;
  });
}
