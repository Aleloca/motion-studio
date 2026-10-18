import { DEFAULT_EXPORT_QUALITY, effectiveLinks, isDefaultProfile, letterOfSlug, profileApplies, profileFor, recordedQuality, renderState, type FormatPreset, type JobSummary, type RenderProfile, type VariantLetter, type VersionEntry } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';
import { probeConfinedFile } from '../brand/agent-guard.ts';
import { CodedError } from '../workspace-store.ts';
import type { CreativeRef } from './creative-turns.ts';
import type { CreativeStore } from './creative-store.ts';
import { checkDestination, exportResolved, plainName, recordedMatches, resolveLocalizedItems, setOf, type ExportCommon, type ExportItem, type ExportResult } from './export.ts';
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
  /** A composition (v2): rendered by the core, so the export's quality and resolution apply to it (decision 974). */
  composed?: true;
}

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
    const base = { format, slug: s.slug, letter: letterOfSlug(s.slug), version: s.version, source: s.source, creativeDir };
    const v = d?.versions.find((x) => x.n === s.version);
    const o = v?.outputs.find((x) => x.format === format);
    // A follower is named after its primary's version, exactly as the creative's own export does.
    const primary = d?.links[format];
    const primaryV = primary !== undefined ? selection[primary]?.version : undefined;
    const named = primaryV !== undefined && primaryV !== s.version ? { v: primaryV } : {};
    const composed = v?.compositions?.some((c) => c.format === format) === true;
    if (o) {
      const usable = plainName(o.file) && (await probeConfinedFile(creativeDir, `outputs/v${s.version}/${o.file}`)) === true;
      // A composition's file is current only when its render is (the single export's `pendingRenders` rule): else it is
      // rendered first, exactly as a single creative's export does.
      const state: GroupPlanState = composed ? (usable && renderState(v!, format) === 'rendered' ? 'ready' : 'needs-render') : usable ? 'ready' : 'missing';
      out.push({ ...base, ...named, file: o.file, width: o.width, height: o.height, ...setOf(o), state, ...(composed ? { composed: true } : {}) });
    } else if (composed) {
      out.push({ ...base, ...named, file: '', width: 0, height: 0, state: 'needs-render', composed: true });
    } else {
      out.push({ ...base, ...named, file: '', width: 0, height: 0, state: 'missing' });
    }
  }
  return out;
}

/**
 * Decision 974: the plan of an export at `profile`. A composition taken at another quality or size is `ready`: it is rendered
 * for the export alone (the route's `withExportRenders`), whatever its version render is. At the default profile a video
 * whose render was made before the quality choice (`standard`) `needs-render`, as a single creative's export does. Without a
 * profile (older clients) the plan as it is.
 */
export async function withGroupProfile(store: CreativeStore, plan: GroupPlanItem[], profile: RenderProfile | undefined, presets: FormatPreset[]): Promise<GroupPlanItem[]> {
  if (!profile) return plan;
  const cache = new Map<string, VersionEntry[]>();
  const versionsOf = async (slug: string) => {
    if (!cache.has(slug)) cache.set(slug, await store.readVersions(slug).catch(() => []));
    return cache.get(slug)!;
  };
  const out: GroupPlanItem[] = [];
  for (const p of plan) {
    const v = p.state === 'missing' ? undefined : (await versionsOf(p.slug)).find((x) => x.n === p.version);
    if (!v?.compositions?.some((c) => c.format === p.format)) { out.push(p); continue; }
    const preset = findPreset(presets, p.format);
    const wanted = profileFor(preset, p.format, profile);
    if (!isDefaultProfile(wanted)) { out.push(p.state === 'ready' && recordedMatches(v, p.format, wanted) ? p : { ...p, state: 'ready' }); continue; }
    const stale = p.state === 'ready' && profileApplies(preset, p.format) && recordedQuality(v.outputs.find((o) => o.format === p.format)) !== DEFAULT_EXPORT_QUALITY;
    out.push(stale ? { ...p, state: 'needs-render' } : p);
  }
  return out;
}

/** The export item of a plan item (for `exportResolved` and the localized resolver). */
export const itemOfPlan = (p: GroupPlanItem): ExportItem => ({
  format: p.format, n: p.version, ...(p.v !== undefined ? { v: p.v } : {}), file: p.file, width: p.width, height: p.height, ...(p.set ? { set: p.set } : {}), creativeDir: p.creativeDir,
});

/** A translation of a plan item that cannot be exported, with why (`missing`: the source item itself is not usable). */
export interface GroupLocaleGap { plan: GroupPlanItem; locale: string; state: 'no-translation' | 'not-rendered' | 'missing' }
/** Translations to render first: one entry per member, version and language, with the formats it lacks there. */
export interface GroupLocalePending { slug: string; n: number; locale: string; formats: string[] }

