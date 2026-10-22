import type { Git } from '../git.ts';
import { recoverRenameJournal } from '../library/rename-recovery.ts';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_EXPORT_QUALITY, EXPORT_FPS, EXPORT_QUALITIES, isDefaultProfile, EXPORT_RESOLUTIONS, type ExportFps, type ExportQuality, type RenderProfile, type VersionEntry, messages, type JobSummary, INSTANCE_FOLDER_RE, INSTANCE_ID_RE, briefSchema, briefWriteSchema, presetOf, storePackFormats, storePackSchema, type PinFramesView, checkLink, defaultLinks, effectiveLinks, formatDisplayName, isExportDate, issuesText, renderProblems, linkedCodebaseSchema, pinSchema, type Brief, type Composition, type CreativeDetail, type OutputIssue, type FormatPreset, type RecentCreative, type ServerMessage, type LocalizationRow, activeMembers, hostOf, isVariantId, letterOfSlug, MAX_NEW_VARIANTS, variantIdSchema, type VariantDetail, type VariantId, type SubtitleSet, type LocaleTag, briefSessionRefSchema, singleAgentOn, subtitleHashesOf, videoAnalysisJobKey } from '@motion-studio/shared';
import { z } from 'zod';
import { brandJobKey } from '../brand/brand-analysis.ts';
import type { BriefClaim, BriefSessionService } from '../brief/brief-session.ts';
import { assertCodebasesOutside, normalizeCodebaseList } from '../codebases.ts';
import { briefFilePaths, CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeSideStateStore, StoppedSession } from '../creatives/creative-side-state.ts';
import { checkDestination, exportResolved, exportVersion, pendingRenders, profiledRenders, resolveExportPicks, resolveLocalizedItems, type ExportItem, type ExportResult } from '../creatives/export.ts';
import { makeOwnedTempDir } from '../render/owner.ts';
import type { ExportJobService, ExportOutcome, ExportRun } from '../creatives/export-jobs.ts';
import type { ExportRendered, ExportRenderOptions, RenderWait } from '../creatives/render-jobs.ts';
import { planSubtitleExport, remuxSoft, skipsVersionRender, type SubtitleChoice, type SubtitleEntry } from '../creatives/subtitle-export.ts';
import { findFfmpeg } from '../render/encode.ts';
import { RenderError } from '../render/errors.ts';
import { assertLocalesInBrief, checkedLocale } from '../localization/validate.ts';
import { storyboardDir, storyboardKey, storyboardSchema, sweepStoryboardTemps, workVersion, type PreviewService } from '../creatives/previews.ts';
import { readJsonFile } from '../json-file.ts';
import { isRealDirChain } from '../creatives/core-files.ts';
import type { UrlSigner } from './signed-urls.ts';
import { formatSummaries } from '../creatives/format-summary.ts';
import { MAX_DIRECTION_CHARS, VariantGroupService } from '../creatives/variant-group.ts';
import { localeAssetsCheck, prepareExportRenders } from '../creatives/export-prepare.ts';
import { exportGroup, itemOfPlan, pendingByMember, planGroupExport, renderGroupLocales, resolveGroupLocalized, withGroupProfile, type GroupPlanItem } from '../creatives/variant-export.ts';
import type { VariantFanout } from '../creatives/variant-fanout.ts';
import { groupJobKey, recoverGroupTurns, type GroupTurnService } from '../creatives/group-turn.ts';
import { withLazyHashes } from '../creatives/output-hashes.ts';
import { claimCreativeReferences, sweepCreativeReferences } from '../library/creative-references.ts';
import { CreativeRemoval } from '../creatives/creative-removal.ts';
import type { TrashFn } from '../trash.ts';
import { creativeJobKey, PICK_RETRY_AFTER_SEC, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import type { RenderJobService } from '../creatives/render-jobs.ts';
import { tmpdir } from 'node:os';
import { reconcileRenders, renderFileMatches } from '../creatives/render-stamps.ts';
import { sweepAnalysisFrames, sweepDerivedCaches, sweepEditorStaging } from '../creatives/cache-sweep.ts';
import { editorCompositionView } from '../creatives/editor-staging.ts';
import { directEditBodySchema, type DirectEditService } from '../creatives/direct-edit.ts';
import { sweepProjectRenders } from '../render/render-sweep.ts';
import { assertFormatsOffered, FormatCatalog, findPreset } from '../formats/format-catalog.ts';
import { addCustomFormat, customFormatUsage, deleteCustomFormat, editCustomFormat } from '../formats/custom-formats.ts';
import { mergeStorePack, verifyScreens } from '../store-pack/brief.ts';
import { NoMediaTools, type MediaTools } from '../media/media-tools.ts';
import { completeGitignore, sweepProject } from '../project-maintenance.ts';
import { CodedError, expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';
import { localizedCompositionView } from './localization-routes.ts';
import { subtitleSummaries, subtitleTimingNow } from './subtitles-routes.ts';
import { defaultSubtitleLang, readSubtitleSet, stageDefaultSubtitles, subtitleHashes } from '../subtitles/store.ts';
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
  /** Export jobs (decision 974): an export that runs in the background. */
  exports: ExportJobService;
  /** Storyboards and live preview sessions (Task 5b). */
  previews: PreviewService;
  /** Signs the storyboard image URLs (fix I4). */
  signer: UrlSigner;
  /** Commits the brand kit change of "Use as brand logo" (Phase 14); absent: the change is written and not committed. */
  git?: Git;
  /** Phase 15: starts variants (`POST …/variants/run`): directions turn, then the fan-out. */
  variantRuns: VariantFanout;
  /** Phase 3 of the single agent: a variant group's turns with one agent (absent: the per-variant turns of phase 15). */
  groups?: GroupTurnService;
  /** Decision 915: the job queue now (archive and delete are refused while a job of the creative is queued or running). */
  jobs: () => JobSummary[];
  /** Decision 1423: the brief sessions (Genera / Salva bozza carry one into the new creative). Absent: no handoff. */
  briefs?: BriefSessionService;
  /** Motion Studio's config folder (a brief session's folders are checked against it). */
  configDir?: string;
  /** Decision 915: where a deleted creative's folder goes (the desktop's Electron Trash, the CLI's own; none: refused). */
  trash: TrashFn;
  /** Report 62: the project paths the project's open brief session holds (a deleted creative's references never take them). */
  briefAssets?: (projectDir: string) => Promise<string[]>;
}

const isInsideDir = (p: string, base: string | null) => Boolean(base && p.startsWith(base.endsWith(sep) ? base : base + sep));

/** `formats`: the formats the request applies to (spec §2.5); absent or empty: all of them. */
/**
 * `direct` (phase 3 of the single agent, decision 1145): a UI action that already names its variant (a failed variant's
 * Retry): the variant's own turn even in a group with one agent.
 */
export const turnBodySchema = z.object({ text: z.string().max(10_000).optional(), pins: z.array(pinSchema).max(50).optional(), formats: z.array(z.string().min(1).max(200)).max(100).optional(), direct: z.literal(true).optional() });
/** `briefSession` (decision 1423): the brief session this creative is made from; `group` when the brief asks for variants. */
const createBody = z.object({ title: z.string(), brief: briefWriteSchema, generate: z.boolean().optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional(),
  briefSession: briefSessionRefSchema.optional() });
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
/**
 * Decision 974: the quality and resolution of the exported videos (absent: the files as they are, older clients), and
 * `background`: the export runs as a job (`{ job }` at once; the files come with the job's `export`).
 */
const exportProfileFields = {
  quality: z.enum(EXPORT_QUALITIES).optional(),
  resolution: z.number().int().refine((r) => (EXPORT_RESOLUTIONS as readonly number[]).includes(r)).optional(),
  /** Report 39 (decision 1234): the frame rate of the exported videos; absent: each composition's own. */
  fps: z.literal(EXPORT_FPS).optional(),
  background: z.boolean().optional(),
};
type VersionEntryList = VersionEntry[];
/** Decision 1007: translations have no profile, so an export with other languages takes only the default one (400). */
function refuseProfileWithLanguages(profile: RenderProfile | undefined, otherTags: readonly string[]): void {
  if (profile && otherTags.length > 0 && !isDefaultProfile(profile)) throw new CodedError(400, t().export.profileWithLanguages, 'export-profile-languages');
}
/** Decision 974, review #4/#5: an item a render made for the export could not give (its render failed, or has problems). */
interface ExportGap { item: ExportItem; slug: string; kind: 'failed' | 'problems'; reason?: string; problems: string[]; issues: OutputIssue[] }
/** What an export job reports once done (decision 974): the files written, and what was left out, as text. */
function outcomeOf(r: ExportResult & { excluded?: NonNullable<ExportOutcome['excluded']>; unavailable?: Array<{ message: string }> }): ExportOutcome {
  const skipped = [...r.skipped, ...(r.unavailable ?? []).map((u) => u.message)];
  return { destination: r.destination, files: r.files.map((f) => f.to), ...(skipped.length ? { skipped } : {}), ...(r.excluded?.length ? { excluded: r.excluded } : {}) };
}
/** The profile a body asks for; undefined when it names no quality, resolution or frame rate. */
const profileOfBody = (b: { quality?: ExportQuality; resolution?: number; fps?: ExportFps }): RenderProfile | undefined =>
  b.quality === undefined && b.resolution === undefined && b.fps === undefined ? undefined
    : { quality: b.quality ?? DEFAULT_EXPORT_QUALITY, ...(b.resolution !== undefined ? { short: b.resolution } : {}), ...(b.fps !== undefined ? { fps: b.fps } : {}) };
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
  /**
   * The subtitles to export (spec §6.6, Task 21): `drawn` one video per language with it drawn (`<stem>-sub-<lang>`); `files`
   * the `.srt`/`.vtt` and `soft` the `mov_text` tracks, both with the CLEAN video `<stem>` (anti-goal 2). Absent: as before.
   */
  subtitles: z.object({
    drawn: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
    files: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
    soft: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
  }).optional(),
  ...exportProfileFields,
});
/** Phase 15 (spec §6): `POST …/export-group`; no picks, the group selection decides. */
const exportGroupBody = z.object({
  destination: z.unknown().optional(), pattern: z.unknown().optional(), date: z.unknown().optional(),
  locales: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
  /** The formats to export (the dialog's ticked rows); absent: every format of the selection. */
  formats: z.array(z.string().min(1).max(200)).max(MAX_EXPORT_FORMATS).optional(),
  /** "Render anyway" for translations rendered first that have open problems or outdated entries (as the single export). */
  force: z.boolean().optional(),
  ...exportProfileFields,
}).strict();
const useAsLogoBody = z.object({ variant: z.enum(['primary', 'icon']) }).strict();
const linkBody = z.object({ follower: z.string().min(1).max(200), primary: z.string().min(1).max(200).nullable() });
/** Phase 15: `POST …/variants` (see the route). */
const addVariantsBody = z.object({
  // No cap on the group (decision 978); one request adds at most MAX_NEW_VARIANTS (A included when it creates the group).
  count: z.number().int().min(1).max(MAX_NEW_VARIANTS).optional(),
  directions: z.array(z.union([z.string().max(MAX_DIRECTION_CHARS), z.null()])).max(MAX_NEW_VARIANTS).optional(),
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
  targets: z.union([z.array(variantIdSchema).min(1).max(1000), z.literal('all-active')]),
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
/** `GET …/editor/svg`: the session and the clip's `src` (checked by the service, which answers `svg-edit-bad-base`). */
const svgReadQuery = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), path: z.string().min(1).max(300) });
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
  /** Report 62: the project paths the project's open brief session holds (its references are never swept). */
  briefAssets?: (projectDir: string) => Promise<string[]>;
  /** The media tools the library reads with (the sweep of abandoned references). */
  media?: MediaTools;
  /** Where swept references go (decision 1582); without it none is removed. */
  trash?: TrashFn;
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
    // Phase 3 of the single agent: a group turn the restart cut is said in its group's chat (its helpers were recovered above).
    if (side) {
      const slugs = (await new CreativeStore(dir).listAll().catch(() => [])).filter((c) => c.ok).map((c) => c.slug);
      await recoverGroupTurns(dir, slugs, side, (slug) => isJobActive(groupJobKey(ws.root, p.slug, slug))).catch((err: Error) => {
        console.warn(`Motion Studio: group turn recovery failed in project ${p.slug}: ${err.message}`);
      });
    }
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
    // Report 62 (decision 1571): the references of a brief abandoned more than 7 days ago (no creative, no open session).
    // Skipped when the open session cannot be read: its files are unknown.
    const { briefAssets, trash } = ro;
    if (trash) {
      const swept = await sweepCreativeReferences(dir, ro.media ?? NoMediaTools, { trash, ...(briefAssets ? { inBrief: () => briefAssets(dir) } : {}) }).catch((err: Error) => {
        console.warn(`Motion Studio: the brief references of project ${p.slug} were not swept: ${err.message}`);
        return [];
      });
      if (swept.length > 0 && ro.git) await ro.git.commitPaths(dir, ['assets'], t().jobs.deleteReferencesCommit({ count: swept.length })).catch(() => null);
    }
    // The derived caches (storyboards, pin frames, agent originals, reference frames): old and over-cap version folders.
    await sweepDerivedCaches(dir, { skipCreative: (slug) => isJobActive(creativeJobKey(ws.root, p.slug, slug)) }).catch(() => []);
    // The editor's staging folders a quit or a crash left behind (older than 24 h; never a live session's).
    await sweepEditorStaging(dir, { ...(ro.stagingInUse ? { inUse: ro.stagingInUse } : {}) }).catch(() => []);
    // Decision 1476: the video analyses' key frames, old ones (never a content being analysed now).
    await sweepAnalysisFrames(dir, { inUse: (sha) => isJobActive(videoAnalysisJobKey(ws.root, p.slug, sha)) }).catch(() => []);
    await Promise.all([sweepProject(dir, !isJobActive(brandJobKey(ws.root, p.slug))), completeGitignore(dir)]).catch((err: Error) => {
      console.warn(`Motion Studio: cleanup failed in project ${p.slug}: ${err.message}`);
    });
  }
}

