import type { Git } from '../git.ts';
import { recoverRenameJournal } from '../library/rename-recovery.ts';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { changedAssets, overlayAssetPaths, readOverlay } from '../localization/store.ts';
import type { FastifyInstance } from 'fastify';
import { messages, type JobSummary, INSTANCE_FOLDER_RE, INSTANCE_ID_RE, briefSchema, briefWriteSchema, presetOf, storePackFormats, storePackSchema, type PinFramesView, checkLink, defaultLinks, effectiveLinks, formatDisplayName, isExportDate, issuesText, renderProblems, linkedCodebaseSchema, pinSchema, type Brief, type CreativeDetail, type OutputIssue, type FormatPreset, type RecentCreative, type ServerMessage, type LocalizationRow, hostOf, MAX_VARIANTS, VARIANT_LETTERS, type VariantDetail, type VariantLetter } from '@motion-studio/shared';
import { z } from 'zod';
import { brandJobKey } from '../brand/brand-analysis.ts';
import { assertCodebasesOutside, normalizeCodebaseList } from '../codebases.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeSideStateStore, StoppedSession } from '../creatives/creative-side-state.ts';
import { exportResolved, exportVersion, pendingRenders, resolveExportPicks, resolveLocalizedItems, type ExportItem } from '../creatives/export.ts';
import { assertLocalesInBrief, checkedLocale } from '../localization/validate.ts';
import { storyboardDir, storyboardSchema, sweepStoryboardTemps, type PreviewService } from '../creatives/previews.ts';
import { readJsonFile } from '../json-file.ts';
import { isRealDirChain } from '../creatives/core-files.ts';
import type { UrlSigner } from './signed-urls.ts';
import { formatSummaries } from '../creatives/format-summary.ts';
import { MAX_DIRECTION_CHARS, VariantGroupService } from '../creatives/variant-group.ts';
import { exportGroup, itemOfPlan, pendingByMember, planGroupExport, renderGroupLocales, resolveGroupLocalized, type GroupPlanItem } from '../creatives/variant-export.ts';
import type { VariantFanout } from '../creatives/variant-fanout.ts';
import { withLazyHashes } from '../creatives/output-hashes.ts';
import { creativeJobKey, PICK_RETRY_AFTER_SEC, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import type { RenderJobService } from '../creatives/render-jobs.ts';
import { reconcileRenders, renderFileMatches } from '../creatives/render-stamps.ts';
import { sweepDerivedCaches, sweepEditorStaging } from '../creatives/cache-sweep.ts';
import { editorCompositionView } from '../creatives/editor-staging.ts';
import { directEditBodySchema, type DirectEditService } from '../creatives/direct-edit.ts';
import { sweepProjectRenders } from '../render/render-sweep.ts';
import { FormatCatalog, findPreset } from '../formats/format-catalog.ts';
import { mergeStorePack, verifyScreens } from '../store-pack/brief.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { completeGitignore, sweepProject } from '../project-maintenance.ts';
import { CodedError, expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';
import { localizedCompositionView } from './localization-routes.ts';
import { currentLocale, t } from '../i18n.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { readConfinedFile } from '../brand/agent-guard.ts';
import { LibraryStore } from '../library/library-store.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { checkVectorSvg, MAX_VECTOR_SVG_BYTES } from '../identity/svg-check.ts';

export interface CreativeRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  /** Direct edits saved as versions (Phase 10b). */
  edits: DirectEditService;
  media: MediaTools;
  openPath: (p: string) => Promise<void>;
  isJobActive: (key: string) => boolean;
  /** Tells the clients a creative changed (e.g. lazy hashes finished after the GET answered). */
  broadcast?: (msg: ServerMessage) => void;
  /** Render jobs of v2 versions (Task 5). */
  renders: RenderJobService;
  /** Storyboards and live preview sessions (Task 5b). */
  previews: PreviewService;
  /** Signs the storyboard image URLs (fix I4). */
  signer: UrlSigner;
  /** Commits the brand kit change of "Use as brand logo" (Phase 14); absent: the change is written and not committed. */
  git?: Git;
  /** Phase 15: starts variants (`POST …/variants/run`): directions turn, then the fan-out. */
  variantRuns: VariantFanout;
}

const isInsideDir = (p: string, base: string | null) => Boolean(base && p.startsWith(base.endsWith(sep) ? base : base + sep));

/** `formats`: the formats the request applies to (spec §2.5); absent or empty: all of them. */
export const turnBodySchema = z.object({ text: z.string().max(10_000).optional(), pins: z.array(pinSchema).max(50).optional(), formats: z.array(z.string().min(1).max(200)).max(100).optional() });
const createBody = z.object({ title: z.string(), brief: briefWriteSchema, generate: z.boolean().optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });
// `services` alone changes only that field of the stored brief (the composer's Services chip); `brief` replaces the brief.
// `formatLabels` / `formats` alone merge into the stored brief the same way (Phase 12: inline labels, reorder, removal).
// `formatLabels` merges per key (an omitted key is kept; `''` or `null` clears that key), so a stale tab cannot drop a newer label.
// `formats` is checked against the stored ones by the core (only reorder or remove), so a legacy odd id can be taken out.
const editBody = z.object({ title: z.string().optional(), brief: briefWriteSchema.optional(), services: briefSchema.shape.services,
  formatLabels: z.record(z.string(), z.union([z.string().trim().max(60), z.null()])).optional(),
  formats: z.array(z.string().min(1).max(200)).min(1).max(100).optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional(),
  /** Phase 14: sets, changes (a pack) or takes out (`null`) the store pack; alone, or with the title and services only. */
  storePack: z.union([storePackSchema, z.null()]).optional() })
  .refine((b) => !b.brief || (b.formats === undefined && b.formatLabels === undefined), { message: 'issue.briefWithPartial' })
  .refine((b) => b.storePack === undefined || (!b.brief && b.formats === undefined && b.formatLabels === undefined), { message: 'issue.briefWithPartial' });
/** Ruling H: a full brief save whose `formatLabels` name formats it no longer has drops those labels (no 400). */
function pruneLabelsOfRemovedFormats(raw: unknown): unknown {
  const b = (raw as { brief?: { formats?: unknown; formatLabels?: unknown } } | null)?.brief;
  if (!b || !Array.isArray(b.formats) || !b.formatLabels || typeof b.formatLabels !== 'object' || Array.isArray(b.formatLabels)) return raw;
  const kept = Object.fromEntries(Object.entries(b.formatLabels).filter(([k]) => (b.formats as unknown[]).includes(k)));
  return { ...(raw as object), brief: { ...b, formatLabels: kept } };
}
/**
 * Phase 13: a message sent while a turn runs (`live`) or queued for after it (`queued`). The text limit is checked by the
 * core (a translated 409 `limit`); this cap only bounds the request. No attachments: pins only (spec §2).
 */
const messageBody = z.object({
  clientId: z.uuid(), text: z.string().max(20_000), pins: z.array(pinSchema).max(50).optional(), mode: z.enum(['live', 'queued']),
}).strict();
const queueEditBody = z.object({ text: z.string().max(20_000), pins: z.array(pinSchema).max(50).optional() }).strict();
const queueOrderBody = z.object({ order: z.array(z.string().min(1).max(100)).max(100) }).strict();
const pickBody = z.object({ format: z.string().min(1).max(200), version: z.number().int().min(1).nullable() });
/**
 * Export of the ★ versions (spec §3.3): `picks` (format → vN), `follow` (followers, exported in their primary's version),
 * `pattern` (else the workspace's `exportNamePattern`). `version` alone is the older payload: every output of that version.
 */
const MAX_EXPORT_FORMATS = 100;
const exportBody = z.object({
  destination: z.unknown().optional(),
  picks: z.record(z.string().min(1).max(200), z.unknown()).refine((r) => Object.keys(r).length <= MAX_EXPORT_FORMATS).optional(),
  // A record: the version the client showed for each follower; a list (older clients): the core resolves it.
  follow: z.union([
    z.array(z.string().min(1).max(200)).max(MAX_EXPORT_FORMATS),
    z.record(z.string().min(1).max(200), z.unknown()).refine((r) => Object.keys(r).length <= MAX_EXPORT_FORMATS),
  ]).optional(),
  pattern: z.unknown().optional(),
  date: z.unknown().optional(),
  version: z.number().int().min(1).optional(),
  /** Phase 12 §3.5: the languages to export (the primary one is the primary-language file); absent: today's files. */
  locales: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
  /** "Render anyway" for translations rendered first that have open problems or outdated entries. */
  force: z.boolean().optional(),
});
/** Phase 15 (spec §6): `POST …/export-group`; no picks, the group selection decides. */
const exportGroupBody = z.object({
  destination: z.unknown().optional(), pattern: z.unknown().optional(), date: z.unknown().optional(),
  locales: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
  /** The formats to export (the dialog's ticked rows); absent: every format of the selection. */
  formats: z.array(z.string().min(1).max(200)).max(MAX_EXPORT_FORMATS).optional(),
  /** "Render anyway" for translations rendered first that have open problems or outdated entries (as the single export). */
  force: z.boolean().optional(),
}).strict();
const useAsLogoBody = z.object({ variant: z.enum(['primary', 'icon']) }).strict();
const linkBody = z.object({ follower: z.string().min(1).max(200), primary: z.string().min(1).max(200).nullable() });
/** Phase 15: `POST …/variants` (see the route). */
const addVariantsBody = z.object({
  count: z.number().int().min(1).max(MAX_VARIANTS).optional(),
  directions: z.array(z.union([z.string().max(MAX_DIRECTION_CHARS), z.null()])).max(MAX_VARIANTS).optional(),
  baseFrom: z.object({ slug: z.string().min(1).max(100), version: z.number().int().min(1) }).strict().optional(),
}).strict();
const variantPickBody = z.object({ slug: z.string().min(1).max(100), version: z.number().int().min(1) }).strict();
const layoutBody = z.object({ layout: z.enum(['variant', 'format']) }).strict();
const directionBody = z.object({ direction: z.string().max(MAX_DIRECTION_CHARS) }).strict();
/**
 * Phase 15 (ruling R3): `POST …/variants/run`. `targets`: letters, or every active variant; `request`: the same body as
 * `POST …/turns`, or null for the first generation.
 */
const variantRunBody = z.object({
  targets: z.union([z.array(z.enum(VARIANT_LETTERS as unknown as [VariantLetter, ...VariantLetter[]])).min(1).max(MAX_VARIANTS), z.literal('all-active')]),
  request: z.union([turnBodySchema.strict(), z.null()]),
}).strict();
/** A render request (Task 5): `formats` to render (a follower stands for its primary); absent or empty: every primary. */
const renderBody = z.object({
  formats: z.array(z.string().min(1).max(200)).max(100).optional(),
  /** Phase 12 §3.5: languages to render (`outputs/vN/<instanceId>.<locale>.<ext>`); absent or empty: today's files. */
  locales: z.array(z.string().min(1).max(40)).max(11).optional(),
  /** "Render anyway": translations with open problems or outdated entries are rendered and marked as forced. */
  force: z.boolean().optional(),
}).strict();
/**
 * A live preview session (Task 5b): the format, and the exact origin of the UI page that embeds the iframe. `renewFrom`
 * (Phase 10b): the session this one renews; the editor's staged files move to the new one when both show the same version
 * and format.
 */
const previewBody = z.object({ format: z.string().min(1).max(200), parentOrigin: z.string().min(1).max(200), renewFrom: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict();
/**
 * Staging a file for an editor draft (Phase 10b): the live preview session, and a library asset, a brand font or an SVG
 * edited in the editor (SVG inner editor). An edited SVG's `content` is bounded here only as transport (twice the SVG
 * limit in characters); its 512 KB limit is the SVG check's, so an oversized one is refused with that reason like any other.
 */
const stageBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('library'), file: z.string().min(1).max(300) }).strict(),
    z.object({ kind: z.literal('brandFont'), id: z.string().min(1).max(64) }).strict(),
    z.object({
      kind: z.literal('svgEdit'), clipId: z.string().min(1).max(200),
      baseSrc: z.string().min(1).max(300).regex(/^assets\/[^\\]+\.svg$/i), content: z.string().min(1).max(2 * MAX_VECTOR_SVG_BYTES),
    }).strict(),
  ]),
}).strict();
/** A composition folder's name: a preset id, or an instance id `<preset>@<k>` (Phase 12). */
const FOLDER_RE = INSTANCE_FOLDER_RE;
const FRAME_FILE_RE = /^f-\d{1,3}\.jpg$/;
/** A pin frame of version n: `<n>-<i>.jpg` (creative-turns `extractPinFrames`). */
const PIN_FRAME_RE = /^(\d{1,6})-(\d{1,3})(e?)\.jpg$/;

