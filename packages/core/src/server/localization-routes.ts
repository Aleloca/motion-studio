import { basename } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  COMPOSITION_LIMITS, localizableEntries, messages,
  type Composition, type EditorCompositionView, type FormatPreset, type Locale, type LocaleTag, type Localization, type LocalizationIssue, type LocalizationRow, type VersionEntry,
} from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { editorCompositionView } from '../creatives/editor-staging.ts';
import { emptyOverlay, finishOverlay, overlayAssetPaths, resolveFallbackFont, instanceComposition, localizedComposition, readOverlay, rowAssetHashes, attachedFontHashes, setLocalizationRow, voiceRootsOf, writeOverlay } from '../localization/store.ts';
import { issueFields } from '../localization/issues.ts';
import { checkedInstance, checkedLocale } from '../localization/validate.ts';
import type { PreviewService } from '../creatives/previews.ts';
import type { LocalizeService } from '../localization/localize-turn.ts';
import type { MediaTools } from '../media/media-tools.ts';
import type { InstallIo } from '../providers/google-fonts.ts';
import type { HttpDeps } from '../providers/http.ts';
import { CodedError, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';

/**
 * Localization routes (Phase 12, spec §3.3): the overlays of a version, one overlay, its manual edit (origin `editor`, under
 * the creative's lock, the checks run again, no new version), and the localized composition for the preview. Every
 * `:locale` and `:instanceId` segment is checked (`checkedLocale`, `checkedInstance`) before any path is built.
 */

export interface LocalizationRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  media: MediaTools;
  presets: () => Promise<FormatPreset[]>;
  /** The Google Fonts network for the fallback fonts (tests: a fake fetch). */
  fontsHttp: HttpDeps;
  fontsIo?: InstallIo;
  /** Localize turns (Task 4): `POST …/versions/:n/localize`. */
  localize: LocalizeService;
  /** The live previews (a localized preview serves the overlay's fonts and voices). */
  previews: PreviewService;
}

const clipId = z.string().max(COMPOSITION_LIMITS.id);
const text = z.string().max(COMPOSITION_LIMITS.text);
/**
 * A manual edit: only the fields the spec lets a user change. `null` removes an entry. `voice`: keep the original voice or
 * mute it for this language (a translated voice is made by the core, Task 4, never sent by the client).
 */
export const localizationEditSchema = z.strictObject({
  texts: z.record(clipId, text.nullable()).optional(),
  params: z.record(z.string().max(200), text.nullable()).optional(),
  fit: z.record(clipId, z.number().min(0.7).max(1).nullable()).optional(),
  voice: z.enum(['original', 'muted']).optional(),
});
export type LocalizationEdit = z.infer<typeof localizationEditSchema>;

/** What an overlay GET (and PUT) answers. */
export interface LocalizationView { overlay: Localization; problems: string[]; issues?: LocalizationIssue[]; stale: string[]; voice: LocalizationRow['voice']; origin: LocalizationRow['origin']; hash: string;
  /** PUT only: advisory checks of the localized composition (html layers), as in a turn. */
  warnings?: string[] }

