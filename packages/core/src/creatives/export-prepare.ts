import { basename, join } from 'node:path';
import { DEFAULT_RENDER_PROFILE, effectiveLinks, formatDisplayName, messages, starOf, type ExportQuality, type FormatPreset, type JobSummary, type LocalizationRow, type RenderProfile } from '@motion-studio/shared';
import { currentLocale, t } from '../i18n.ts';
import { changedAssets, overlayAssetPaths, readOverlay } from '../localization/store.ts';
import { assertLocalesInBrief, checkedLocale } from '../localization/validate.ts';
import { CodedError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import { PICK_RETRY_AFTER_SEC, type CreativeRef, type CreativeTurnService } from './creative-turns.ts';
import { pendingRenders, resolveExportPicks, resolveLocalizedItems } from './export.ts';
import { withLazyHashes } from './output-hashes.ts';
import type { RenderJobService } from './render-jobs.ts';
import { reconcileRenders, renderFileMatches } from './render-stamps.ts';

/**
 * Ruling L: whether the voice and font files a translation's row recorded are still those files, as a render would take
 * them (the composition folder, then the project). An unreadable overlay counts as fine here: the render reports it.
 */
export const localeAssetsCheck = (projectDir: string, creativeDir: string) => async (n: number, row: LocalizationRow): Promise<boolean> => {
  if (!row.assetHashes) return true;
  const read = await readOverlay(creativeDir, n, row.locale, row.instanceId);
  if (!read) return true;
  const v = (await new CreativeStore(projectDir).readVersions(basename(creativeDir))).find((x) => x.n === n);
  const dir = v?.compositions?.find((c) => c.format === row.instanceId)?.dir;
  if (!dir) return true;
  return (await changedAssets([join(creativeDir, 'outputs', `v${n}`, ...dir.split('/')), projectDir], row, overlayAssetPaths(read.overlay, row))).length === 0;
};

export interface PrepareExportDeps { turns: CreativeTurnService; renders: RenderJobService; presets: () => Promise<FormatPreset[]> }
/** The ★ export's selection (`POST …/export/prepare`, the export dialog's body), or `stars`: every format's ★ as stored. */
export interface PrepareExportBody { picks?: Record<string, unknown>; follow?: string[] | Record<string, unknown>; locales?: string[]; force?: boolean;
  /** Decision 974: the export's quality and resolution (the version renders it needs at the default profile only). */
  quality?: ExportQuality; resolution?: number }
export interface PreparedRender { version: number; formats: string[]; job: JobSummary; covers: boolean; locales?: string[] }

/**
 * What a ★ export would have to render first (Task 5b), started now: the web shows "Rendering 2 formats first…" with the
 * jobs' progress, then calls the export. `renders`: one job per version (an active one is reused); empty: nothing to render.
 * The route `POST …/export/prepare` and the agent's `prepare_export` (decision 917, `o.stars`: the ★ of every format of the
 * brief as the export dialog would show them, primary language only) share it.
 */
export async function prepareExportRenders(deps: PrepareExportDeps, ref: CreativeRef & { store: CreativeStore }, body: PrepareExportBody,
  o: { stars?: boolean } = {}): Promise<{ renders: PreparedRender[] }> {
  // Residual fix (decisions log 866): a render made now writes the creative's outputs, so a discarded variant refuses it.
  const notDiscarded = () => deps.turns.runLocked(ref, () => deps.turns.assertNotDiscarded(ref));
  const creative = await ref.store.get(ref.creativeSlug);
  const creativeDir = ref.store.dir(ref.creativeSlug);
  const presetsForLabels = body.locales ? await deps.presets() : [];
  // Decision 974: what the export at this profile renders on the version (the agent's `prepare_export`: the dialog's default).
  const profile: RenderProfile | undefined = o.stars ? DEFAULT_RENDER_PROFILE
    : body.quality !== undefined || body.resolution !== undefined ? { quality: body.quality ?? DEFAULT_RENDER_PROFILE.quality, ...(body.resolution !== undefined ? { short: body.resolution } : {}) } : undefined;
  const profileOpts = profile ? { profile, presets: await deps.presets() } : {};
  await reconcileRenders({ projectDir: ref.projectDir, store: ref.store, creativeSlug: ref.creativeSlug }).catch(() => false);
  const { versions, complete } = await withLazyHashes({ projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug) });
  const links = effectiveLinks(creative.brief.links, creative.brief.formats);
  let picks = (body.picks ?? {}) as Record<string, number>;
  let follow = body.follow as string[] | Record<string, number> | undefined;
  if (o.stars) {
    // Every primary's ★ and every follower (exported in its primary's ★), as the export dialog starts.
    picks = {};
    for (const f of creative.brief.formats) {
      if (Object.hasOwn(links, f)) continue;
      const star = starOf(versions, f, creative.exportPicks, links).version;
      if (star !== null) picks[f] = star;
    }
    const followers = creative.brief.formats.filter((f) => Object.hasOwn(links, f));
    follow = followers.length > 0 ? followers : undefined;
    if (Object.keys(picks).length === 0) return { renders: [] };
  }
  // As for the export: a follower's version is never decided on partial hashes.
  if (!complete && follow !== undefined) throw new CodedError(503, t().errors.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
  const items = resolveExportPicks({ creativeDir, destination: '/', slug: ref.creativeSlug, versions, picks, follow, links, storedPicks: creative.exportPicks });
  // Languages (Phase 12): the primary one is today's file; the others' translations without a current render are started too.
  const briefPrimary = creative.brief.locales?.primary;
  const tags = body.locales ? [...new Set(body.locales.map((x) => checkedLocale(x, currentLocale())))] : null;
  if (tags) assertLocalesInBrief(creative.brief, tags, currentLocale());
  const includeSource = tags === null || (briefPrimary !== undefined && tags.includes(briefPrimary));
  const otherTags = tags === null ? [] : tags.filter((x) => x !== briefPrimary);
  const pending = includeSource ? await pendingRenders(creativeDir, versions, items, profileOpts) : new Map<number, string[]>();
  if (pending.size > 0) await notDiscarded();
  const renders: PreparedRender[] = [];
  // Answers at once: an active job of that version is reused for the formats it covers and a follow-up job is queued for
  // the rest (I3), so the job returned covers them all.
  for (const [version, formats] of pending) {
    const { job, covers } = await deps.renders.ensureJob(ref, version, formats, { wait: false });
    renders.push({ version, formats, job, covers });
  }
  if (otherTags.length > 0) {
    const loc = await resolveLocalizedItems(creativeDir, versions, items, otherTags,
      (n, file, sha) => renderFileMatches(ref.projectDir, creativeDir, ref.creativeSlug, n, file, sha), localeAssetsCheck(ref.projectDir, creativeDir));
    if (loc.missing.length > 0) {
      const list = loc.missing.map((x) => `${formatDisplayName(presetsForLabels, x.format, currentLocale(), creative.brief.formatLabels)} v${x.n} (${x.locale})`);
      const err = new CodedError(409, messages(currentLocale()).variants.localizationMissing({ list: list.slice(0, 10).join(', ') }), 'localization-missing');
      err.problems = list.slice(0, 50);
      throw err;
    }
    if (loc.pending.size > 0) await notDiscarded();
    for (const [version, p] of loc.pending) {
      const job = await deps.renders.start(ref, version, p.formats, { locales: p.locales, force: body.force === true });
      renders.push({ version, formats: p.formats, job, covers: true, locales: p.locales });
    }
  }
  return { renders };
}