/**
 * The links a new creative starts with: the ones sent (sanitized, each pair checked with `checkLink`; the duration is not
 * known yet, so it is checked at materialization), else `defaultLinks` over the brief's formats in the catalog, with the
 * duration left unknown (`undefined`: a `null` would be strict and drop every video link).
 */
function initialLinks(brief: Brief, presets: FormatPreset[]): Record<string, string> {
  if (brief.links === undefined) {
    const known = brief.formats.map((id) => findPreset(presets, id)).filter((p): p is FormatPreset => p !== undefined);
    return defaultLinks(known, undefined);
  }
  const links = effectiveLinks(brief.links, brief.formats);
  const e = t().errors;
  const label = (id: string) => formatDisplayName(presets, id, currentLocale(), brief.formatLabels);
  for (const [follower, primary] of Object.entries(links)) {
    const c = checkLink({ formats: brief.formats, links }, [], presets, follower, primary);
    if (!c.ok) throw new CodedError(400, e.linkIncompatible({ follower: label(follower), primary: label(primary), reason: e.followReason[c.reason] }), 'link-incompatible');
  }
  return links;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }));
  return r.data;
}

/**
 * In every readable project: marks as interrupted the creatives left in `working` by a previous run, sweeps leftovers
 * of interrupted uploads and brand jobs, and completes the .gitignore.
 */
export interface RecoverOptions {
  /** Whether a creative has a queued or running render job (its render temp files are left alone). */
  renderActive?: (projectSlug: string, creativeSlug: string) => boolean;
  /** Media cache files a live session uses, and the cache cap (`pruneMediaCache`). */
  mediaInUse?: (file: string) => boolean;
  mediaCacheMaxBytes?: number;
  /** Editor staging folders a live preview session uses (the sweep leaves them). */
  stagingInUse?: (dir: string) => boolean;
  /** Commits what finishing an interrupted asset rename changed. */
  git?: Git;
  /** Phase 13: where a cut turn's session is remembered (the core's side state, out of the agent's reach). */
  sideState?: CreativeSideStateStore;
  /**
   * Phase 15 (deferred 51): applies a variant's pending brief (the group's brief kept while it worked) that a crash left
   * behind, under the creative's lock (`CreativeTurnService.briefAfterJob`). Called for each creative with one and no job.
   */
  applyPendingBrief?: (ref: CreativeRef) => Promise<void>;
}

export async function recoverWorkspace(ws: WorkspaceStore, isJobActive: (key: string) => boolean = () => false, ro: RecoverOptions = {}): Promise<void> {
  for (const p of await ws.listProjects()) {
    if (!p.ok) continue;
    const dir = ws.projectDir(p.slug);
    const side = ro.sideState;
    // Fix round 1 (M2): every creative gets its side record now, before any agent can run, so `queued`/`stoppedSession`
    // written into a creative.json later (by anyone) are never taken as the user's, even in a creative nobody opened yet.
    if (side) {
      // Phase 15: every creative, real and orphan sisters included (`listAll`): each needs its side record.
      for (const c of await new CreativeStore(dir).listAll().catch(() => [])) {
        // A creative.json that cannot be read now is migrated on its first successful open (fix round 2).
        if (c.ok) await side.read(dir, c.slug).catch(() => {});
        else await side.markPendingMigration(dir, c.slug).catch(() => {});
      }
    }
    const remember = side ? (slug: string, s: StoppedSession) => side.update(dir, slug, () => ({ stoppedSession: s })) : undefined;
    await new CreativeStore(dir).recoverInterrupted((slug) => isJobActive(creativeJobKey(ws.root, p.slug, slug)), remember).catch((err: Error) => {
      console.warn(`Motion Studio: creative recovery failed in project ${p.slug}: ${err.message}`);
    });
    // Phase 15 (deferred 51): a group's brief kept for a variant that was working when the app stopped is applied now, not
    // only at that variant's next job (its brief would otherwise stay behind the group's until then).
    if (side && ro.applyPendingBrief) {
      for (const c of await new CreativeStore(dir).listAll().catch(() => [])) {
        if (!c.ok || isJobActive(creativeJobKey(ws.root, p.slug, c.slug))) continue;
        if (!(await side.pendingBrief(dir, c.slug).catch(() => null))) continue;
        await ro.applyPendingBrief({ root: ws.root, projectSlug: p.slug, projectDir: dir, creativeSlug: c.slug })
          .catch((err: Error) => console.warn(`Motion Studio: the group's brief could not be applied to ${c.slug}: ${err.message}`));
      }
    }
    // Render and media temp files left by a render the app was killed during, and the media cache's garbage. This also runs
    // on a workspace switch, when renders may run: their creatives are skipped and files in use are kept.
    await sweepProjectRenders(dir, {
      skipCreative: (slug) => ro.renderActive?.(p.slug, slug) ?? false,
      media: { ...(ro.mediaInUse ? { inUse: ro.mediaInUse } : {}), ...(ro.mediaCacheMaxBytes !== undefined ? { maxBytes: ro.mediaCacheMaxBytes } : {}) },
    }).catch((err: Error) => console.warn(`Motion Studio: render cleanup failed in project ${p.slug}: ${err.message}`));
    // A rename of a library asset a crash interrupted: finished (or undone) before anything else reads the project.
    await recoverRenameJournal(dir, ro.git).catch((err: Error) => console.warn(`Motion Studio: asset rename recovery failed in project ${p.slug}: ${err.message}`));
    await sweepStoryboardTemps(dir).catch(() => []);
    // The derived caches (storyboards, pin frames, agent originals, reference frames): old and over-cap version folders.
    await sweepDerivedCaches(dir, { skipCreative: (slug) => isJobActive(creativeJobKey(ws.root, p.slug, slug)) }).catch(() => []);
    // The editor's staging folders a quit or a crash left behind (older than 24 h; never a live session's).
    await sweepEditorStaging(dir, { ...(ro.stagingInUse ? { inUse: ro.stagingInUse } : {}) }).catch(() => []);
    await Promise.all([sweepProject(dir, !isJobActive(brandJobKey(ws.root, p.slug))), completeGitignore(dir)]).catch((err: Error) => {
      console.warn(`Motion Studio: cleanup failed in project ${p.slug}: ${err.message}`);
    });
  }
}

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