/**
 * The translated files of the plan's items in `otherTags`: each format's localized outputs come from the member the selection
 * picked, at the version it picked (a translation stays inside its variant). As for a single creative (`resolveLocalizedItems`),
 * a composition's translation does not need its primary-language render: `needs-render` items are resolved too. A translation
 * with no current render is returned in `pending` (grouped by member, version and language: the caller renders it in that
 * member, as the single export does) and in `unavailable` as `not-rendered`; a `missing` item is listed for each language,
 * never skipped silently.
 */
export async function resolveGroupLocalized(plan: GroupPlanItem[], store: CreativeStore, otherTags: readonly string[],
  checks: { matches?: (slug: string, n: number, file: string, sha256: string) => Promise<boolean>; assetsOk?: (slug: string, n: number, row: NonNullable<VersionEntry['localizations']>[number]) => Promise<boolean> } = {}):
  Promise<{ items: ExportItem[]; unavailable: GroupLocaleGap[]; pending: GroupLocalePending[] }> {
  const items: ExportItem[] = [];
  const unavailable: GroupLocaleGap[] = [];
  const pending: GroupLocalePending[] = [];
  for (const p of plan) {
    if (p.state === 'missing') {
      for (const locale of otherTags) unavailable.push({ plan: p, locale, state: 'missing' });
      continue;
    }
    const r = await resolveLocalizedItems(p.creativeDir, await store.readVersions(p.slug), [itemOfPlan(p)], otherTags,
      checks.matches ? (n, file, sha) => checks.matches!(p.slug, n, file, sha) : undefined, checks.assetsOk ? (n, row) => checks.assetsOk!(p.slug, n, row) : undefined);
    items.push(...r.items.map((it) => ({ ...it, creativeDir: p.creativeDir })));
    for (const m of r.missing) unavailable.push({ plan: p, locale: m.locale, state: 'no-translation' });
    for (const locale of new Set([...r.pending.values()].flatMap((x) => x.locales))) {
      unavailable.push({ plan: p, locale, state: 'not-rendered' });
      const at = pending.find((x) => x.slug === p.slug && x.n === p.version && x.locale === locale);
      if (at) { if (!at.formats.includes(p.format)) at.formats.push(p.format); } else pending.push({ slug: p.slug, n: p.version, locale, formats: [p.format] });
    }
  }
  return { items, unavailable, pending };
}

/**
 * Renders the translations `pending` lists, each in its own member (the single export's on-demand render, per member and per
 * language so one that cannot render does not stop the others). `localization-needs-force` (open problems or outdated entries,
 * `force` not set) is collected across members and thrown at the end as one 409 with every problem, for "Renderizza comunque";
 * any other failure is returned per member and language (`errors`, key `slug\0locale`).
 */
export async function renderGroupLocales(renders: { renderLocalesAndWait(ref: CreativeRef, n: number, formats: string[], locales: readonly string[], force: boolean): Promise<JobSummary | null> },
  ref: CreativeRef, pending: GroupLocalePending[], force: boolean, needsForceMessage: (list: string) => string):
  Promise<{ errors: Map<string, string>; rendered: Array<{ slug: string; version: number; formats: string[]; locale: string }> }> {
  const errors = new Map<string, string>();
  const rendered: Array<{ slug: string; version: number; formats: string[]; locale: string }> = [];
  const needsForce: string[] = [];
  for (const p of pending) {
    try {
      const job = await renders.renderLocalesAndWait({ ...ref, creativeSlug: p.slug }, p.n, p.formats, [p.locale], force);
      if (job?.state === 'failed') errors.set(`${p.slug}\0${p.locale}`, job.error ?? '');
    } catch (e) {
      if (e instanceof CodedError && e.apiCode === 'localization-needs-force') { needsForce.push(...(e.problems?.length ? e.problems : [e.message])); continue; }
      errors.set(`${p.slug}\0${p.locale}`, e instanceof Error ? e.message : String(e));
    }
    rendered.push({ slug: p.slug, version: p.n, formats: [...p.formats], locale: p.locale });
  }
  if (needsForce.length > 0) {
    const list = [...new Set(needsForce)];
    const err = new CodedError(409, needsForceMessage(list.slice(0, 10).join(', ')), 'localization-needs-force');
    err.problems = list.slice(0, 50);
    throw err;
  }
  return { errors, rendered };
}

/** The `needs-render` items of a plan, grouped as the render jobs take them: member → version → formats. */
export function pendingByMember(plan: readonly GroupPlanItem[]): Map<string, Map<number, string[]>> {
  const byMember = new Map<string, Map<number, string[]>>();
  for (const p of plan) {
    if (p.state !== 'needs-render') continue;
    const m = byMember.get(p.slug) ?? new Map<number, string[]>();
    m.set(p.version, [...(m.get(p.version) ?? []), p.format]);
    byMember.set(p.slug, m);
  }
  return byMember;
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