export { localeAssetsCheck };

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
  /** Report 41: version `n` of a running turn, standing for `format` alone once the agent's check passed on it; else undefined. */
  const inProgress = (ref: CreativeRef, n: number, format: string) => {
    const hash = Number.isInteger(n) && n > 0 ? ctx.turns.readyFormat(ref, n, format) : null;
    return hash === null ? undefined : workVersion(n, format, hash);
  };
  const variantsOf = (ref: CreativeRef & { store: CreativeStore }) => new VariantGroupService({ store: ref.store, turns: ctx.turns });
  /** Phase 15: the variant side of a creative's detail; absent outside a group (an old creative's detail is unchanged). */
  const variantDetail = async (ref: CreativeRef & { store: CreativeStore }): Promise<VariantDetail | undefined> => {
    const r = await variantsOf(ref).resolve(ref);
    const slug = ref.creativeSlug;
    if (r.orphan) return { orphan: true, host: hostOf(slug), letter: letterOfSlug(slug) };
    if (!r.group) return undefined;
    const letter = r.group.members.find((m) => m.slug === slug)?.letter ?? 'a';
    const missing = r.group.members.filter((m) => r.missing.includes(m.slug)).map((m) => m.letter);
    const { store: _s, ...plain } = ref;
    const single = ctx.groups && await ctx.groups.enabled(plain) ? { single: { groupJobKey: groupJobKey(ref.root, ref.projectSlug, r.host.creativeSlug) } } : {};
    return { orphan: false, host: r.host.creativeSlug, letter, group: r.group, missing, ...single };
  };

  app.get('/api/formats', async () => catalog().load());
  app.put<{ Body: { presets?: unknown } }>('/api/formats', async (req) => catalog().save((req.body?.presets ?? []) as never));
  app.post('/api/formats/reset', async () => catalog().resetToDefaults());
  // Report 59: custom formats from New creative, one preset per call (each change read and written under the catalog's lock).
  const custom = () => ({ catalog: catalog(), ws: ctx.requireWorkspace() });
  app.post('/api/formats/custom', async (req) => addCustomFormat(custom(), req.body));
  app.put<{ Params: { id: string } }>('/api/formats/custom/:id', async (req) => editCustomFormat(custom(), req.params.id, req.body));
  app.delete<{ Params: { id: string } }>('/api/formats/custom/:id', async (req) => deleteCustomFormat(custom(), req.params.id));
  app.get<{ Params: { id: string } }>('/api/formats/custom/:id/usage', async (req) => customFormatUsage(custom(), req.params.id));

  // Decision 915: the archived creatives are left out; `?archived=1` lists only them (the "Archiviate" section).
  app.get<{ Params: { slug: string }; Querystring: { archived?: string } }>('/api/projects/:slug/creatives', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const archived = req.query.archived === '1';
    return (await new CreativeStore(ws.projectDir(req.params.slug)).list()).filter((i) => (i.ok && i.archivedAt !== undefined) === archived);
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
        if (!i.ok || i.archivedAt) continue;
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
    // Report 59: a format deleted in another window (or never in the catalog) is refused before anything is created.
    assertFormatsOffered(brief.formats, presets);
    const groupSize = identityGroupSize(brief, presets);
    const links = initialLinks(brief, presets);
    // Decision 1423: the brief session is held before anything is created, so a refused claim (gone, or its agent at work)
    // creates nothing; any failure before the handoff gives it back.
    const projectDir = ws.projectDir(req.params.slug);
    let claim: BriefClaim | null = null;
    if (body.briefSession) {
      if (!ctx.briefs) throw new CodedError(409, t().errors.briefSessionGone, 'brief-session-gone');
      const project = await ws.getProject(req.params.slug);
      claim = await ctx.briefs.claim({ root: ws.root, projectSlug: req.params.slug, projectDir, projectName: project.name, projectCodebases: project.linkedCodebases, configDir: ctx.configDir ?? '' }, body.briefSession.id);
    }
    let handed = false;
    /** The move's error, when it did not finish: the creative exists anyway (201 with `briefError`). */
    let briefError: string | null = null;
    const handOff = async (slug: string) => {
      if (!claim) return;
      handed = true;
      try {
        const group = (body.briefSession?.group === true && singleAgentOn(await ws.readSettings())) || groupSize > 1;
        await ctx.briefs!.handOff(claim, { root: ws.root, projectSlug: req.params.slug, projectDir, creativeSlug: slug },
          { group, title: body.title, formats: t().briefSession.parts.formats({ count: brief.formats.length }) });
      } catch (err) {
        // The session is marked as moved into this creative, so a second Genera cannot make a duplicate; its chat stays.
        briefError = err instanceof Error ? err.message : String(err);
        await ctx.briefs!.markHandedOff(claim, slug);
      }
    };
    const withBriefError = () => (briefError ? { briefError } : {});
    try {
      // Report 59: checked again under the catalog's lock while creative.json is written (a delete cannot slip in between).
      const created = await catalog().whileOffered(brief.formats, [], () => store.create({ title: body.title, brief: { ...brief, links } }));
      const slug = created.slug;
      // Fix round 1 (M2): its side record exists from the start (nothing written into its creative.json later is trusted).
      await ctx.turns.side.read(ws.projectDir(req.params.slug), slug);
      const creative = linkedCodebases ? await store.update(slug, { linkedCodebases }) : created.creative;
      const ref = { root: ws.root, projectSlug: req.params.slug, projectDir: ws.projectDir(req.params.slug), creativeSlug: slug };
      // Decision 1469: the brief's videos are analysed from now (the first turn waits for them, decision 1478).
      ctx.turns.briefAssetsAdded(ref, brief.assets);
      // Report 62: the files added from the computer in this brief (and in its session's chat) become this creative's.
      const session = claim ? await ctx.briefs!.view(claim.ref).catch(() => null) : null;
      await claimCreativeReferences(projectDir, ctx.media, slug, [...briefFilePaths(brief), ...(session ? [...session.context.assets, ...session.form.assets] : [])])
        .catch((err: Error) => console.warn(`Motion Studio: the brief's references were not given to ${slug}: ${err.message}`));
      // Phase 15: an identity creative with several concepts is a group of that many variants (the host is A), made here and
      // started like any grouped creative's first generation (`ctx.variantRuns`, the same orchestration as `…/variants/run`).
      if (groupSize > 1) {
        // Final wave M4 (as decisions log 847): the creative exists from here, so a group that cannot be made must not lose the
        // slug either: 201 with `groupError`, nothing started (addVariants leaves no sister behind); the canvas can add variants.
        try {
          await new VariantGroupService({ store, turns: ctx.turns }).addVariants(ref, Array.from({ length: groupSize - 1 }, () => ({ direction: null })), { hostDirection: null });
        } catch (err) {
          await handOff(slug);
          return reply.status(201).send({ slug, creative: await store.get(slug), job: null, groupError: err instanceof Error ? err.message : String(err), ...withBriefError() });
        }
        await handOff(slug);
        // The group exists from here: a start that throws must not lose the slug (the client opens the creative and can retry).
        let variantRun: Awaited<ReturnType<typeof ctx.variantRuns.run>> | null = null;
        let startError: string | null = null;
        if (body.generate) {
          try { variantRun = await ctx.variantRuns.run(ref, 'all-active', null); } catch (err) { startError = err instanceof Error ? err.message : String(err); }
        }
        return reply.status(201).send({ slug, creative: await store.get(slug), job: null, ...(variantRun ? { variantRun } : {}), ...(startError ? { startError } : {}), ...withBriefError() });
      }
      await handOff(slug);
      const job = body.generate ? await ctx.turns.start(ref) : null;
      return reply.status(201).send({ slug, creative: job ? await store.get(slug) : creative, job, ...withBriefError() });
    } finally {
      if (claim && !handed) ctx.briefs!.release(claim);
    }
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
    const merged = await ctx.turns.side.merged(ref.projectDir, ref.creativeSlug, creative);
    // Phase 3 of the single agent: every member of a group with one agent shows the group's queue (the one composer's).
    const single = ctx.groups && await ctx.groups.enabled(ref) ? await ctx.groups.queued(ref) : null;
    if (single) { if (single.length > 0) merged.queued = single; else delete merged.queued; }
    // Decision 1636: the creative's subtitle sets (absent: none); their hashes tell a render drawn with an older set (Task 18).
    const subtitles = await subtitleSummaries(ref.projectDir, ref.creativeSlug, async () => (await catalog().load()).presets);
    return {
      // Phase 13: the queue and remembered session are kept by the core outside the project (final review I1).
      slug: ref.creativeSlug, creative: merged, versions,
      jobKey: creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug),
      formats: await formatSummaries(creativeDir, creative, versions, (await catalog().load()).presets, subtitleHashesOf(subtitles)),
      ...await variantDetail(ref).then((variants) => (variants ? { variants } : {})),
      ...(subtitles.length ? { subtitles } : {}),
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
    // Report 59: a full brief may add only formats still offered; the ones it already had stay (a hidden one included).
    if (body.brief) assertFormatsOffered(body.brief.formats, (await catalog().load()).presets, (await ref.store.get(ref.creativeSlug)).brief.formats);
    return ctx.turns.updateBrief(ref, body);
  });

  // Decision 915: archive, restore from the archive, and delete (to the Trash). `?all=1` acts on a whole variant group from
  // its variant A (required there: 409 `creative-group` without it). Never reachable by the agent's tools (decision 917).
  const removal = () => new CreativeRemoval({ turns: ctx.turns, jobs: ctx.jobs, trash: ctx.trash, media: ctx.media, ...(ctx.broadcast ? { broadcast: ctx.broadcast } : {}), ...(ctx.briefAssets ? { briefAssets: ctx.briefAssets } : {}) });
  const plainRef = ({ store: _store, ...ref }: CreativeRef & { store: CreativeStore }): CreativeRef => ref;
  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/removal', async (req) =>
    removal().info(plainRef(await refOf(req.params.slug, req.params.c))));
  app.post<{ Params: { slug: string; c: string }; Querystring: { all?: string } }>('/api/projects/:slug/creatives/:c/archive', async (req) =>
    ({ archived: await removal().archive(plainRef(await refOf(req.params.slug, req.params.c)), req.query.all === '1') }));
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/unarchive', async (req) =>
    ({ restored: await removal().unarchive(plainRef(await refOf(req.params.slug, req.params.c))) }));
  app.delete<{ Params: { slug: string; c: string }; Querystring: { all?: string } }>('/api/projects/:slug/creatives/:c', async (req) =>
    ({ deleted: await removal().delete(plainRef(await refOf(req.params.slug, req.params.c)), req.query.all === '1') }));

  // Phase 15: variant groups (spec §2, §5). Every route but POST …/variants refuses a creative outside a group (409
  // `variant-no-group`) and writes nothing: an old creative is unchanged by them.
  /**
   * Creates sisters (ruling R3: no turn starts; Task 3's `…/variants/run` starts them). With no group yet, `count` is the size
   * of the group asked for, A included (2..MAX_NEW_VARIANTS), and `directions[0]` is A's; on a group, `count` is how many variants to add
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
    // Minor (Task 2): whether this creates the group, and how many variants that adds, is decided UNDER the host's lock
    // (`addVariants` calls this with the group as stored then), so two requests cannot both believe they create it.
    await svc.addVariants(r.host, (existing) => {
      const creating = existing === null;
      const total = creating ? body.count ?? Math.max(2, directions.length) : null;
      const add = creating ? total! - 1 : body.count ?? Math.max(1, directions.length);
      if (creating && total! < 2) throw new CodedError(400, t().errors.invalidRequest, 'invalid-request');
      if (add < 1 || directions.length > (creating ? total! : add)) throw new CodedError(400, t().errors.variantDirections, 'variant-directions');
      const own = creating ? directions.slice(1) : directions;
      return {
        specs: Array.from({ length: add }, (_, i) => ({ direction: own[i] ?? null, ...(body.baseFrom ? { baseFrom: body.baseFrom } : {}) })),
        ...(creating ? { hostDirection: directions[0] ?? null } : {}),
      };
    });
    return reply.status(201).send(await detailOf({ ...r.host, store: ref.store }));
  });

  const letterOf = (l: string): VariantId => {
    if (!isVariantId(l)) throw new CodedError(404, t().errors.variantUnknown({ letter: String(l).slice(0, 3).toUpperCase() }), 'variant-unknown');
    return l as VariantId;
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
    // Only an explicit JSON `null` clears the ★; a request without a body is a mistake, not a clear (minor, Task 2).
    if (req.body === undefined) throw new CodedError(400, t().errors.invalidRequest, 'invalid-request');
    const pick = req.body === null ? null : parse(variantPickBody, req.body);
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
    // Phase 3 of the single agent: a request sent to several variants is ONE group turn, with those variants as its explicit
    // targets (nothing is copied to N agents); a first generation (no request) stays the variants' own turns (decision 1145).
    const text = body.request?.text?.trim() ?? '';
    const pins = body.request?.pins ?? [];
    if (body.request && (text || pins.length) && !body.request.direct && ctx.groups && await ctx.groups.enabled(plain)) {
      const g = await variantsOf(ref).resolve(ref);
      const variants = body.targets === 'all-active' ? (g.group ? activeMembers(g.group).map((m) => m.letter) : []) : body.targets;
      const job = await ctx.groups.start(plain, { text, pins, variants });
      return reply.status(202).send({ jobs: {}, queued: [], skipped: [], failed: {}, groupJobId: job.id });
    }
    return reply.status(202).send(await ctx.variantRuns.run(plain, body.targets, body.request));
  });

  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/conversation', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    await ref.store.get(ref.creativeSlug);
    // Phase 3 of the single agent: the members' own queues move to the group's first (the merge waits for empty queues).
    if (ctx.groups && await ctx.groups.enabled(plainRef(ref))) {
      const g = await variantsOf(ref).resolve(ref);
      if (g.group && !g.orphan) await ctx.groups.adoptMemberQueues(g.host, g.group).catch(() => {});
    }
    // Decision 982: a group's first read while it is idle merges its chats once (lazily); any member answers the group's.
    await variantsOf(ref).mergeChat(ref).catch((err: unknown) => {
      console.warn(`Motion Studio: the chats of ${ref.creativeSlug} were not merged yet: ${err instanceof Error ? err.message : String(err)}`);
    });
    return ref.store.readConversation(ref.creativeSlug);
  });

  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/turns', async (req, reply) => {
    const body = parse(turnBodySchema, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const text = body.text?.trim() ?? '';
    const pins = body.pins ?? [];
    // Phase 3 of the single agent: a message to a group with one agent is the group's turn; a turn with no message or with
    // formats is a UI action that names its variant (Genera, regenerate a format: decision 1145) and stays the variant's.
    if ((text || pins.length) && !body.formats?.length && !body.direct && ctx.groups && await ctx.groups.enabled(plainRef(ref))) {
      return reply.status(202).send(await ctx.groups.start(plainRef(ref), { text, pins }));
    }
    const job = await ctx.turns.start(ref, text || pins.length ? { text, pins } : undefined, body.formats ? { formats: body.formats } : {});
    return reply.status(202).send(job);
  });

  // Phase 13 (spec §2): messages while the agent works, and the request queue (Rulings S and T).
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/messages', async (req) => {
    const body = parse(messageBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    await ref.store.get(ref.creativeSlug); // 404 for unknown creatives
    if (ctx.groups && await ctx.groups.enabled(plainRef(ref))) return ctx.groups.postMessage(plainRef(ref), { clientId: body.clientId, text: body.text, pins: body.pins ?? [], mode: body.mode });
    return ctx.turns.postMessage(ref, { clientId: body.clientId, text: body.text, pins: body.pins ?? [], mode: body.mode });
  });

  // Phase 3 of the single agent: in a group with one agent the queue is the group's, the same from every member.
  const groupsOn = async (ref: CreativeRef & { store: CreativeStore }) =>
    (ctx.groups && await ctx.groups.enabled(plainRef(ref)) ? { groups: ctx.groups, plainRef: plainRef(ref) } : null);

  app.delete<{ Params: { slug: string; c: string; clientId: string } }>('/api/projects/:slug/creatives/:c/queue/:clientId', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const g = await groupsOn(ref);
    if (g) { await g.groups.removeQueued(g.plainRef, req.params.clientId); return (await detailOf(ref)).creative; }
    return ctx.turns.removeQueued(ref, req.params.clientId);
  });

  app.put<{ Params: { slug: string; c: string; clientId: string } }>('/api/projects/:slug/creatives/:c/queue/:clientId', async (req) => {
    const body = parse(queueEditBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const g = await groupsOn(ref);
    if (g) { await g.groups.editQueued(g.plainRef, req.params.clientId, { text: body.text, pins: body.pins ?? [] }); return (await detailOf(ref)).creative; }
    return ctx.turns.editQueued(ref, req.params.clientId, { text: body.text, pins: body.pins ?? [] });
  });

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/queue', async (req) => {
    const body = parse(queueOrderBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const g = await groupsOn(ref);
    if (g) { await g.groups.reorderQueue(g.plainRef, body.order); return (await detailOf(ref)).creative; }
    return ctx.turns.reorderQueue(ref, body.order);
  });

  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/queue/run-next', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const g = await groupsOn(ref);
    if (g) return reply.status(202).send(await g.groups.runNext(g.plainRef));
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
    // The subtitles (Task 21): every language needs its set (a refusal before anything is rendered or copied).
    const tagsOf = (list: string[] | undefined) => [...new Set((list ?? []).map((x) => checkedLocale(x, currentLocale())))];
    const drawnTags = tagsOf(body.subtitles?.drawn);
    const fileTags = tagsOf(body.subtitles?.files);
    const softTags = tagsOf(body.subtitles?.soft);
    const subtitleSetOf = new Map<LocaleTag, SubtitleSet>();
    for (const lang of [...new Set([...drawnTags, ...fileTags, ...softTags])]) {
      const found = await readSubtitleSet(creativeDir, lang);
      if (!found) throw new CodedError(400, t().export.subtitlesMissing({ lang }), 'export-subtitles-missing');
      subtitleSetOf.set(lang, found.set);
    }
    // Each video is cut at its own duration (its output's); the latest main format's is only the fallback for an unknown one.
    const fallbackMs = subtitleSetOf.size > 0 ? (await subtitleTimingNow(ref.projectDir, ref.creativeSlug, presets))?.durationMs : undefined;
    const subtitleChoice: SubtitleChoice | null = subtitleSetOf.size > 0
      ? { drawn: drawnTags, files: fileTags.map((x) => subtitleSetOf.get(x)!), soft: softTags, sets: Object.fromEntries(subtitleSetOf), ...(fallbackMs !== undefined ? { durationMs: fallbackMs } : {}) } : null;
    const common = { creativeDir, destination, slug: ref.creativeSlug, title: creative.title, forbiddenRoot: ref.root, presets, pattern,
      ...(typeof body.date === 'string' ? { now: body.date } : {}),
      label: (id: string) => formatDisplayName(presets, id, currentLocale(), creative.brief.formatLabels) };
    if (body.picks === undefined && body.follow === undefined && body.version !== undefined) {
      // The older single-version payload: every output of that version, the `.srt`/`.vtt` next to each video (Task 7); it has
      // no clean-video rule, so it takes no drawn or soft subtitles.
      if (drawnTags.length > 0 || softTags.length > 0) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
      const version = (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === body.version);
      if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
      const files = fileTags.map((x) => subtitleSetOf.get(x)!);
      return exportVersion({ ...common, version, ...(files.length > 0 ? { subtitles: { sets: files, ...(fallbackMs !== undefined ? { durationMs: fallbackMs } : {}) } } : {}) });
    }
    const profile = profileOfBody(body);
    refuseProfileWithLanguages(profile, otherTags);
    // Task 21 (review round 1): a video the subtitled export renders entirely for itself needs no version render first.
    const defaultLang = subtitleChoice ? await defaultSubtitleLang(creativeDir, creative.brief) : null;
    const profileOpts = profile ? { profile, presets } : {};
    const resolve = async () => {
      // The same hashed versions as the creative GET, so a follower's ★ here is the one the dialog showed.
      await reconcileRenders({ projectDir: ref.projectDir, store: ref.store, creativeSlug: ref.creativeSlug }).catch(() => false);
      const { versions, complete } = await withLazyHashes({ projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug) });
      // A follower's version is decided on hashes: never on partial ones (a refusal now would only mean "not hashed yet").
      // The hashing goes on; the client retries after Retry-After, as for a ★ pick.
      if (!complete && body.follow !== undefined) throw new CodedError(503, t().errors.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
      const items = resolveExportPicks({ ...common, versions, picks: (body.picks ?? {}) as Record<string, number>, follow: body.follow as string[] | Record<string, number> | undefined,
        links: effectiveLinks(creative.brief.links, creative.brief.formats), storedPicks: creative.exportPicks });
      const skip = subtitleChoice ? { skip: (it: ExportItem) => skipsVersionRender({ creativeDir, versions, item: it, choice: subtitleChoice, defaultLang }) } : {};
      return { items, versions, pending: await pendingRenders(creativeDir, versions, items, { ...profileOpts, ...skip }) };
    };
    // Decision 974: in the background the request answers at once with the job (its refusals of the picks first, as before).
    if (body.background) {
      await checkDestination(destination, ref.root);
      await resolve();
      return { job: ctx.exports.start(ref, creative.title, destination, async (run) => outcomeOf(await exportNow(run))) };
    }
    return exportNow();

    async function exportNow(run?: ExportRun) {
      const wait: RenderWait = run?.wait ?? {};
      let { items, pending, versions } = await resolve();
      // Task 5b: a v2 ★ with no current render is rendered first (a render job per version, its progress on the job list),
      // then the picks are resolved again on the new records and copied. Legacy versions export their media as they are.
      const rendered: Array<{ version: number; formats: string[] }> = [];
      if (pending.size > 0 && includeSource) {
        await notDiscarded(ref); // residual fix (decisions log 866): what is already rendered still exports
        await ctx.renders.renderAndWait(ref, pending, wait);
        for (const [version, formats] of pending) rendered.push({ version, formats });
        ({ items, pending, versions } = await resolve());
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
        const loc = await withLocales(ref, creativeDir, items, { includeSource, primaryLocale, otherTags, force: body.force === true, label: common.label, wait });
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
      // Decision 974: the videos at another quality or size are rendered for this export alone, then copied from there. With
      // subtitles (Task 21) the renders made for the export also give the drawn and the clean videos.
      const renderFor = subtitleChoice
        ? (copy: (list: ExportItem[], gaps: ExportGap[]) => Promise<ExportResult>) => withSubtitleExports(ref, items, versions, subtitleChoice, subtitleSetOf, profile, presets, common.label, wait, copy)
        : (copy: (list: ExportItem[], gaps: ExportGap[]) => Promise<ExportResult>) => withExportRenders(ref, items, versions, profile ? { profile, presets } : null, wait, copy);
      const result = await renderFor(async (list, gaps) => {
        // A render made for the export that failed refuses the export, as a version render does; one with problems is left
        // out and listed (I2, review #4).
        const failedNow = gaps.filter((g) => g.kind === 'failed');
        if (failedNow.length > 0) {
          throw new CodedError(409, t().export.renderFailed({ list: failedNow.map((g) => `${common.label(g.item.format)} v${g.item.n}${g.reason ? ` (${g.reason})` : ''}`).join(', ') }), 'export-render-failed');
        }
        for (const g of gaps) {
          problems.push(t().export.renderProblems({ item: `${common.label(g.item.format)} v${g.item.n}`, list: g.problems.join('; ') }));
          excluded.push({ format: g.item.format, version: g.item.n, problems: g.problems, issues: g.issues });
        }
        if (!list.length) throw new CodedError(409, t().export.renderProblemsOnly({ list: problems.join(', ') }), 'export-render-problems');
        run?.copying();
        return exportResolved(list.map(({ problems: _p, ...it }) => it), run ? { ...common, signal: run.signal } : common);
      });
      const withProblems = excluded.length ? { ...result, excluded } : result;
      const allRendered = [...rendered, ...localeRendered];
      return allRendered.length > 0 ? { ...withProblems, rendered: allRendered } : withProblems;
    }
  });

  /**
   * Phase 15 (spec §6): what a group export would copy, per format of the group: the member and version the group ★ (or the
   * default rule on variant A) names, with the file and its state. Any member of the group answers the same; 409 outside one.
   */
  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/export-group', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const plan = await planGroupExport(variantsOf(ref), ref.store, ref);
    // `formats`: the group's canonical formats (the host's pending brief, else its own), for the rows of the final selection.
    return { items: plan.map(({ creativeDir: _dir, set: _set, ...p }) => p), formats: await variantsOf(ref).groupFormats(ref) };
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
    const profile = profileOfBody(body);
    refuseProfileWithLanguages(profile, otherTags);
    const planOf = async () => withGroupProfile(ref.store, (await planGroupExport(svc, ref.store, ref)).filter((p) => !only || only.has(p.format)), profile, presets);
    // Decision 974: in the background the request answers at once with the job (a refusal of the group first, as before).
    if (body.background) {
      await checkDestination(common.destination, ref.root);
      await planOf();
      return { job: ctx.exports.start({ ...ref, creativeSlug: ref.creativeSlug }, host.title, common.destination, async (run) => outcomeOf(await exportNow(run))) };
    }
    return exportNow();

    async function exportNow(run?: ExportRun) {
    const wait: RenderWait = run?.wait ?? {};
    let plan = await planOf();
    const key = (p: Pick<GroupPlanItem, 'slug' | 'format' | 'version'>) => `${p.slug}\0${p.format}\0${p.version}`;
    const withProblems = new Map<string, string[]>();
    const renderErrors = new Map<string, string>();
    const pending = plan.filter((p) => p.state === 'needs-render');
    if (includeSource && pending.length > 0) {
      // One render job per member and version, in the member's own folder; a render that cannot run leaves its formats out,
      // with the job's own error (as the pack route reports it).
      for (const [slug, versions] of pendingByMember(pending)) {
        const error = await ctx.renders.renderAndWait({ ...ref, creativeSlug: slug }, versions, wait)
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
    type Gap = { format: string; slug: string; letter: VariantId; version: number; locale?: string; message: string };
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
      const done = await renderGroupLocales({ renderLocalesAndWait: (r, n, f, l, force) => ctx.renders.renderLocalesAndWait(r, n, f, l, force, wait) }, ref, loc.pending, body.force === true, (list) => messages(currentLocale()).variants.renderNeedsForce({ list }));
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
    // Decision 974: the videos at another quality or size are rendered for this export alone, each in its own member.
    const memberOf = new Map(plan.map((p) => [p.creativeDir, p.slug]));
    const readyItems = items;
    return withExportRenders(ref, readyItems, [], profile ? { profile, presets } : null, wait, async (list, gaps) => {
      // Review #5: a render made for the export that failed, or that has problems, leaves that format out (the group rule).
      for (const gp of gaps) {
        const p = plan.find((x) => x.slug === gp.slug && x.format === gp.item.format && x.version === gp.item.n);
        if (!p) continue;
        unavailable.push(gap(p, gp.kind === 'failed' ? g.renderFailed({ reason: gp.reason ?? '' }) : g.renderProblems({ list: gp.problems.join('; ') })));
      }
      run?.copying();
      const result = await exportGroup(usable.filter((p) => !gaps.some((gp) => gp.slug === p.slug && gp.item.format === p.format && gp.item.n === p.version)), run ? { ...common, signal: run.signal } : common, list);
      const { unavailable: _plan, ...copied } = result;
      return { ...copied, unavailable };
    }, (it) => memberOf.get(it.creativeDir ?? '') ?? hostRef.creativeSlug);
    }
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
  /**
   * Decision 974: renders the items an export at `profile` takes at another quality or size (`profiledRenders`), each in its
   * creative (`member`), into a temp folder of the core's own (`ms-render-export-*`, swept after a crash); `copy` then gets
   * the items with those files as their source, and the gaps: a format whose render failed, or whose render has problems
   * (review #4, the output checks of a version render), left out of the items. The temp folder goes once the copy is done.
   */
  async function withExportRenders<R>(ref: CreativeRef & { store: CreativeStore }, items: ExportItem[], versions: VersionEntryList, o: { profile: RenderProfile; presets: FormatPreset[] } | null,
    wait: RenderWait, copy: (items: ExportItem[], gaps: ExportGap[]) => Promise<R>, member?: (it: ExportItem) => string): Promise<R> {
    if (!o) return copy(items, []);
    const slugOf = (it: ExportItem) => member?.(it) ?? ref.creativeSlug;
    const bySlug = new Map<string, ExportItem[]>();
    for (const it of items) bySlug.set(slugOf(it), [...(bySlug.get(slugOf(it)) ?? []), it]);
    const plans = new Map<string, Map<number, string[]>>();
    for (const [slug, list] of bySlug) {
      const vs = slug === ref.creativeSlug && !member ? versions : await ref.store.readVersions(slug);
      const pending = await profiledRenders(ref.store.dir(slug), vs, list, o);
      if (pending.size > 0) plans.set(slug, pending);
    }
    if (plans.size === 0) return copy(items, []);
    const temp = await makeOwnedTempDir(join(tmpdir(), 'ms-render-export-'));
    try {
      const files = new Map<string, ExportRendered>();
      const failed = new Map<string, string>();
      for (const [slug, pending] of plans) {
        const at = { ...ref, creativeSlug: slug };
        await notDiscarded(at);
        const r = await ctx.renders.exportRenderAndWait(at, pending, { profile: o.profile }, join(temp, slug), wait);
        for (const [n, fs] of pending) {
          for (const f of fs) {
            const k = `${n}\0${f}`;
            const made = r.files.get(k);
            if (made) files.set(`${slug}\0${k}`, made);
            else failed.set(`${slug}\0${k}`, r.failed.get(k) ?? r.errors[0] ?? '');
          }
        }
      }
      const gaps: ExportGap[] = [];
      const kept: ExportItem[] = [];
      for (const it of items) {
        const k = `${slugOf(it)}\0${it.n}\0${it.format}`;
        const f = it.localized ? undefined : files.get(k);
        const reason = it.localized ? undefined : failed.get(k);
        if (reason !== undefined) { gaps.push({ item: it, slug: slugOf(it), kind: 'failed', reason, problems: [], issues: [] }); continue; }
        if (f && f.problems.length > 0) { gaps.push({ item: it, slug: slugOf(it), kind: 'problems', problems: f.problems, issues: f.issues }); continue; }
        kept.push(f ? { ...it, source: f.path, file: basename(f.path), width: f.render.width, height: f.render.height } : it);
      }
      return await copy(kept, gaps);
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /**
   * Subtitles Task 21 (spec §6.6, decision 1643): the export's subtitle choices (`planSubtitleExport`) made real, in a temp folder
   * of the core's own like `withExportRenders`: one render job per version and way of rendering (the clean video, each drawn
   * language), the soft tracks muxed into a copy of a clean version file that needs no render, then `copy` with the items and
   * the gaps (as `withExportRenders`). The notes (a still, a video with no subtitles track) are added to `skipped`.
   */
  async function withSubtitleExports(ref: CreativeRef & { store: CreativeStore }, items: ExportItem[], versions: VersionEntryList, choice: SubtitleChoice,
    sets: ReadonlyMap<LocaleTag, SubtitleSet>, profile: RenderProfile | undefined, presets: FormatPreset[], label: (id: string) => string, wait: RenderWait,
    copy: (items: ExportItem[], gaps: ExportGap[]) => Promise<ExportResult>): Promise<ExportResult> {
    const creativeDir = ref.store.dir(ref.creativeSlug);
    const profiled = profile ? await profiledRenders(creativeDir, versions, items.filter((it) => !it.localized), { profile, presets }) : new Map<number, string[]>();
    const { entries, notes } = await planSubtitleExport({ creativeDir, versions, items, choice, profiled, hashes: await subtitleHashes(creativeDir), label });
    const withNotes = (r: ExportResult): ExportResult => (notes.length ? { ...r, skipped: [...r.skipped, ...notes] } : r);
    // Nothing a subtitled export can give (e.g. only drawn languages on videos without the track): said, never an empty folder.
    if (entries.length === 0) throw new CodedError(409, t().export.renderProblemsOnly({ list: notes.join(' ') }), 'export-subtitles-nothing');
    const ff = entries.some((e) => e.kind === 'remux') ? await findFfmpeg() : null;
    if (entries.some((e) => e.kind === 'remux') && !ff) throw new CodedError(409, t().errors.noFfmpegSubtitles, 'export-no-ffmpeg');
    if (!entries.some((e) => e.kind !== 'copy')) return withNotes(await copy(entries.map((e) => e.item), []));
    const temp = await makeOwnedTempDir(join(tmpdir(), 'ms-render-export-'));
    try {
      const made = new Map<SubtitleEntry, ExportItem>();
      const gaps: ExportGap[] = [];
      for (const e of entries) {
        if (e.kind !== 'remux') continue;
        if (wait.signal?.aborted) throw new RenderError('cancelled', 'cancelled');
        const it = e.item;
        const durationMs = it.durationSec && it.durationSec > 0 ? Math.round(it.durationSec * 1000) : choice.durationMs ?? Math.max(0, ...choice.soft.flatMap((x) => sets.get(x)!.cues.map((c) => c.end)));
        try {
          const path = await remuxSoft({ ff: ff!, creativeDir, item: it, sets: choice.soft.map((x) => sets.get(x)!), durationMs, work: temp, ...(wait.signal ? { signal: wait.signal } : {}) });
          made.set(e, { ...it, source: path, file: basename(path) });
        } catch (err) {
          if (wait.signal?.aborted) throw new RenderError('cancelled', 'cancelled');
          gaps.push({ item: it, slug: ref.creativeSlug, kind: 'failed', reason: err instanceof Error ? err.message : String(err), problems: [], issues: [] });
        }
      }
      // One render job per version for each way of rendering, in the order the entries name them.
      const groups = new Map<string, { subtitles: NonNullable<ExportRenderOptions['subtitles']>; pending: Map<number, string[]>; list: SubtitleEntry[] }>();
      for (const e of entries) {
        if (e.kind !== 'render') continue;
        const g = groups.get(e.key) ?? { subtitles: e.subtitles, pending: new Map<number, string[]>(), list: [] };
        const fs = g.pending.get(e.item.n) ?? [];
        if (!fs.includes(e.item.format)) g.pending.set(e.item.n, [...fs, e.item.format]);
        g.list.push(e);
        groups.set(e.key, g);
      }
      if (groups.size > 0) await notDiscarded(ref);
      let k = 0;
      for (const g of groups.values()) {
        const r = await ctx.renders.exportRenderAndWait(ref, g.pending, { profile: profile ?? { quality: DEFAULT_EXPORT_QUALITY }, subtitles: g.subtitles }, join(temp, `r${k++}`), wait);
        for (const e of g.list) {
          const key = `${e.item.n}\0${e.item.format}`;
          const f = r.files.get(key);
          if (!f) { gaps.push({ item: e.item, slug: ref.creativeSlug, kind: 'failed', reason: r.failed.get(key) ?? r.errors[0] ?? '', problems: [], issues: [] }); continue; }
          if (f.problems.length > 0) { gaps.push({ item: e.item, slug: ref.creativeSlug, kind: 'problems', problems: f.problems, issues: f.issues }); continue; }
          made.set(e, { ...e.item, source: f.path, file: basename(f.path), width: f.render.width, height: f.render.height, durationSec: f.durationSec ?? e.item.durationSec ?? null });
        }
      }
      const kept = entries.flatMap((e) => (e.kind === 'copy' ? [e.item] : made.has(e) ? [made.get(e)!] : []));
      return withNotes(await copy(kept, gaps));
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  function notDiscarded(ref: CreativeRef): Promise<void> {
    return ctx.turns.runLocked(ref, () => ctx.turns.assertNotDiscarded(ref));
  }

  async function withLocales(ref: CreativeRef & { store: CreativeStore }, creativeDir: string, items: ExportItem[],
    o: { includeSource: boolean; primaryLocale: string | undefined; otherTags: string[]; force: boolean; label: (id: string) => string; wait?: RenderWait }):
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
        await ctx.renders.renderLocalesAndWait(ref, n, p.formats, p.locales, o.force, o.wait);
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
    return prepareExportRenders({ turns: ctx.turns, renders: ctx.renders, presets: async () => (await catalog().load()).presets }, ref, r.data);
  });

  /**
   * A live preview session of one format of a saved v2 version (Task 5b; the web's player and Compare, Task 8). Behind the UI
   * token like every API; `parentOrigin` must be one of the UI origins (403 `preview-origin`); the media is normalised first.
   */
  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/preview-session', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const recorded = Number.isInteger(n) && n > 0 ? (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
    const body = parse(previewBody, req.body);
    // Report 41: a format of the version a running turn is writing, once the agent's check passed on it.
    const version = recorded ?? inProgress(ref, n, body.format);
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    const creativeDir = ref.store.dir(ref.creativeSlug);
    // The subtitles the version's render draws by default (subtitles Task 18, U8), staged into the session's page.
    const subtitles = async (c: Composition) => (await stageDefaultSubtitles(creativeDir, (await ref.store.get(ref.creativeSlug)).brief, c))?.data ?? null;
    return ctx.previews.mintPreview({ projectDir: ref.projectDir, creativeDir, creativeSlug: ref.creativeSlug, n }, version, body.format, body.parentOrigin, currentLocale(),
      { ...(body.renewFrom !== undefined ? { renewFrom: body.renewFrom } : {}), subtitles });
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
   * The text of an SVG a draft clip shows (SVG inner editor), for the editor to edit: a file of the live preview session's
   * composition or one staged in it, only when `checkVectorSvg` accepts it (400 `svg-edit-refused` with the reasons,
   * 400 `svg-edit-bad-base`, 404 `editor-no-session`). JSON, so the text is never served as a document of this origin.
   */
  app.get<{ Params: { slug: string; c: string }; Querystring: { token?: string; path?: string } }>('/api/projects/:slug/creatives/:c/editor/svg', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const q = parse(svgReadQuery, req.query);
    return ctx.previews.readSvg({ creativeDir: ref.store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug }, q.token, q.path, currentLocale());
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
    const recorded = Number.isInteger(n) && n > 0 ? (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
    const version = recorded ?? inProgress(ref, n, req.params.format);
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    const r = await ctx.previews.storyboardOf({ projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug, n }, version, req.params.format);
    if (!r) throw new CodedError(404, t().errors.previewUnavailable, 'storyboard-unavailable');
    // Signed, short-lived image URLs (fix I4), content-addressed by the composition hash (and the drawn subtitles', Task 19:
    // a regenerated storyboard of other content never reuses a URL). The UI asks again before `expiresAt` for fresh ones.
    const base = `/api/projects/${encodeURIComponent(req.params.slug)}/creatives/${encodeURIComponent(ref.creativeSlug)}/storyboard-files/${n}/${r.folder}/${storyboardKey(r.storyboard)}`;
    let expiresAt = 0;
    const frames = r.storyboard.frames.map(({ file, ...f }) => { const s = ctx.signer.sign(`${base}/${file}`); expiresAt = s.expiresAt; return { ...f, url: s.url }; });
    return { format: r.folder, hash: r.storyboard.hash, width: r.storyboard.width, expiresAt: new Date(expiresAt).toISOString(), frames };
  });

  // Storyboard images, shown by <img>: no UI token, but a signed URL from the route above (fix I4); only `f-<i>.jpg` of the
  // storyboard whose content key (`storyboardKey`) is `:hash`.
  app.get<{ Params: { slug: string; c: string; n: string; folder: string; hash: string; file: string }; Querystring: { s?: string } }>('/api/projects/:slug/creatives/:c/storyboard-files/:n/:folder/:hash/:file', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!ctx.signer.verify(path, req.query.s)) return reply.status(403).send({ error: t().errors.fileNotFoundShort });
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const notFound = () => reply.status(404).send({ error: t().errors.fileNotFoundShort });
    if (!Number.isInteger(n) || n < 1 || !FOLDER_RE.test(req.params.folder) || !/^[0-9a-f]{16}$/.test(req.params.hash) || !FRAME_FILE_RE.test(req.params.file)) return notFound();
    const sb = await readJsonFile(join(storyboardDir(ref.projectDir, ref.creativeSlug, n, req.params.folder), 'storyboard.json'), storyboardSchema).catch(() => null);
    if (!sb || storyboardKey(sb) !== req.params.hash) return notFound();
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
    const creativeDir = ref.store.dir(ref.creativeSlug);
    const readSetSvg = async (path: string): Promise<string> => {
      if (!plain(set.dir) || !plain(path)) throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
      const fileParts = path.split('/');
      const fileName = fileParts.pop()!;
      const dirParts = ['outputs', `v${n}`, ...set.dir.split('/'), ...fileParts];
      const chain = await isRealDirChain(creativeDir, dirParts);
      if (chain === 'missing') throw new CodedError(404, e.useAsLogoMissing, 'logo-missing');
      if (chain === 'unsafe') throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
      const read = await readConfinedFile(join(creativeDir, ...dirParts), fileName, MAX_VECTOR_SVG_BYTES, true).catch(() => ({ skipped: 'outside' as const }));
      if (read === null) throw new CodedError(404, e.useAsLogoMissing, 'logo-missing');
      if ('skipped' in read) throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
      if (!checkVectorSvg(read.text).ok) throw new CodedError(422, e.useAsLogoRefused, 'logo-refused');
      return read.text;
    };
    const svgText = await readSetSvg(svgEntry.path);
    // Decision 879: a logo's negative (`logo-dark.svg`, decision 876) goes into the kit with it, checked the same way; an
    // older logo has none. Both are read before anything is written, so a refused negative leaves nothing behind.
    const darkEntry = preset.identity === 'logo' ? set.files.find((f) => f.role === 'vector-dark' && f.path.toLowerCase().endsWith('.svg')) : undefined;
    const darkText = darkEntry ? await readSetSvg(darkEntry.path) : null;

    const stem = `${ref.creativeSlug}-v${n}-${format.replace(/[^a-z0-9]+/gi, '-')}`;
    const written: string[] = [];
    const removeWritten = async () => { for (const f of written) await rm(join(ref.projectDir, ...f.split('/')), { force: true }).catch(() => {}); };
    let file = '';
    let darkFile: string | null = null;
    try {
      file = `assets/${await saveGeneratedFile(ref.projectDir, 'brand', `${stem}.svg`, Buffer.from(svgText, 'utf8'))}`;
      written.push(file);
      if (darkText !== null) {
        darkFile = `assets/${await saveGeneratedFile(ref.projectDir, 'brand', `${stem}-dark.svg`, Buffer.from(darkText, 'utf8'))}`;
        written.push(darkFile);
      }
    } catch (err) {
      await removeWritten();
      throw err;
    }
    const source = { kind: 'manual' as const, ref: `creative:${ref.creativeSlug}/v${n}` };
    const library = new LibraryStore(ref.projectDir, ctx.media);
    const store = new BrandStore(ref.projectDir);
    const newIds: string[] = [];
    /** The logos this call demoted (ids): put back if the registration fails below. */
    let demotedIds: string[] = [];
    const undo = <L extends { id: string }>(logos: L[]): L[] => logos.map((l) => (demotedIds.includes(l.id) ? { ...l, variant: body.data.variant } : l));
    try {
      await store.updateReadableKit((kit) => {
        demotedIds = kit.logos.filter((l) => l.variant === body.data.variant).map((l) => l.id);
        const taken = new Set(kit.logos.map((l) => l.id));
        const freeId = (base: string) => {
          const idStem = base.slice(0, 56).replace(/-+$/, '');
          let id = idStem;
          for (let k = 2; taken.has(id); k++) id = `${idStem}-${k}`;
          taken.add(id);
          newIds.push(id);
          return id;
        };
        // Decision 784: the new logo takes the chosen variant; one already holding it steps down (primary → secondary,
        // icon → other), so the kit never has two primary logos or two icons (with a negative: one per background).
        const demoted = body.data.variant === 'primary' ? 'secondary' as const : 'other' as const;
        const logos = kit.logos.map((l) => (l.variant === body.data.variant ? { ...l, variant: demoted } : l));
        const added = darkFile === null
          ? [{ id: freeId(`logo-${ref.creativeSlug}-v${n}`), file, variant: body.data.variant, background: 'any' as const, source }]
          : [
            { id: freeId(`logo-${ref.creativeSlug}-v${n}`), file, variant: body.data.variant, background: 'light' as const, source },
            { id: freeId(`logo-${ref.creativeSlug}-v${n}-dark`), file: darkFile, variant: body.data.variant, background: 'dark' as const, source },
          ];
        return { ...kit, logos: [...logos, ...added] };
      });
    } catch (err) {
      // The kit refused (full, unreadable): nothing is left half done, the copies go.
      await removeWritten();
      throw err;
    }
    try {
      await library.registerAssets(written.map((f) => ({ file: f.slice('assets/'.length), origin: 'generated' as const, sourceUrl: null, description: '', tags: ['brand', 'logo'] })));
    } catch (err) {
      await store.updateReadableKit((kit) => ({ ...kit, logos: undo(kit.logos.filter((l) => !newIds.includes(l.id))) })).catch(() => {});
      await removeWritten();
      throw err;
    }
    // The kit and the file are written either way; a commit that fails is reported, not undone (the next kit change commits it).
    let committed = true;
    if (ctx.git) committed = await ctx.git.commitAll(ref.projectDir, t().jobs.brandKitCommit).then(() => true, () => false);
    ctx.broadcast?.({ type: 'library', project: ref.projectSlug });
    ctx.broadcast?.({ type: 'brand', project: ref.projectSlug });
    return { file, ...(darkFile !== null ? { dark: darkFile } : {}), variant: body.data.variant, committed };
  });

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return sendConfinedFile(reply, ref.store.dir(ref.creativeSlug), req.params['*'] ?? '', ['outputs/', 'work/.feedback/']);
  });
}