/**
 * Phase 15 (spec §3 "Identità", decision 845): the size of the variant group a new identity creative gets: `identity.concepts`
 * of a logo from scratch (1..5) when it is above 1 and the brief has an identity format. A brief that already lists several
 * instances of one identity preset (an old client's `identity-logo@2`…) is left as it is: no group.
 */
export function identityGroupSize(brief: Pick<Brief, 'formats' | 'identity'>, presets: readonly FormatPreset[]): number {
  if (brief.identity?.start !== 'scratch') return 1;
  const ids = brief.formats.filter((f) => presets.find((p) => p.id === presetOf(f))?.identity);
  if (ids.length === 0 || new Set(ids.map(presetOf)).size !== ids.length) return 1;
  return Math.min(5, Math.max(1, brief.identity.concepts ?? 3));
}

export function registerCreativeRoutes(app: FastifyInstance, ctx: CreativeRoutesContext): void {
  const catalog = () => new FormatCatalog(ctx.requireWorkspace().root);
  const refOf = async (slug: string, creativeSlug: string): Promise<CreativeRef & { store: CreativeStore }> => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug); // 404 for unknown projects
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    // 400 for invalid slugs; phase 15: 404 for a sister-shaped folder that is neither a real sister nor an orphan (ruling R2).
    await store.assertOpenable(creativeSlug);
    return { root: ws.root, projectSlug: slug, projectDir, creativeSlug, store };
  };
  const variantsOf = (ref: CreativeRef & { store: CreativeStore }) => new VariantGroupService({ store: ref.store, turns: ctx.turns });
  /** Phase 15: the variant side of a creative's detail; absent outside a group (an old creative's detail is unchanged). */
  const variantDetail = async (ref: CreativeRef & { store: CreativeStore }): Promise<VariantDetail | undefined> => {
    const r = await variantsOf(ref).resolve(ref);
    const slug = ref.creativeSlug;
    if (r.orphan) return { orphan: true, host: hostOf(slug), letter: slug.slice(-1) as VariantLetter };
    if (!r.group) return undefined;
    const letter = r.group.members.find((m) => m.slug === slug)?.letter ?? 'a';
    const missing = r.group.members.filter((m) => r.missing.includes(m.slug)).map((m) => m.letter);
    return { orphan: false, host: r.host.creativeSlug, letter, group: r.group, missing };
  };

  app.get('/api/formats', async () => catalog().load());
  app.put<{ Body: { presets?: unknown } }>('/api/formats', async (req) => catalog().save((req.body?.presets ?? []) as never));
  app.post('/api/formats/reset', async () => catalog().resetToDefaults());

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/creatives', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    return new CreativeStore(ws.projectDir(req.params.slug)).list();
  });

  // Read-only: the most recent creatives across all readable projects ("Jump back in").
  app.get<{ Querystring: { limit?: string } }>('/api/recent-creatives', async (req): Promise<RecentCreative[]> => {
    const raw = Number.parseInt(req.query.limit ?? '', 10);
    const limit = Number.isFinite(raw) ? Math.min(12, Math.max(1, raw)) : 3;
    const ws = ctx.requireWorkspace();
    const all: RecentCreative[] = [];
    for (const p of await ws.listProjects()) {
      if (!p.ok) continue;
      const items = await new CreativeStore(ws.projectDir(p.slug)).list().catch(() => []);
      for (const i of items) {
        if (!i.ok) continue;
        const { ok: _ok, ...summary } = i;
        all.push({ ...summary, project: { slug: p.slug, name: p.project.name } });
      }
    }
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.project.slug.localeCompare(b.project.slug) || a.slug.localeCompare(b.slug));
    return all.slice(0, limit);
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/creatives', async (req, reply) => {
    const body = parse(createBody, req.body);
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const linkedCodebases = body.linkedCodebases ? normalizeCodebaseList(body.linkedCodebases) : null;
    if (linkedCodebases) await assertCodebasesOutside(linkedCodebases, [ws.projectDir(req.params.slug), ws.root]);
    const store = new CreativeStore(ws.projectDir(req.params.slug));
    // Phase 14: the store pack goes through this route as part of the brief; its screens get the same check as the pack route.
    if (body.brief.storePack) await verifyScreens(ws.projectDir(req.params.slug), ctx.media, body.brief.storePack);
    const presets = (await catalog().load()).presets;
    let brief = body.brief;
    if (brief.storePack) {
      const pack = brief.storePack;
      const slots = storePackFormats(pack, presets).formats;
      if (pack.instances) {
        // The client chose the instances (a hand-picked one of the same preset can sit beside them): they must match the slots.
        const ok = pack.instances.length === slots.length && new Set(pack.instances).size === slots.length
          && pack.instances.every((id, i) => presetOf(id) === presetOf(slots[i]!) && brief.formats.includes(id));
        if (!ok) throw new CodedError(400, t().variants.storePack.badInstances, 'store-pack-instances');
      } else if (slots.some((f) => !brief.formats.includes(f))) {
        // No instances given: the pack's slots are the instances; a pack whose instances the brief lacks gets them (and their labels).
        const { storePack: _p, ...bare } = brief;
        brief = mergeStorePack({ ...bare, formats: brief.formats.filter((f) => !slots.includes(f)) }, pack, presets).brief;
      } else {
        brief = { ...brief, storePack: { ...pack, instances: slots } };
      }
    }
    const groupSize = identityGroupSize(brief, presets);
    const links = initialLinks(brief, presets);
    const created = await store.create({ title: body.title, brief: { ...brief, links } });
    const slug = created.slug;
    // Fix round 1 (M2): its side record exists from the start (nothing written into its creative.json later is trusted).
    await ctx.turns.side.read(ws.projectDir(req.params.slug), slug);
    const creative = linkedCodebases ? await store.update(slug, { linkedCodebases }) : created.creative;
    const ref = { root: ws.root, projectSlug: req.params.slug, projectDir: ws.projectDir(req.params.slug), creativeSlug: slug };
    // Phase 15: an identity creative with several concepts is a group of that many variants (the host is A), made here and
    // started like any grouped creative's first generation (`ctx.variantRuns`, the same orchestration as `…/variants/run`).
    if (groupSize > 1) {
      // Final wave M4 (as decisions log 847): the creative exists from here, so a group that cannot be made must not lose the
      // slug either: 201 with `groupError`, nothing started (addVariants leaves no sister behind); the canvas can add variants.
      try {
        await new VariantGroupService({ store, turns: ctx.turns }).addVariants(ref, Array.from({ length: groupSize - 1 }, () => ({ direction: null })), { hostDirection: null });
      } catch (err) {
        return reply.status(201).send({ slug, creative: await store.get(slug), job: null, groupError: err instanceof Error ? err.message : String(err) });
      }
      // The group exists from here: a start that throws must not lose the slug (the client opens the creative and can retry).
      let variantRun: Awaited<ReturnType<typeof ctx.variantRuns.run>> | null = null;
      let startError: string | null = null;
      if (body.generate) {
        try { variantRun = await ctx.variantRuns.run(ref, 'all-active', null); } catch (err) { startError = err instanceof Error ? err.message : String(err); }
      }
      return reply.status(201).send({ slug, creative: await store.get(slug), job: null, ...(variantRun ? { variantRun } : {}), ...(startError ? { startError } : {}) });
    }
    const job = body.generate ? await ctx.turns.start(ref) : null;
    return reply.status(201).send({ slug, creative: job ? await store.get(slug) : creative, job });
  });

  /**
   * The creative with its versions and per-format summary. Hashes missing in old versions are computed lazily within a
   * short budget (see withLazyHashes); when some outlive it, the clients are told once they are ready.
   */
  const detailOf = async (ref: CreativeRef & { store: CreativeStore }): Promise<CreativeDetail> => {
    const creative = await ref.store.get(ref.creativeSlug);
    const creativeDir = ref.store.dir(ref.creativeSlug);
    // Render records whose file changed since it was recorded are corrected first (render-stamps.ts).
    await reconcileRenders({ projectDir: ref.projectDir, store: ref.store, creativeSlug: ref.creativeSlug }).catch(() => false);
    const { versions } = await withLazyHashes({
      projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug),
      onBackgroundDone: () => ctx.broadcast?.({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug }),
    });
    return {
      // Phase 13: the queue and remembered session are kept by the core outside the project (final review I1).
      slug: ref.creativeSlug, creative: await ctx.turns.side.merged(ref.projectDir, ref.creativeSlug, creative), versions,
      jobKey: creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug),
      formats: await formatSummaries(creativeDir, creative, versions, (await catalog().load()).presets),
      ...await variantDetail(ref).then((variants) => (variants ? { variants } : {})),
    };
  };

  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c', async (req): Promise<CreativeDetail> =>
    detailOf(await refOf(req.params.slug, req.params.c)));

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/export-picks', async (req): Promise<CreativeDetail> => {
    const body = parse(pickBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await ctx.turns.setExportPick(ref, body.format, body.version);
    return detailOf(ref);
  });

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/links', async (req): Promise<CreativeDetail> => {
    const body = parse(linkBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await ctx.turns.setLink(ref, body.follower, body.primary);
    return detailOf(ref);
  });

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c', async (req) => {
    const body = parse(editBody, pruneLabelsOfRemovedFormats(req.body));
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.updateBrief(ref, body);
  });

  // Phase 15: variant groups (spec §2, §5). Every route but POST …/variants refuses a creative outside a group (409
  // `variant-no-group`) and writes nothing: an old creative is unchanged by them.
  /**
   * Creates sisters (ruling R3: no turn starts; Task 3's `…/variants/run` starts them). With no group yet, `count` is the size
   * of the group asked for, A included (2..5), and `directions[0]` is A's; on a group, `count` is how many variants to add
   * and `directions` are theirs. A missing or null direction is left for the directions turn. `baseFrom`: every new variant
   * starts from that member's version (decisions log 263).
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/variants', async (req, reply) => {
    const body = parse(addVariantsBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const svc = variantsOf(ref);
    const r = await svc.resolve(ref);
    if (r.orphan) throw new CodedError(409, t().errors.variantOrphan, 'variant-orphan');
    const directions = body.directions ?? [];
    const creating = r.group === null;
    const total = creating ? body.count ?? Math.max(2, directions.length) : null;
    const add = creating ? total! - 1 : body.count ?? Math.max(1, directions.length);
    if ((creating && total! < 2) || add < 1 || directions.length > (creating ? total! : add)) {
      throw new CodedError(400, t().errors.variantDirections, 'variant-directions');
    }
    const own = creating ? directions.slice(1) : directions;
    const specs = Array.from({ length: add }, (_, i) => ({ direction: own[i] ?? null, ...(body.baseFrom ? { baseFrom: body.baseFrom } : {}) }));
    await svc.addVariants(r.host, specs, creating ? { hostDirection: directions[0] ?? null } : {});
    return reply.status(201).send(await detailOf({ ...r.host, store: ref.store }));
  });

  const letterOf = (l: string): VariantLetter => {
    if (!(VARIANT_LETTERS as readonly string[]).includes(l)) throw new CodedError(404, t().errors.variantUnknown({ letter: l.slice(0, 2).toUpperCase() }), 'variant-unknown');
    return l as VariantLetter;
  };
  for (const action of ['discard', 'restore', 'use-for-all'] as const) {
    app.post<{ Params: { slug: string; c: string; l: string } }>(`/api/projects/:slug/creatives/:c/variants/:l/${action}`, async (req): Promise<CreativeDetail> => {
      const ref = await refOf(req.params.slug, req.params.c);
      const letter = letterOf(req.params.l);
      const svc = variantsOf(ref);
      if (action === 'discard') await svc.discard(ref, letter);
      else if (action === 'restore') await svc.restore(ref, letter);
      else await svc.useVariantForAll(ref, letter);
      return detailOf(ref);
    });
  }

  app.put<{ Params: { slug: string; c: string; formatId: string } }>('/api/projects/:slug/creatives/:c/variants/picks/:formatId', async (req): Promise<CreativeDetail> => {
    const pick = req.body === null || req.body === undefined ? null : parse(variantPickBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await variantsOf(ref).setPick(ref, req.params.formatId, pick);
    return detailOf(ref);
  });

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/variants/layout', async (req): Promise<CreativeDetail> => {
    const body = parse(layoutBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await variantsOf(ref).setLayout(ref, body.layout);
    return detailOf(ref);
  });

  app.put<{ Params: { slug: string; c: string; l: string } }>('/api/projects/:slug/creatives/:c/variants/:l/direction', async (req): Promise<CreativeDetail> => {
    const body = parse(directionBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await variantsOf(ref).setDirection(ref, letterOf(req.params.l), body.direction, 'user');
    return detailOf(ref);
  });

  /**
   * Phase 15 (ruling R3, spec §3, §4): starts `request` (or the first generation) in the target variants. The targets without
   * a direction get one from the directions turn first (none when every direction is typed); then each target gets a normal
   * creative turn, two at a time, and their paid services are confirmed on one card. Discarded variants are skipped.
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/variants/run', async (req, reply) => {
    const body = parse(variantRunBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const { store: _store, ...plain } = ref;
    return reply.status(202).send(await ctx.variantRuns.run(plain, body.targets, body.request));
  });

  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/conversation', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    await ref.store.get(ref.creativeSlug);
    return ref.store.readConversation(ref.creativeSlug);
  });

  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/turns', async (req, reply) => {
    const body = parse(turnBodySchema, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const text = body.text?.trim() ?? '';
    const pins = body.pins ?? [];
    const job = await ctx.turns.start(ref, text || pins.length ? { text, pins } : undefined, body.formats ? { formats: body.formats } : {});
    return reply.status(202).send(job);
  });

  // Phase 13 (spec §2): messages while the agent works, and the request queue (Rulings S and T).
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/messages', async (req) => {
    const body = parse(messageBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await ref.store.get(ref.creativeSlug); // 404 for unknown creatives
    return ctx.turns.postMessage(ref, { clientId: body.clientId, text: body.text, pins: body.pins ?? [], mode: body.mode });
  });

  app.delete<{ Params: { slug: string; c: string; clientId: string } }>('/api/projects/:slug/creatives/:c/queue/:clientId', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.removeQueued(ref, req.params.clientId);
  });

  app.put<{ Params: { slug: string; c: string; clientId: string } }>('/api/projects/:slug/creatives/:c/queue/:clientId', async (req) => {
    const body = parse(queueEditBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.editQueued(ref, req.params.clientId, { text: body.text, pins: body.pins ?? [] });
  });

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/queue', async (req) => {
    const body = parse(queueOrderBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.reorderQueue(ref, body.order);
  });

  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/queue/run-next', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return reply.status(202).send(await ctx.turns.runNext(ref));
  });

  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/restore', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.restore(ref, Number(req.params.n));
  });

  // Renders a v2 version's compositions (Task 5): one job per request, 202 with the job.
  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/render', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw new WorkspaceError(404, t().errors.versionNotFound);
    const body = parse(renderBody, req.body);
    // Residual fix (decisions log 866): a render writes the variant's outputs; a discarded one is read-only until restored.
    return reply.status(202).send(await ctx.turns.runLocked(ref, async () => {
      await ctx.turns.assertNotDiscarded(ref);
      return ctx.renders.start(ref, n, body.formats, { ...(body.locales ? { locales: body.locales } : {}), ...(body.force !== undefined ? { force: body.force } : {}) });
    }));
  });

  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/reveal', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const dir = Number.isInteger(n) && n > 0 ? ref.store.outputsDir(ref.creativeSlug, n) : null;
    // The agent can replace these folders: never open (or reveal) something a link points to outside the creative.
    const realFolder = async (p: string) => { const st = await lstat(p).catch(() => null); return Boolean(st && !st.isSymbolicLink() && st.isDirectory()); };
    const creativeDir = ref.store.dir(ref.creativeSlug);
    const ok = dir !== null && (await realFolder(dirname(dir))) && (await realFolder(dir))
      && isInsideDir(await realpath(dir).catch(() => ''), await realpath(creativeDir).catch(() => null));
    if (!ok) throw new WorkspaceError(404, t().errors.outputsFolderNotFound);
    await ctx.openPath(dir);
    return { ok: true };
  });

  app.post<{ Params: { slug: string; c: string; n: string }; Body: { destination?: unknown; formats?: unknown } }>('/api/projects/:slug/creatives/:c/versions/:n/export', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const version = (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === Number(req.params.n));
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    const destination = typeof req.body?.destination === 'string' ? expandHome(req.body.destination.trim()) : '';
    const rawFormats = req.body?.formats;
    if (rawFormats !== undefined && (!Array.isArray(rawFormats) || !rawFormats.length || !rawFormats.every((f) => typeof f === 'string'))) throw new WorkspaceError(400, t().export.invalidFormats);
    const creative = await ref.store.get(ref.creativeSlug);
    // Older clients: the phase 7 names (default pattern), whatever the workspace pattern.
    return exportVersion({ creativeDir: ref.store.dir(ref.creativeSlug), version, destination, slug: ref.creativeSlug, title: creative.title, formats: rawFormats as string[] | undefined,
      forbiddenRoot: ref.root, presets: (await catalog().load()).presets });
  });

  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/export', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const raw = (req.body ?? {}) as { destination?: unknown };
    if (typeof raw.destination !== 'string' || !raw.destination.trim() || raw.destination.length > 4096) {
      throw new CodedError(400, t().export.invalidDestination, 'export-invalid-destination');
    }
    const r = exportBody.safeParse(req.body);
    if (!r.success) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
    const body = r.data;
    if (body.pattern !== undefined && (typeof body.pattern !== 'string' || !body.pattern.trim() || body.pattern.length > 200)) {
      throw new CodedError(400, t().export.invalidPattern, 'export-invalid-pattern');
    }
    if (body.date !== undefined && !isExportDate(body.date)) throw new CodedError(400, t().export.invalidDate, 'export-invalid-date');
    const destination = expandHome(raw.destination.trim());
    const creative = await ref.store.get(ref.creativeSlug);
    const creativeDir = ref.store.dir(ref.creativeSlug);
    const presets = (await catalog().load()).presets;
    // The pattern sent (else the workspace's) and the date the client previewed (else today) apply to both payloads.
    // Languages (Phase 12): with extra languages the original's `{locale}` is the primary tag.
    const extraLocales = creative.brief.locales?.extra ?? [];
    const primaryLocale = extraLocales.length > 0 ? creative.brief.locales?.primary : undefined;
    // Ruling R: one naming rule for the dialog and this default. The workspace pattern as it is: the original's names stay
    // today's, and each translated file gets its language (`localizedStem`), exactly as the dialog sends and shows them.
    const pattern = typeof body.pattern === 'string' ? body.pattern : (await ctx.requireWorkspace().readSettings()).exportNamePattern;
    const tags = body.locales ? [...new Set(body.locales.map((x) => checkedLocale(x, currentLocale())))] : null;
    if (tags) assertLocalesInBrief(creative.brief, tags, currentLocale());
    // The brief's primary language is today's file, also for a creative whose extra languages were all removed.
    const briefPrimary = creative.brief.locales?.primary;
    const includeSource = tags === null || (briefPrimary !== undefined && tags.includes(briefPrimary));
    const otherTags = tags === null ? [] : tags.filter((x) => x !== briefPrimary);
    const common = { creativeDir, destination, slug: ref.creativeSlug, title: creative.title, forbiddenRoot: ref.root, presets, pattern,
      ...(typeof body.date === 'string' ? { now: body.date } : {}),
      label: (id: string) => formatDisplayName(presets, id, currentLocale(), creative.brief.formatLabels) };
    if (body.picks === undefined && body.follow === undefined && body.version !== undefined) {
      // The older single-version payload: every output of that version.
      const version = (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === body.version);
      if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
      return exportVersion({ ...common, version });
    }
    const resolve = async () => {
      // The same hashed versions as the creative GET, so a follower's ★ here is the one the dialog showed.
      await reconcileRenders({ projectDir: ref.projectDir, store: ref.store, creativeSlug: ref.creativeSlug }).catch(() => false);
      const { versions, complete } = await withLazyHashes({ projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug) });
      // A follower's version is decided on hashes: never on partial ones (a refusal now would only mean "not hashed yet").
      // The hashing goes on; the client retries after Retry-After, as for a ★ pick.
      if (!complete && body.follow !== undefined) throw new CodedError(503, t().errors.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
      const items = resolveExportPicks({ ...common, versions, picks: (body.picks ?? {}) as Record<string, number>, follow: body.follow as string[] | Record<string, number> | undefined,
        links: effectiveLinks(creative.brief.links, creative.brief.formats), storedPicks: creative.exportPicks });
      return { items, pending: await pendingRenders(creativeDir, versions, items) };
    };
    let { items, pending } = await resolve();
    // Task 5b: a v2 ★ with no current render is rendered first (a render job per version, its progress on the job list),
    // then the picks are resolved again on the new records and copied. Legacy versions export their media as they are.
    const rendered: Array<{ version: number; formats: string[] }> = [];
    if (pending.size > 0 && includeSource) {
      await notDiscarded(ref); // residual fix (decisions log 866): what is already rendered still exports
      await ctx.renders.renderAndWait(ref, pending);
      for (const [version, formats] of pending) rendered.push({ version, formats });
      ({ items, pending } = await resolve());
      if (pending.size > 0) {
        const list = [...pending].flatMap(([n, fs]) => fs.map((f) => `${common.label(f)} v${n}`)).join(', ');
        throw new CodedError(409, t().export.renderFailed({ list }), 'export-render-failed');
      }
    }
    // A render made just now for this export that has problems (I2) is not copied: the user has not seen them. It is
    // reported apart (`excluded`, with its problems and their codes: P2, never a silent exclusion); the dialog then shows
    // the problems and copies it once the row is ticked again.
    const problems: string[] = [];
    const excluded: Array<{ format: string; version: number; problems: string[]; issues: OutputIssue[]; locale?: string }> = [];
    if (rendered.length > 0) {
      const versions = await ref.store.readVersions(ref.creativeSlug);
      items = items.filter((it) => {
        if (!rendered.some((r) => r.version === it.n && r.formats.includes(it.format))) return true;
        const v = versions.find((x) => x.n === it.n);
        const list = v ? renderProblems(v, it.format) : [];
        if (!list.length) return true;
        problems.push(t().export.renderProblems({ item: `${common.label(it.format)} v${it.n}`, list: list.join('; ') }));
        excluded.push({ format: it.format, version: it.n, problems: list, issues: v?.outputs.find((o) => o.format === it.format)?.issues ?? [] });
        return false;
      });
      if (!items.length) throw new CodedError(409, t().export.renderProblemsOnly({ list: problems.join(', ') }), 'export-render-problems');
    }
    const localeRendered: Array<{ version: number; formats: string[]; locale: string }> = [];
    if (tags !== null || primaryLocale !== undefined) {
      const loc = await withLocales(ref, creativeDir, items, { includeSource, primaryLocale, otherTags, force: body.force === true, label: common.label });
      localeRendered.push(...loc.rendered);
      // Ruling J: a translation rendered now with problems is not copied either: reported in `excluded`, as the primary's (I2).
      items = loc.items.filter((it) => {
        if (!it.localized || !it.problems?.length || !loc.rendered.some((r) => r.version === it.n && r.locale === it.locale && r.formats.includes(it.format))) return true;
        problems.push(t().export.renderProblems({ item: `${common.label(it.format)} v${it.n} (${it.locale})`, list: it.problems.join('; ') }));
        excluded.push({ format: it.format, version: it.n, locale: it.locale!, problems: it.problems, issues: [] });
        return false;
      });
      if (!items.length) throw new CodedError(409, t().export.renderProblemsOnly({ list: problems.join(', ') }), 'export-render-problems');
    }
    const result = await exportResolved(items.map(({ problems: _p, ...it }) => it), common);
    const withProblems = excluded.length ? { ...result, excluded } : result;
    const allRendered = [...rendered, ...localeRendered];
    return allRendered.length > 0 ? { ...withProblems, rendered: allRendered } : withProblems;
  });

  /**
   * Phase 15 (spec §6): what a group export would copy, per format of the group: the member and version the group ★ (or the
   * default rule on variant A) names, with the file and its state. Any member of the group answers the same; 409 outside one.
   */
  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/export-group', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const plan = await planGroupExport(variantsOf(ref), ref.store, ref);
    return { items: plan.map(({ creativeDir: _dir, set: _set, ...p }) => p) };
  });

  /**
   * Phase 15 (spec §6): the group export. Each format is copied from the member and version of the group selection, named as
   * the host would name it (host title and slug, the file's own version: never a sister's `~x`). A selected composition with no
   * render is rendered first, in its own member. A file that is missing, a render that failed or has problems, or (with
   * languages) a translation that cannot be rendered is NOT an error: it is left out and listed in `unavailable`, translated.
   * Translations stay inside their variant: for each format, the localized renders of the member the selection picked, at that
   * version. A translation without a current render is rendered first in that member, as a single creative's export does
   * (decisions log 854, revised): 409 `localization-needs-force` without `force` when one has open problems or outdated
   * entries, and one rendered now with problems is left out and listed (Ruling J).
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/export-group', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const raw = (req.body ?? {}) as { destination?: unknown };
    if (typeof raw.destination !== 'string' || !raw.destination.trim() || raw.destination.length > 4096) {
      throw new CodedError(400, t().export.invalidDestination, 'export-invalid-destination');
    }
    const r = exportGroupBody.safeParse(req.body);
    if (!r.success) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
    const body = r.data;
    if (body.pattern !== undefined && (typeof body.pattern !== 'string' || !body.pattern.trim() || body.pattern.length > 200)) {
      throw new CodedError(400, t().export.invalidPattern, 'export-invalid-pattern');
    }
    if (body.date !== undefined && !isExportDate(body.date)) throw new CodedError(400, t().export.invalidDate, 'export-invalid-date');
    const svc = variantsOf(ref);
    const hostRef = (await svc.resolve(ref)).host;
    const host = await ref.store.get(hostRef.creativeSlug);
    const presets = (await catalog().load()).presets;
    const label = (id: string) => formatDisplayName(presets, id, currentLocale(), host.brief.formatLabels);
    const extraLocales = host.brief.locales?.extra ?? [];
    const primaryLocale = extraLocales.length > 0 ? host.brief.locales?.primary : undefined;
    const pattern = typeof body.pattern === 'string' ? body.pattern : (await ctx.requireWorkspace().readSettings()).exportNamePattern;
    const tags = body.locales ? [...new Set(body.locales.map((x) => checkedLocale(x, currentLocale())))] : null;
    if (tags) assertLocalesInBrief(host.brief, tags, currentLocale());
    const briefPrimary = host.brief.locales?.primary;
    const includeSource = tags === null || (briefPrimary !== undefined && tags.includes(briefPrimary));
    const otherTags = tags === null ? [] : tags.filter((x) => x !== briefPrimary);
    const common = { creativeDir: ref.store.dir(hostRef.creativeSlug), destination: expandHome(raw.destination.trim()), slug: hostRef.creativeSlug, title: host.title,
      forbiddenRoot: ref.root, presets, pattern, ...(typeof body.date === 'string' ? { now: body.date } : {}), label };

    const only = body.formats ? new Set(body.formats) : null;
    const planOf = async () => (await planGroupExport(svc, ref.store, ref)).filter((p) => !only || only.has(p.format));
    let plan = await planOf();
    const key = (p: Pick<GroupPlanItem, 'slug' | 'format' | 'version'>) => `${p.slug}\0${p.format}\0${p.version}`;
    const withProblems = new Map<string, string[]>();
    const renderErrors = new Map<string, string>();
    const pending = plan.filter((p) => p.state === 'needs-render');
    if (includeSource && pending.length > 0) {
      // One render job per member and version, in the member's own folder; a render that cannot run leaves its formats out,
      // with the job's own error (as the pack route reports it).
      for (const [slug, versions] of pendingByMember(pending)) {
        const error = await ctx.renders.renderAndWait({ ...ref, creativeSlug: slug }, versions)
          .then((jobs) => jobs.find((j) => j.state === 'failed')?.error ?? null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
        if (error) for (const [version, formats] of versions) for (const format of formats) renderErrors.set(key({ slug, format, version }), error);
      }
      const renderedNow = new Set(pending.map(key));
      plan = await planOf();
      // A render made now with problems is not copied (the user has not seen it), as for a single creative.
      for (const p of plan) {
        if (p.state !== 'ready' || !renderedNow.has(key(p))) continue;
        const v = (await ref.store.readVersions(p.slug)).find((x) => x.n === p.version);
        const list = v ? renderProblems(v, p.format) : [];
        if (list.length > 0) withProblems.set(key(p), list);
      }
    }
    const usable = plan.map((p) => (withProblems.has(key(p)) ? { ...p, state: 'missing' as const } : p));
    const g = t().export.groupReason;
    const reason = (p: GroupPlanItem) => {
      const problems = withProblems.get(key(p));
      if (problems) return g.renderProblems({ list: problems.join('; ') });
      const error = renderErrors.get(key(p));
      if (p.state === 'needs-render') return error ? g.renderFailed({ reason: error }) : g.notRendered;
      return g.missing;
    };
    type Gap = { format: string; slug: string; letter: VariantLetter; version: number; locale?: string; message: string };
    const gap = (p: GroupPlanItem, why: string, locale?: string): Gap => ({ format: p.format, slug: p.slug, letter: p.letter, version: p.version, ...(locale !== undefined ? { locale } : {}),
      message: t().export.groupSkipped({ format: locale !== undefined ? `${label(p.format)} (${locale})` : label(p.format), variant: p.letter.toUpperCase(), n: p.version, reason: why }) });
    const unavailable: Gap[] = (includeSource ? usable.filter((p) => p.state !== 'ready') : []).map((p) => gap(p, reason(p)));
    const items: ExportItem[] = includeSource
      ? usable.filter((p) => p.state === 'ready').map((p) => (primaryLocale !== undefined ? { ...itemOfPlan(p), locale: primaryLocale } : itemOfPlan(p)))
      : [];
    if (otherTags.length > 0) {
      const checks = {
        matches: (slug: string, n: number, file: string, sha: string) => renderFileMatches(ref.projectDir, ref.store.dir(slug), slug, n, file, sha),
        assetsOk: (slug: string, n: number, row: LocalizationRow) => localeAssetsCheck(ref.projectDir, ref.store.dir(slug))(n, row),
      };
      // A source left out above (render problems) has no translation exported either; a languages-only export resolves every
      // item, a composition without its primary render included (as the single export does).
      const locPlan = usable.filter((p) => !withProblems.has(key(p)));
      let loc = await resolveGroupLocalized(locPlan, ref.store, otherTags, checks);
      // Decision 854 (superseded part) and the orchestrator's ruling: a translation without a current render is rendered now,
      // in its own member, exactly like a single creative's export; `localization-needs-force` asks "Renderizza comunque".
      const done = await renderGroupLocales(ctx.renders, ref, loc.pending, body.force === true, (list) => messages(currentLocale()).variants.renderNeedsForce({ list }));
      if (loc.pending.length > 0) loc = await resolveGroupLocalized(locPlan, ref.store, otherTags, checks);
      const renderedNow = (it: ExportItem, slug: string) => done.rendered.some((r) => r.slug === slug && r.version === it.n && r.locale === it.locale && r.formats.includes(it.format));
      for (const it of loc.items) {
        const p = locPlan.find((x) => x.format === it.format)!;
        // Ruling J: a translation rendered now with problems is not copied either: listed, with its problems.
        if (it.problems?.length && renderedNow(it, p.slug)) { unavailable.push(gap(p, g.renderProblems({ list: it.problems.join('; ') }), it.locale)); continue; }
        const { problems: _p, ...clean } = it;
        items.push(clean);
      }
      for (const u of loc.unavailable) {
        const error = done.errors.get(`${u.plan.slug}\0${u.locale}`);
        const why = u.state === 'no-translation' ? g.noTranslation({ locale: u.locale })
          : u.state === 'missing' ? reason(u.plan)
          : error ? g.renderFailed({ reason: error }) : g.notRendered;
        unavailable.push(gap(u.plan, why, u.locale));
      }
    }
    const result = await exportGroup(usable, common, items);
    const { unavailable: _plan, ...copied } = result;
    return { ...copied, unavailable };
  });

  /**
   * The export items with their languages (Phase 12, spec §3.5): the primary-language files (when exported) carry the primary
   * tag, and each other language adds the translated renders of the same formats and versions. A translation without a
   * current render is rendered first (409 `localization-needs-force` when it has open problems or outdated entries and
   * `force` is not set: the dialog asks "render anyway"); a format with no translation is refused (409 `localization-missing`).
   */
  /**
   * Residual fix (decisions log 866): a render made now writes the creative's outputs, so a discarded variant refuses it
   * (409 `variant-discarded`), checked under its lock like its other writes; exporting what is already rendered is a read.
   */
  function notDiscarded(ref: CreativeRef): Promise<void> {
    return ctx.turns.runLocked(ref, () => ctx.turns.assertNotDiscarded(ref));
  }

  async function withLocales(ref: CreativeRef & { store: CreativeStore }, creativeDir: string, items: ExportItem[],
    o: { includeSource: boolean; primaryLocale: string | undefined; otherTags: string[]; force: boolean; label: (id: string) => string }):
    Promise<{ items: ExportItem[]; rendered: Array<{ version: number; formats: string[]; locale: string }> }> {
    const source = o.includeSource ? items.map((it) => (o.primaryLocale !== undefined ? { ...it, locale: o.primaryLocale } : it)) : [];
    const rendered: Array<{ version: number; formats: string[]; locale: string }> = [];
    if (o.otherTags.length === 0) return { items: source, rendered };
    const v = messages(currentLocale()).variants;
    const matches = (n: number, file: string, sha: string) => renderFileMatches(ref.projectDir, creativeDir, ref.creativeSlug, n, file, sha);
    const assets = localeAssetsCheck(ref.projectDir, creativeDir);
    let r = await resolveLocalizedItems(creativeDir, await ref.store.readVersions(ref.creativeSlug), items, o.otherTags, matches, assets);
    const refuseMissing = () => {
      if (r.missing.length === 0) return;
      const list = r.missing.map((x) => `${o.label(x.format)} v${x.n} (${x.locale})`);
      const err = new CodedError(409, v.localizationMissing({ list: list.slice(0, 10).join(', ') }), 'localization-missing');
      err.problems = list.slice(0, 50);
      throw err;
    };
    refuseMissing();
    if (r.pending.size > 0) {
      await notDiscarded(ref);
      for (const [n, p] of r.pending) {
        await ctx.renders.renderLocalesAndWait(ref, n, p.formats, p.locales, o.force);
        for (const locale of p.locales) rendered.push({ version: n, formats: [...p.formats], locale });
      }
      r = await resolveLocalizedItems(creativeDir, await ref.store.readVersions(ref.creativeSlug), items, o.otherTags, matches, assets);
      refuseMissing();
      if (r.pending.size > 0) {
        const list = [...r.pending].flatMap(([n, p]) => p.formats.map((f) => `${o.label(f)} v${n}`)).join(', ');
        throw new CodedError(409, t().export.renderFailed({ list }), 'export-render-failed');
      }
    }
    return { items: [...source, ...r.items], rendered };
  }

  /**
   * What a ★ export would have to render first (Task 5b), started now: the web shows "Rendering 2 formats first…" with the
   * jobs' progress, then calls the export. `renders`: one job per version (an active one is reused); empty: nothing to render.
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/export/prepare', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const r = exportBody.safeParse(req.body ?? {});
    if (!r.success || (r.data.picks === undefined && r.data.follow === undefined)) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
    const creative = await ref.store.get(ref.creativeSlug);
    const creativeDir = ref.store.dir(ref.creativeSlug);
    const presetsForLabels = r.data.locales ? (await catalog().load()).presets : [];
    await reconcileRenders({ projectDir: ref.projectDir, store: ref.store, creativeSlug: ref.creativeSlug }).catch(() => false);
    const { versions, complete } = await withLazyHashes({ projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug) });
    // As for the export: a follower's version is never decided on partial hashes.
    if (!complete && r.data.follow !== undefined) throw new CodedError(503, t().errors.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
    const items = resolveExportPicks({ creativeDir, destination: '/', slug: ref.creativeSlug, versions, picks: (r.data.picks ?? {}) as Record<string, number>,
      follow: r.data.follow as string[] | Record<string, number> | undefined, links: effectiveLinks(creative.brief.links, creative.brief.formats), storedPicks: creative.exportPicks });
    // Languages (Phase 12): the primary one is today's file; the others' translations without a current render are started too.
    const briefPrimary = creative.brief.locales?.primary;
    const tags = r.data.locales ? [...new Set(r.data.locales.map((x) => checkedLocale(x, currentLocale())))] : null;
    if (tags) assertLocalesInBrief(creative.brief, tags, currentLocale());
    const includeSource = tags === null || (briefPrimary !== undefined && tags.includes(briefPrimary));
    const otherTags = tags === null ? [] : tags.filter((x) => x !== briefPrimary);
    const pending = includeSource ? await pendingRenders(creativeDir, versions, items) : new Map<number, string[]>();
    if (pending.size > 0) await notDiscarded(ref); // residual fix (decisions log 866)
    const renders: Array<{ version: number; formats: string[]; job: JobSummary; covers: boolean; locales?: string[] }> = [];
    // Answers at once: an active job of that version is reused for the formats it covers and a follow-up job is queued for
    // the rest (I3), so the job returned covers them all.
    for (const [version, formats] of pending) {
      const { job, covers } = await ctx.renders.ensureJob(ref, version, formats, { wait: false });
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
      if (loc.pending.size > 0) await notDiscarded(ref);
      for (const [version, p] of loc.pending) {
        const job = await ctx.renders.start(ref, version, p.formats, { locales: p.locales, force: r.data.force === true });
        renders.push({ version, formats: p.formats, job, covers: true, locales: p.locales });
      }
    }
    return { renders };
  });

  /**
   * A live preview session of one format of a saved v2 version (Task 5b; the web's player and Compare, Task 8). Behind the UI
   * token like every API; `parentOrigin` must be one of the UI origins (403 `preview-origin`); the media is normalised first.
   */
  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/preview-session', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const version = Number.isInteger(n) && n > 0 ? (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    const body = parse(previewBody, req.body);
    return ctx.previews.mintPreview({ projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug, n }, version, body.format, body.parentOrigin, currentLocale(),
      body.renewFrom !== undefined ? { renewFrom: body.renewFrom } : {});
  });

  /**
   * Ends a live preview session of this creative's version n early (Task 8 fix I2): the web releases hover previews it no
   * longer shows, so they never count against the live sessions cap (MAX_PREVIEW_SESSIONS) of a player still in use.
   * Behind the UI token; a session of another creative or version is not touched (404 either way, nothing to learn).
   */
  app.delete<{ Params: { slug: string; c: string; n: string; token: string } }>('/api/projects/:slug/creatives/:c/versions/:n/preview-session/:token', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    if (n < 1 || !/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) throw new WorkspaceError(404, t().errors.previewSessionNotFound);
    if (!ctx.previews.revokePreview({ creativeDir: ref.store.dir(ref.creativeSlug), n }, req.params.token)) throw new WorkspaceError(404, t().errors.previewSessionNotFound);
    return { revoked: true };
  });

  /**
   * The editor's view of one format of a saved v2 version (Phase 10b): the primary's composition (a follower's is its
   * primary's, `primaryFormat`), its files and the fonts offered. 404 for a legacy version or a format it lacks.
   */
  app.get<{ Params: { slug: string; c: string; n: string; format: string }; Querystring: { locale?: string } }>('/api/projects/:slug/creatives/:c/versions/:n/compositions/:format', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    const version = n > 0 ? (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    // `?locale=xx` (Phase 12): the localized composition for the preview, with the language's stale ids and problems.
    if (req.query.locale !== undefined) {
      return localizedCompositionView({ projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), version, format: req.params.format,
        rawLocale: req.query.locale, presets: (await catalog().load()).presets, locale: currentLocale() });
    }
    return editorCompositionView({
      projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), version, format: req.params.format,
      presets: (await catalog().load()).presets, locale: currentLocale(),
    });
  });

  /**
   * Stages a library asset or a brand font for a draft (Phase 10b): copied, confined, into the staging folder of the live
   * preview session `token` of this creative, and served under that token. An upload goes through the library's own route
   * first, then is staged from the library. An SVG edited in the editor (`svgEdit`) is checked and written there instead
   * (`stageSvgEdit`): 400 `svg-edit-refused` / `svg-edit-bad-base`, 409 `variant-discarded`.
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/editor/stage', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(stageBody, req.body);
    // An edited SVG is a write the draft makes: a discarded variant (phase 15) is read-only until restored, as for a save.
    if (body.from.kind === 'svgEdit') await ctx.turns.assertNotDiscarded(ref);
    return ctx.previews.stage({ projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug }, body.token, body.from, currentLocale());
  });

  /**
   * Saves an editor draft as a new version (Phase 10b, `DirectEditService.save`): no agent, no tokens. 409 `editor-busy`
   * while a turn or a render runs, 409 `editor-base-changed` when the format moved on, 422 `editor-invalid` with the
   * translated `problems`. The body holds a whole composition: up to its own 5 MB limit, plus up to 20 000 ops (12 MB in all).
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/edits', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(directEditBodySchema, req.body);
    return ctx.edits.save({ root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: ref.creativeSlug }, body, currentLocale());
  });

  /**
   * Duplicate format (Phase 12, `DirectEditService.duplicate`): `{ instanceId, label? }` → `{ version, instanceId }`, a new
   * editor version with a copy of that instance's composition of version n as the next instance of its preset. 409 while a
   * turn or a render runs, when 20 instances exist or the source is not in version n.
   */
  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/duplicate-format', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    if (n < 1) throw new CodedError(404, t().errors.versionNotFound, 'version-not-found');
    return ctx.edits.duplicate({ root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: ref.creativeSlug }, n, req.body, currentLocale());
  });

  /**
   * The storyboard of one format of a saved v2 version (scene starts and the poster), made now when missing or stale.
   * 404 `storyboard-unavailable` when it cannot be made (no renderer, an invalid composition).
   */
  app.get<{ Params: { slug: string; c: string; n: string; format: string } }>('/api/projects/:slug/creatives/:c/versions/:n/storyboards/:format', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const version = Number.isInteger(n) && n > 0 ? (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    const r = await ctx.previews.storyboardOf({ projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug, n }, version, req.params.format);
    if (!r) throw new CodedError(404, t().errors.previewUnavailable, 'storyboard-unavailable');
    // Signed, short-lived image URLs (fix I4), content-addressed by the composition hash (a regenerated storyboard of other
    // content never reuses a URL). The UI asks again before `expiresAt` for fresh ones.
    const base = `/api/projects/${encodeURIComponent(req.params.slug)}/creatives/${encodeURIComponent(ref.creativeSlug)}/storyboard-files/${n}/${r.folder}/${r.storyboard.hash.slice(0, 16)}`;
    let expiresAt = 0;
    const frames = r.storyboard.frames.map(({ file, ...f }) => { const s = ctx.signer.sign(`${base}/${file}`); expiresAt = s.expiresAt; return { ...f, url: s.url }; });
    return { format: r.folder, hash: r.storyboard.hash, width: r.storyboard.width, expiresAt: new Date(expiresAt).toISOString(), frames };
  });

  // Storyboard images, shown by <img>: no UI token, but a signed URL from the route above (fix I4); only `f-<i>.jpg` of the
  // storyboard whose composition hash starts with `:hash`.
  app.get<{ Params: { slug: string; c: string; n: string; folder: string; hash: string; file: string }; Querystring: { s?: string } }>('/api/projects/:slug/creatives/:c/storyboard-files/:n/:folder/:hash/:file', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!ctx.signer.verify(path, req.query.s)) return reply.status(403).send({ error: t().errors.fileNotFoundShort });
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const notFound = () => reply.status(404).send({ error: t().errors.fileNotFoundShort });
    if (!Number.isInteger(n) || n < 1 || !FOLDER_RE.test(req.params.folder) || !/^[0-9a-f]{16}$/.test(req.params.hash) || !FRAME_FILE_RE.test(req.params.file)) return notFound();
    const sb = await readJsonFile(join(storyboardDir(ref.projectDir, ref.creativeSlug, n, req.params.folder), 'storyboard.json'), storyboardSchema).catch(() => null);
    if (!sb || !sb.hash.startsWith(req.params.hash)) return notFound();
    return sendConfinedFile(reply, storyboardDir(ref.projectDir, ref.creativeSlug, n, req.params.folder), req.params.file, ['f-']);
  });

  /**
   * The feedback frames of the comments sent with the turn that made version n (Task 8, carry 9), from the protected core
   * cache `.studio/cache/pin-frames/<creative>/v<n>/` (creative-turns `extractPinFrames`, fix I1): `<n>-<i>.jpg` for the
   * i-th pin of that message (and `<n>-<i>e.jpg`, the end frame of a range pin), as short-lived signed URLs like the storyboards'. The folder is read only through real
   * directories (a link anywhere in the chain gives an empty list) and is never created here.
   */
  const pinFramesRel = (creativeSlug: string, n: number) => ['.studio', 'cache', 'pin-frames', creativeSlug, `v${n}`];
  app.get<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/pin-frames/:n', async (req): Promise<PinFramesView> => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    if (n < 1) throw new WorkspaceError(404, t().errors.versionNotFound);
    const rel = pinFramesRel(ref.creativeSlug, n);
    if ((await isRealDirChain(ref.projectDir, rel)) !== 'ok') return { n, expiresAt: null, frames: [] };
    const dir = join(ref.projectDir, ...rel);
    const names: Array<{ file: string; i: number; end: number }> = [];
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const m = PIN_FRAME_RE.exec(file);
      if (!m || Number(m[1]) !== n) continue;
      const st = await lstat(join(dir, file)).catch(() => null);
      if (st?.isFile() && st.nlink === 1) names.push({ file, i: Number(m[2]), end: m[3] ? 1 : 0 });
    }
    names.sort((a, b) => a.i - b.i || a.end - b.end);
    const base = `/api/projects/${encodeURIComponent(req.params.slug)}/creatives/${encodeURIComponent(ref.creativeSlug)}/pin-frame-files/${n}`;
    let expiresAt: number | null = null;
    const frames = names.map(({ file }) => { const s = ctx.signer.sign(`${base}/${file}`); expiresAt = s.expiresAt; return { file, url: s.url }; });
    return { n, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), frames };
  });

  // The pin frame images, shown by <img>: no UI token, but a signed URL from the route above; only `<n>-<i>.jpg` of v<n>.
  app.get<{ Params: { slug: string; c: string; n: string; file: string }; Querystring: { s?: string } }>('/api/projects/:slug/creatives/:c/pin-frame-files/:n/:file', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!ctx.signer.verify(path, req.query.s)) return reply.status(403).send({ error: t().errors.fileNotFoundShort });
    const ref = await refOf(req.params.slug, req.params.c);
    const notFound = () => reply.status(404).send({ error: t().errors.fileNotFoundShort });
    const m = PIN_FRAME_RE.exec(req.params.file);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    if (!m || n < 1 || Number(m[1]) !== n) return notFound();
    const rel = pinFramesRel(ref.creativeSlug, n);
    if ((await isRealDirChain(ref.projectDir, rel)) !== 'ok') return notFound();
    return sendConfinedFile(reply, join(ref.projectDir, ...rel), req.params.file, [`${n}-`]);
  });

  /**
   * "Use as brand logo" (Phase 14, decision 733): copies the SVG an identity format's render checked into `assets/brand/` and
   * adds it to the brand kit. The file is read again from the version's set folder (confined, no links) and checked again
   * with `checkVectorSvg`, so only an SVG that passes now is ever copied. Stable codes: `bad-variant`, `not-identity`,
   * `logo-not-checked` (no render, or a set without an SVG), `logo-missing`, `logo-refused`.
   */
  app.post<{ Params: { slug: string; c: string; n: string; f: string } }>('/api/projects/:slug/creatives/:c/versions/:n/formats/:f/use-as-brand-logo', async (req) => {
    const e = t().errors;
    const ref = await refOf(req.params.slug, req.params.c);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    if (n < 1) throw new CodedError(404, e.versionNotFound, 'version-not-found');
    const body = useAsLogoBody.safeParse(req.body);
    if (!body.success) throw new CodedError(400, e.useAsLogoBadVariant, 'bad-variant');
    const format = req.params.f;
    if (!INSTANCE_ID_RE.test(format)) throw new CodedError(400, e.invalidRequest, 'bad-format');
    const version = (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new CodedError(404, e.versionNotFound, 'version-not-found');
    const out = version.outputs.find((o) => o.format === format);
    const set = out?.identitySet;
    const svgEntry = set?.files.find((f) => f.role === 'vector' && f.path.toLowerCase().endsWith('.svg'));
    const preset = findPreset(await catalog().load().then((c) => c.presets).catch(() => []), format.replace(/@\d+$/, ''));
    if (!preset?.identity) throw new CodedError(409, e.useAsLogoNotIdentity, 'not-identity');
    if (!out || !set || !svgEntry) throw new CodedError(409, set ? e.useAsLogoNoSvg : e.useAsLogoNotChecked, set ? 'logo-no-svg' : 'logo-not-checked');
    // Confinement: `set.dir` and the file's path are plain relative segments (no `..`, `.`, empty, backslash or control
    // character); every folder from the creative down to the file's folder is a real folder (no link: `isRealDirChain`);
    // the file is opened without following a link, must be a regular single-linked file, and its real path must be exactly
    // `<real set folder>/<path>` (`readConfinedFile` in exact mode).
    const plain = (p: string) => p.split('/').every((x) => x !== '' && x !== '.' && x !== '..' && !/[\\\u0000-\u001f\u007f]/.test(x));
    if (!plain(set.dir) || !plain(svgEntry.path)) throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
    const fileParts = svgEntry.path.split('/');
    const fileName = fileParts.pop()!;
    const dirParts = ['outputs', `v${n}`, ...set.dir.split('/'), ...fileParts];
    const creativeDir = ref.store.dir(ref.creativeSlug);
    const chain = await isRealDirChain(creativeDir, dirParts);
    if (chain === 'missing') throw new CodedError(404, e.useAsLogoMissing, 'logo-missing');
    if (chain === 'unsafe') throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
    const read = await readConfinedFile(join(creativeDir, ...dirParts), fileName, MAX_VECTOR_SVG_BYTES, true).catch(() => ({ skipped: 'outside' as const }));
    if (read === null) throw new CodedError(404, e.useAsLogoMissing, 'logo-missing');
    if ('skipped' in read) throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
    if (!checkVectorSvg(read.text).ok) throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');

    const name = `${ref.creativeSlug}-v${n}-${format.replace(/[^a-z0-9]+/gi, '-')}.svg`;
    const file = `assets/${await saveGeneratedFile(ref.projectDir, 'brand', name, Buffer.from(read.text, 'utf8'))}`;
    const source = { kind: 'manual' as const, ref: `creative:${ref.creativeSlug}/v${n}` };
    const library = new LibraryStore(ref.projectDir, ctx.media);
    const store = new BrandStore(ref.projectDir);
    let logoId = '';
    /** The logos this call demoted (ids): put back if the registration fails below. */
    let demotedIds: string[] = [];
    const undo = <L extends { id: string }>(logos: L[]): L[] => logos.map((l) => (demotedIds.includes(l.id) ? { ...l, variant: body.data.variant } : l));
    try {
      await store.updateReadableKit((kit) => {
        demotedIds = kit.logos.filter((l) => l.variant === body.data.variant).map((l) => l.id);
        const taken = new Set(kit.logos.map((l) => l.id));
        const stem = `logo-${ref.creativeSlug}-v${n}`.slice(0, 56).replace(/-+$/, '');
        let id = stem;
        for (let k = 2; taken.has(id); k++) id = `${stem}-${k}`;
        logoId = id;
        // Decision 784: the new logo takes the chosen variant; one already holding it steps down (primary → secondary,
        // icon → other), so the kit never has two primary logos or two icons.
        const demoted = body.data.variant === 'primary' ? 'secondary' as const : 'other' as const;
        const logos = kit.logos.map((l) => (l.variant === body.data.variant ? { ...l, variant: demoted } : l));
        return { ...kit, logos: [...logos, { id, file, variant: body.data.variant, background: 'any', source }] };
      });
    } catch (err) {
      // The kit refused (full, unreadable): nothing is left half done, the copy goes.
      await rm(join(ref.projectDir, ...file.split('/')), { force: true }).catch(() => {});
      throw err;
    }
    try {
      await library.registerAssets([{ file: file.slice('assets/'.length), origin: 'generated', sourceUrl: null, description: '', tags: ['brand', 'logo'] }]);
    } catch (err) {
      await store.updateReadableKit((kit) => ({ ...kit, logos: undo(kit.logos.filter((l) => l.id !== logoId)) })).catch(() => {});
      await rm(join(ref.projectDir, ...file.split('/')), { force: true }).catch(() => {});
      throw err;
    }
    // The kit and the file are written either way; a commit that fails is reported, not undone (the next kit change commits it).
    let committed = true;
    if (ctx.git) committed = await ctx.git.commitAll(ref.projectDir, t().jobs.brandKitCommit).then(() => true, () => false);
    ctx.broadcast?.({ type: 'library', project: ref.projectSlug });
    ctx.broadcast?.({ type: 'brand', project: ref.projectSlug });
    return { file, variant: body.data.variant, committed };
  });

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return sendConfinedFile(reply, ref.store.dir(ref.creativeSlug), req.params['*'] ?? '', ['outputs/', 'work/.feedback/']);
  });
}