/** Aborts the work of a request whose client went away. */
const abortOnClose = (reply: FastifyReply): AbortSignal => {
  const ac = new AbortController();
  reply.raw.once('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
  return ac.signal;
};

const versionNumber = (raw: string) => (/^\d{1,6}$/.test(raw) ? Number(raw) : 0);

async function versionOf(store: CreativeStore, slug: string, raw: string): Promise<VersionEntry> {
  const n = versionNumber(raw);
  const v = n > 0 ? (await store.readVersions(slug)).find((x) => x.n === n) : undefined;
  if (!v) throw new WorkspaceError(404, t().errors.versionNotFound);
  return v;
}

/** The overlay of a row, still the recorded file; 404 when there is none. */
async function rowOverlay(creativeDir: string, v: VersionEntry, locale: LocaleTag, instanceId: string, ui: Locale): Promise<{ row: LocalizationRow; overlay: Localization }> {
  const row = v.localizations?.find((r) => r.locale === locale && r.instanceId === instanceId);
  const read = row ? await readOverlay(creativeDir, v.n, locale, instanceId) : null;
  if (!row || !read || read.hash !== row.hash) {
    throw new CodedError(404, messages(ui).variants.localizationNotFound({ locale, format: instanceId, n: v.n }), 'localization-not-found');
  }
  return { row, overlay: read.overlay };
}

const viewOf = (row: LocalizationRow, overlay: Localization): LocalizationView =>
  ({ overlay, problems: row.problems ?? [], ...(row.issues ? { issues: row.issues } : {}), stale: row.stale, voice: row.voice, origin: row.origin, hash: row.hash });

/**
 * The localized composition of `format` in a version, for the preview (`GET …/compositions/:format?locale=xx`): the editor
 * view with `applyLocalization` applied (stale ids keep the source text, Review Focus 2), plus the language's stale ids and
 * problems so the UI flags them.
 */
export async function localizedCompositionView(o: { projectDir: string; creativeDir: string; version: VersionEntry; format: string; rawLocale: unknown; presets: FormatPreset[]; locale: Locale }):
  Promise<EditorCompositionView & { localization: { locale: LocaleTag; stale: string[]; problems: string[]; issues?: LocalizationIssue[]; voice: LocalizationRow['voice'] } }> {
  const tag = checkedLocale(o.rawLocale, o.locale);
  const instanceId = checkedInstance(o.format, o.version, o.locale);
  const view = await editorCompositionView({ projectDir: o.projectDir, creativeDir: o.creativeDir, version: o.version, format: instanceId, presets: o.presets, locale: o.locale });
  const { row, overlay } = await rowOverlay(o.creativeDir, o.version, tag, instanceId, o.locale);
  const composition = localizedComposition(view.composition, overlay, row);
  if (!composition) throw new CodedError(409, messages(o.locale).variants.localizationUnusable({ locale: tag, format: instanceId }), 'localization-unusable');
  return { ...view, composition, localization: { locale: tag, stale: row.stale, problems: row.problems ?? [], ...(row.issues ? { issues: row.issues } : {}), voice: row.voice } };
}

/** Applies a manual edit to `overlay` (sources always from the composition, never from the client); the ids whose fit the core picks. */
function applyEdit(overlay: Localization, edit: LocalizationEdit, entries: ReturnType<typeof localizableEntries>, ui: Locale): { overlay: Localization; chooseFit: Set<string> } {
  const v = messages(ui).variants;
  const mismatch = (id: string) => new CodedError(400, v.localizationMismatch({ entry: id.slice(0, 100) }), 'localization-mismatch');
  const texts = new Map(entries.texts.map((x) => [x.clipId, x.text] as const));
  const params = new Map(entries.params.map((x) => [x.key, x.text] as const));
  const out: Localization = { ...overlay, texts: { ...overlay.texts }, params: { ...overlay.params }, fit: { ...overlay.fit } };
  const chooseFit = new Set<string>();
  for (const [id, value] of Object.entries(edit.texts ?? {})) {
    if (!texts.has(id)) throw mismatch(id);
    if (value === null) { delete out.texts[id]; delete out.fit[id]; continue; }
    out.texts[id] = { source: texts.get(id)!, text: value };
    if (!edit.fit || !Object.hasOwn(edit.fit, id)) chooseFit.add(id);
  }
  for (const [key, value] of Object.entries(edit.params ?? {})) {
    if (!params.has(key)) throw mismatch(key);
    if (value === null) delete out.params[key];
    else out.params[key] = { source: params.get(key)!, text: value };
  }
  for (const [id, f] of Object.entries(edit.fit ?? {})) {
    if (!texts.has(id)) throw mismatch(id);
    if (f === null) { delete out.fit[id]; chooseFit.delete(id); continue; }
    if (!Object.hasOwn(out.texts, id)) throw mismatch(id);
    out.fit[id] = f;
  }
  return { overlay: out, chooseFit };
}

export function registerLocalizationRoutes(app: FastifyInstance, ctx: LocalizationRoutesContext): void {
  const refOf = async (slug: string, creativeSlug: string): Promise<CreativeRef & { store: CreativeStore }> => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    store.dir(creativeSlug);
    return { root: ws.root, projectSlug: slug, projectDir, creativeSlug, store };
  };
  const base = '/api/projects/:slug/creatives/:c/versions/:n/localizations';
  type P = { slug: string; c: string; n: string };
  type PL = P & { locale: string; instanceId: string };

  // A localize turn on an existing version (Task 4): checked, then queued (job kind `localize`, the agents' lane).
  app.post<{ Params: P }>('/api/projects/:slug/creatives/:c/versions/:n/localize', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const job = await ctx.localize.start(ref, versionNumber(req.params.n), req.body);
    return reply.status(202).send({ jobId: job.id });
  });

  // The fallback fonts and translated voices of a localized preview (Phase 12, Task 5): the live preview session `token` serves
  // exactly the files the row recorded a hash for (and the overlay uses), verified against it at every request.
  app.post<{ Params: PL }>(`${base}/:locale/:instanceId/preview-assets`, async (req) => {
    const ui = currentLocale();
    const ref = await refOf(req.params.slug, req.params.c);
    const body = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(req.body);
    if (!body.success) throw new CodedError(400, messages(ui).variants.localizationInvalid({ detail: 'token' }), 'localization-invalid');
    const v = await versionOf(ref.store, ref.creativeSlug, req.params.n);
    const tag = checkedLocale(req.params.locale, ui);
    const instanceId = checkedInstance(req.params.instanceId, v, ui);
    const { row, overlay } = await rowOverlay(ref.store.dir(ref.creativeSlug), v, tag, instanceId, ui);
    const files = await ctx.previews.attachLocale({ projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug, n: v.n,
        folder: (v.compositions?.find((c) => c.format === instanceId)?.dir ?? `compositions/${instanceId}`).slice('compositions/'.length) },
      body.data.token, overlayAssetPaths(overlay, row), row.assetHashes ?? {}, ui);
    return { files };
  });

  app.get<{ Params: P }>(base, async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const v = await versionOf(ref.store, ref.creativeSlug, req.params.n);
    const creative = await ref.store.get(ref.creativeSlug);
    return { entries: v.localizations ?? [], available: creative.brief.locales?.extra ?? [] };
  });

  app.get<{ Params: PL }>(`${base}/:locale/:instanceId`, async (req) => {
    const ui = currentLocale();
    const ref = await refOf(req.params.slug, req.params.c);
    const v = await versionOf(ref.store, ref.creativeSlug, req.params.n);
    const tag = checkedLocale(req.params.locale, ui);
    const instanceId = checkedInstance(req.params.instanceId, v, ui);
    const { row, overlay } = await rowOverlay(ref.store.dir(ref.creativeSlug), v, tag, instanceId, ui);
    return viewOf(row, overlay);
  });

  app.put<{ Params: PL }>(`${base}/:locale/:instanceId`, async (req, reply): Promise<LocalizationView> => {
    const ui = currentLocale();
    const va = messages(ui).variants;
    const ref = await refOf(req.params.slug, req.params.c);
    const tag = checkedLocale(req.params.locale, ui);
    const parsed = localizationEditSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CodedError(400, va.localizationInvalid({ detail: `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim().slice(0, 300) }), 'localization-invalid');
    }
    const edit = parsed.data;
    const signal = abortOnClose(reply);
    // Checked again under the lock; first here, so no font is downloaded for a language the creative does not have.
    if (!(await ref.store.get(ref.creativeSlug)).brief.locales?.extra.includes(tag)) throw new CodedError(409, va.localeNotInBrief({ tag }), 'locale-not-in-brief');
    // The fallback font may be downloaded: before the creative's lock, so a turn or an edit never waits on the network.
    const fallback = await resolveFallbackFont({ projectDir: ref.projectDir, http: ctx.fontsHttp, media: ctx.media, ...(ctx.fontsIo ? { io: ctx.fontsIo } : {}) }, tag, signal);
    return ctx.turns.runLocked(ref, async () => {
      if (ctx.turns.turnActive(ref)) throw new CodedError(409, va.localizationBusy, 'localization-busy');
      const slug = ref.creativeSlug;
      const creativeDir = ref.store.dir(slug);
      const v = await versionOf(ref.store, slug, req.params.n);
      const instanceId = checkedInstance(req.params.instanceId, v, ui);
      const creative = await ref.store.get(slug);
      if (!creative.brief.locales?.extra.includes(tag)) throw new CodedError(409, va.localeNotInBrief({ tag }), 'locale-not-in-brief');
      const presets = await ctx.presets();
      const ic = await instanceComposition(creativeDir, v, instanceId, presets);
      if (!ic) throw new CodedError(409, messages(ui).errors.compositionUnusable({ format: instanceId, n: v.n }), 'composition-unusable');
      const row = v.localizations?.find((r) => r.locale === tag && r.instanceId === instanceId);
      const read = row ? await readOverlay(creativeDir, v.n, tag, instanceId) : null;
      const current = read && row && read.hash === row.hash ? read.overlay : emptyOverlay(tag, instanceId);
      const { overlay, chooseFit } = applyEdit(current, edit, localizableEntries(ic.composition), ui);
      const voice: LocalizationRow['voice'] = edit.voice ?? row?.voice ?? (Object.keys(overlay.voices).length > 0 ? 'translated' : 'original');
      // The browser's measure when a renderer is free (final wave P5): it decides the core's fit and the overflow of the texts
      // it measures, as in a turn; otherwise the estimate does. The render's own measure stays the last check.
      const measure = (c: Composition, deadline: AbortSignal) => ctx.previews.measureTextOverflow({ ref: { projectDir: ref.projectDir, creativeDir, creativeSlug: slug, n: v.n },
        folder: basename(ic.compDir), preset: ic.preset, composition: c, signal: AbortSignal.any([signal, deadline]), noWait: true });
      const done = await finishOverlay({
        overlay, base: ic, voice, chooseFit, uiLocale: ui, projectDir: ref.projectDir, voiceRoots: voiceRootsOf(ic, ref.projectDir),
        fallback, measure,
      });
      const hash = await writeOverlay(creativeDir, v.n, done.overlay);
      const assetHashes = rowAssetHashes({ overlay: done.overlay, ...(row?.assetHashes ? { old: row.assetHashes } : {}),
        fresh: await attachedFontHashes(ref.projectDir, fallback, row?.assetHashes) });
      const next: LocalizationRow = {
        locale: tag, instanceId, hash, origin: 'editor', stale: done.stale, voice,
        // A voice choice made here replaces the fallback the turn recorded.
        ...(row?.voiceFallback && !edit.voice ? { voiceFallback: row.voiceFallback } : {}), ...(row?.noScript ? { noScript: row.noScript } : {}),
        ...(assetHashes ? { assetHashes } : {}),
        ...issueFields(done.issues), ...(row?.render ? { render: row.render } : {}),
      };
      await setLocalizationRow(ref.store, slug, v.n, next);
      ctx.turns.changed(ref);
      return { ...viewOf(next, done.overlay), ...(done.warnings.length ? { warnings: done.warnings } : {}) };
    });
  });
}
