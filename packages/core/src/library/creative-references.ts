import type { CreativeReferenceEntry } from '@motion-studio/shared';
import { BrandStore } from '../brand/brand-store.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { TrashFn } from '../trash.ts';
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

/** The new creative `slug` takes the references among `paths` (its brief's files and its brief session's). */
export async function claimCreativeReferences(projectDir: string, media: MediaTools, slug: string, paths: readonly string[]): Promise<void> {
  const wanted = new Set(paths);
  await new LibraryStore(projectDir, media).settleReferences(async () => (a) => (
    wanted.has(pathOf(a.file)) && !a.referenceFor!.includes(slug) ? [...a.referenceFor!, slug] : a.referenceFor!
  ));
}

/**
 * What uses the project's files now, read under the assets lock (decision 1585): every creative (folders, briefs), the brand
 * kit's logos and fonts, and the open brief session's files (`inBrief`). `blocked`: something could not be read (a creative,
 * the kit, the session), so nothing may be taken as unused.
 */
async function usage(projectDir: string, inBrief: () => Promise<readonly string[]>) {
  const { slugs, uses, unreadable } = await new CreativeStore(projectDir).briefAssetUses();
  const kit = await new BrandStore(projectDir).readKit().catch(() => null);
  const session = await inBrief().then((x) => new Set(x), () => null);
  const held = (path: string) => uses.has(path) || Boolean(session?.has(path))
    || Boolean(kit && (kit.logos.some((l) => l.file === path) || kit.fonts.some((f) => f.file === path)));
  return { slugs, uses, held, blocked: unreadable || kit === null || session === null };
}

export interface ReferenceRemoval {
  /** Where removed files go (the Trash, like the creative: decision 1582). */
  trash: TrashFn;
  /** The project paths the open brief session holds (decision 1584); a failure keeps every file. */
  inBrief?: () => Promise<readonly string[]>;
}

/**
 * The creatives `deleted` are gone (their folders already moved): each reference they had (added for them, or listed in
 * `deletedPaths`, their briefs' files) goes to the Trash too, unless another creative has or uses it, the brand uses it or the
 * open brief holds it. Nothing is removed while something of that cannot be read. Returns the files removed.
 */
export async function releaseCreativeReferences(projectDir: string, media: MediaTools, deleted: readonly string[], deletedPaths: ReadonlySet<string>, o: ReferenceRemoval): Promise<string[]> {
  return new LibraryStore(projectDir, media).settleReferences(async () => {
    const { slugs, uses, held, blocked } = await usage(projectDir, o.inBrief ?? (async () => []));
    return (a) => {
      const had = a.referenceFor!;
      if (!had.some((s) => deleted.includes(s)) && !deletedPaths.has(pathOf(a.file))) return had;
      const owners = [...new Set([...had.filter((s) => !deleted.includes(s) && slugs.has(s)), ...(uses.get(pathOf(a.file)) ?? [])])];
      return owners.length === 0 && !blocked && !held(pathOf(a.file)) ? null : owners;
    };
  }, o.trash);
}

/**
 * Startup (decision 1571): references no creative has or uses, the brand does not use and the open brief does not hold,
 * added more than `maxAgeMs` ago, go to the Trash: a brief abandoned without making its creative. Returns the files removed.
 */
export async function sweepCreativeReferences(projectDir: string, media: MediaTools, o: ReferenceRemoval & { now?: number; maxAgeMs?: number }): Promise<string[]> {
  const cutoff = (o.now ?? Date.now()) - (o.maxAgeMs ?? REFERENCE_MAX_AGE_MS);
  return new LibraryStore(projectDir, media).settleReferences(async () => {
    const { slugs, held, blocked } = await usage(projectDir, o.inBrief ?? (async () => []));
    return (a) => {
      const owned = blocked || a.referenceFor!.some((s) => slugs.has(s)) || held(pathOf(a.file));
      return owned || Date.parse(a.addedAt) > cutoff ? a.referenceFor! : null;
    };
  }, o.trash);
}
