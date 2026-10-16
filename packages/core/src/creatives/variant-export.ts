import { effectiveLinks, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { probeConfinedFile } from '../brand/agent-guard.ts';
import type { CreativeRef } from './creative-turns.ts';
import type { CreativeStore } from './creative-store.ts';
import { checkDestination, exportResolved, plainName, resolveLocalizedItems, setOf, type ExportCommon, type ExportItem, type ExportResult } from './export.ts';
import type { VariantGroupService } from './variant-group.ts';

/**
 * Phase 15, Task 6 (spec §6): the export of a variant group. Each format of the group's brief comes from the member and version
 * `VariantGroupService.groupSelection` names (the group ★, or the default rule on variant A; a removed format is absent and a
 * discarded member is never used). Files keep today's names: they are named with the HOST's title and slug (never a sister's
 * `~x` slug) and the version number of the file's own member, so the name is the one the host would give.
 */

/** `ready`: the file is usable; `needs-render`: a composition with no current render (the route renders it first); `missing`: no usable file. */
export type GroupPlanState = 'ready' | 'needs-render' | 'missing';

export interface GroupPlanItem {
  format: string;
  /** The member (creative folder) the file comes from, and its letter. */
  slug: string;
  letter: VariantLetter;
  /** The version exported (a follower: its own file's version). */
  version: number;
  source: 'pick' | 'default';
  /** Named after this version (`{v}`) when it differs from `version`: a follower is named after its primary's version (decisions log 140). */
  v?: number;
  file: string;
  width: number;
  height: number;
  set?: NonNullable<ExportItem['set']>;
  /** The member's folder. */
  creativeDir: string;
  state: GroupPlanState;
}

const letterOf = (slug: string): VariantLetter => (slug.includes('~') ? slug.slice(-1) : 'a') as VariantLetter;

/**
 * What a group export would copy, per format in the brief's order, without writing anything. `ref` may be any member. A member
 * folder that cannot be read, or a version that has vanished, gives a `missing` item (never a throw). Refused (409 from the
 * group service) for a creative outside a group.
 */
export async function planGroupExport(svc: VariantGroupService, store: CreativeStore, ref: CreativeRef): Promise<GroupPlanItem[]> {
  const selection = await svc.groupSelection(ref);
  const cache = new Map<string, { versions: VersionEntry[]; links: Record<string, string> } | null>();
  const dataOf = async (slug: string) => {
    if (!cache.has(slug)) {
      cache.set(slug, await Promise.all([store.get(slug), store.readVersions(slug)])
        .then(([c, versions]) => ({ versions, links: effectiveLinks(c.brief.links, c.brief.formats) }), () => null));
    }
    return cache.get(slug)!;
  };
  const out: GroupPlanItem[] = [];
  for (const [format, s] of Object.entries(selection)) {
    const creativeDir = store.dir(s.slug);
    const d = await dataOf(s.slug);
    const base = { format, slug: s.slug, letter: letterOf(s.slug), version: s.version, source: s.source, creativeDir };
    const v = d?.versions.find((x) => x.n === s.version);
    const o = v?.outputs.find((x) => x.format === format);
    // A follower is named after its primary's version, exactly as the creative's own export does.
    const primary = d?.links[format];
    const primaryV = primary !== undefined ? selection[primary]?.version : undefined;
    const named = primaryV !== undefined && primaryV !== s.version ? { v: primaryV } : {};
    if (o) {
      const usable = plainName(o.file) && (await probeConfinedFile(creativeDir, `outputs/v${s.version}/${o.file}`)) === true;
      out.push({ ...base, ...named, file: o.file, width: o.width, height: o.height, ...setOf(o), state: usable ? 'ready' : 'missing' });
    } else if (v?.compositions?.some((c) => c.format === format)) {
      out.push({ ...base, ...named, file: '', width: 0, height: 0, state: 'needs-render' });
    } else {
      out.push({ ...base, ...named, file: '', width: 0, height: 0, state: 'missing' });
    }
  }
  return out;
}

/** The export item of a plan item (for `exportResolved` and the localized resolver). */
export const itemOfPlan = (p: GroupPlanItem): ExportItem => ({
  format: p.format, n: p.version, ...(p.v !== undefined ? { v: p.v } : {}), file: p.file, width: p.width, height: p.height, ...(p.set ? { set: p.set } : {}), creativeDir: p.creativeDir,
});

/**
 * The translated files of the plan's `ready` items in `otherTags`: each format's localized outputs come from the member the
 * selection picked, at the version it picked (a translation stays inside its variant). A translation that is missing or has no
 * current render is not rendered here: its format is returned in `unavailable`.
 */
export async function resolveGroupLocalized(plan: GroupPlanItem[], store: CreativeStore, otherTags: readonly string[],
  checks: { matches?: (slug: string, n: number, file: string, sha256: string) => Promise<boolean>; assetsOk?: (slug: string, n: number, row: NonNullable<VersionEntry['localizations']>[number]) => Promise<boolean> } = {}):
  Promise<{ items: ExportItem[]; unavailable: Array<{ plan: GroupPlanItem; locale: string; state: 'no-translation' | 'not-rendered' }> }> {
  const items: ExportItem[] = [];
  const unavailable: Array<{ plan: GroupPlanItem; locale: string; state: 'no-translation' | 'not-rendered' }> = [];
  for (const p of plan) {
    if (p.state !== 'ready') continue;
    const r = await resolveLocalizedItems(p.creativeDir, await store.readVersions(p.slug), [itemOfPlan(p)], otherTags,
      checks.matches ? (n, file, sha) => checks.matches!(p.slug, n, file, sha) : undefined, checks.assetsOk ? (n, row) => checks.assetsOk!(p.slug, n, row) : undefined);
    items.push(...r.items.map((it) => ({ ...it, creativeDir: p.creativeDir })));
    for (const m of r.missing) unavailable.push({ plan: p, locale: m.locale, state: 'no-translation' });
    for (const locale of new Set([...r.pending.values()].flatMap((x) => x.locales))) unavailable.push({ plan: p, locale, state: 'not-rendered' });
  }
  return { items, unavailable };
}

export interface GroupExportResult extends ExportResult {
  /** The plan items that were not copied (no usable file, or a render still to do), with why. */
  unavailable: GroupPlanItem[];
}

/**
 * Copies the `ready` items of `plan` into the destination with the shared export rules (destination checks, never overwriting,
 * name pattern, collisions). The others are returned in `unavailable`; nothing exportable is not an error: the result has no
 * files. `items`: replaces the primary-language items (already localized by the caller).
 */
export async function exportGroup(plan: GroupPlanItem[], opts: ExportCommon, items?: ExportItem[]): Promise<GroupExportResult> {
  const unavailable = plan.filter((p) => p.state !== 'ready');
  const ready = items ?? plan.filter((p) => p.state === 'ready').map(itemOfPlan);
  if (!ready.length) return { destination: await checkDestination(opts.destination, opts.forbiddenRoot), files: [], skipped: [], unavailable };
  const result = await exportResolved(ready, opts);
  return { ...result, unavailable };
}
