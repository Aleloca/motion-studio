import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  briefSchema, briefWriteSchema, issuesText, isStorePackFormat, packFileFormats, packSlotOf, renderProblems, storePackSchema, type JobSummary, type LocalizationRow, type VersionEntry,
} from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import { pendingByMember, planGroupExport, resolveGroupLocalized, type GroupPlanItem } from '../creatives/variant-export.ts';
import { VariantGroupService } from '../creatives/variant-group.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { checkDestination, pendingRenders, plainName, resolveLocalizedItems, type ExportItem } from '../creatives/export.ts';
import type { RenderJobService } from '../creatives/render-jobs.ts';
import { reconcileRenders, renderFileMatches } from '../creatives/render-stamps.ts';
import { FormatCatalog, findPreset } from '../formats/format-catalog.ts';
import { assertLocalesInBrief, checkedLocale } from '../localization/validate.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { storePackBrief, verifyScreens } from '../store-pack/brief.ts';
import { exportStorePack, type PackFile } from '../store-pack/pack-export.ts';
import { CodedError, expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { localeAssetsCheck } from './creative-routes.ts';

/**
 * App store pack routes (Phase 12, Task 6, spec §4):
 * - `POST /api/projects/:slug/creatives/store-pack` `{ title, storePack, locales?, generate? }` → 201 `{ slug, creative, job }`:
 *   the brief is built by the core from the choices (`storePackBrief`), every app screen checked in the project library.
 * - `POST …/creatives/:c/versions/:n/store-pack/export` `{ destination, locales?, formats? }` → `{ folder, written, failed, rendered? }`:
 *   the pack of version n (spec §4.3). Formats without a current render are rendered first (the render pipeline, store steps
 *   included); a render made now that has problems is not copied (I2, Ruling J) and is listed in `failed`; so is a language
 *   without a translation, a render that failed, and every file that fails its store check. The rest is exported.
 */
export interface StorePackRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  renders: RenderJobService;
  media: MediaTools;
}

const createBody = z.object({
  title: z.string().max(200), storePack: storePackSchema, locales: briefSchema.shape.locales, generate: z.boolean().optional(),
}).strict();
const exportBody = z.object({
  destination: z.string().min(1).max(4096),
  /** Languages to export (tags of the brief); absent: every language of the brief. */
  locales: z.array(z.string().min(1).max(40)).min(1).max(11).optional(),
  /** Report 48: the pack's formats to export (instance ids of this pack); absent: the whole pack. */
  formats: z.array(z.string().min(1).max(80)).min(1).max(80).optional(),
}).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }));
  return r.data;
}

/**
 * Report 48: the pack formats the export takes, in the brief's order: all of them, or the selection, which may only name
 * formats of this pack (anything else, a hand-picked store format included, is refused before anything is written).
 */
function selectedFormats(packFormats: string[], selection: string[] | undefined): string[] {
  if (!selection) return packFormats;
  const foreign = [...new Set(selection.filter((f) => !packFormats.includes(f)))];
  if (foreign.length > 0) throw new CodedError(400, t().variants.storePack.foreignFormat({ list: foreign.join(', ') }), 'store-pack-foreign-format');
  return packFormats.filter((f) => selection.includes(f));
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function registerStorePackRoutes(app: FastifyInstance, ctx: StorePackRoutesContext): void {
  const presets = async () => (await new FormatCatalog(ctx.requireWorkspace().root).load()).presets;

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/creatives/store-pack', async (req, reply) => {
    const body = parse(createBody, req.body);
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const projectDir = ws.projectDir(req.params.slug);
    await verifyScreens(projectDir, ctx.media, body.storePack);
    const made = storePackBrief(body.storePack, { locale: currentLocale(), presets: await presets(), ...(body.locales ? { locales: body.locales } : {}) });
    // Phase 14: the pack records the instances it created (here the slots' own ids).
    const brief = parse(briefWriteSchema, { ...made, storePack: { ...body.storePack, instances: made.formats } });
    const store = new CreativeStore(projectDir);
    const { slug, creative } = await store.create({ title: body.title, brief });
    const ref = { root: ws.root, projectSlug: req.params.slug, projectDir, creativeSlug: slug };
    const job = body.generate ? await ctx.turns.start(ref) : null;
    return reply.status(201).send({ slug, creative: job ? await store.get(slug) : creative, job });
  });

  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/store-pack/export', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const projectDir = ws.projectDir(req.params.slug);
    const store = new CreativeStore(projectDir);
    await store.assertOpenable(req.params.c); // phase 15: a real or orphan sister too, never a hand-made `x~b`
    const creativeDir = store.dir(req.params.c);
    const ref: CreativeRef & { store: CreativeStore } = { root: ws.root, projectSlug: req.params.slug, projectDir, creativeSlug: req.params.c, store };
    const raw = (req.body ?? {}) as { destination?: unknown };
    if (typeof raw.destination !== 'string' || !raw.destination.trim()) throw new CodedError(400, t().export.invalidDestination, 'export-invalid-destination');
    const body = parse(exportBody, req.body);
    const creative = await store.get(ref.creativeSlug);
    const pack = creative.brief.storePack;
    if (!pack) throw new CodedError(409, t().variants.storePack.notStorePack, 'not-store-pack');
    const n = Number(req.params.n);
    const readVersion = async () => (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!Number.isInteger(n) || n < 1 || !(await readVersion())) throw new WorkspaceError(404, t().errors.versionNotFound);
    const destination = await checkDestination(expandHome(body.destination.trim()), ws.root);
    const catalog = await presets();
    const c = t().variants.storePack.check;

    // Languages: the brief's primary is the primary-language file, the others come from the localized renders (Task 3).
    const locales = creative.brief.locales;
    const tags = body.locales ? [...new Set(body.locales.map((x) => checkedLocale(x, currentLocale())))] : locales ? [locales.primary, ...locales.extra] : [];
    const primary = locales?.primary;
    assertLocalesInBrief(creative.brief, tags, currentLocale());
    const includeSource = !locales || tags.includes(primary!);
    const others = locales ? tags.filter((x) => x !== primary) : [];

    // The pack's formats in this version, in the brief's order.
    const base = (await readVersion())!;
    const inVersion = (v: VersionEntry, f: string) => v.outputs.some((o) => o.format === f) || v.compositions?.some((x) => x.format === f) === true;
    // A pack format of the brief that this version lacks (the brief changed after it) is listed, never dropped silently (I1).
    // Phase 14: the pack's own instances only (`storePackFormats`); a store preset picked by hand in the same creative is not exported.
    // The pack owns its `instances` (the slots' ids in a pack made before); captions, numbers and folders follow the slot.
    const slotOf = packSlotOf(pack, catalog);
    const owned = new Set(slotOf.keys());
    const packFormats = selectedFormats(packFileFormats(creative.brief, catalog), body.formats);
    // Store instances of the brief that are not the pack's (picked by hand): not exported, and said so.
    const notInPack = creative.brief.formats.filter((f) => !owned.has(f) && isStorePackFormat(f))
      .map((f) => { const label = creative.brief.formatLabels?.[f]; return label ? `${f} (${label})` : f; });
    const formats = packFormats.filter((f) => inVersion(base, f));
    const absent = packFormats.filter((f) => !inVersion(base, f));
    const sizeOf = (f: string) => { const p = findPreset(catalog, f); return { width: p?.width ?? 0, height: p?.height ?? 0 }; };
    const itemsOf = (v: VersionEntry): ExportItem[] => formats.map((format) => {
      const o = v.outputs.find((x) => x.format === format);
      return { format, n, file: o?.file ?? '', width: o?.width ?? sizeOf(format).width, height: o?.height ?? sizeOf(format).height };
    });

    const files: PackFile[] = [];
    const rendered: Array<{ version: number; formats: string[]; locale?: string }> = [];
    const jobError = (jobs: Array<JobSummary | null>) => jobs.find((j) => j?.state === 'failed')?.error ?? null;

    // Primary language: renders first (the store steps run in the render), then the files.
    await reconcileRenders({ projectDir, store, creativeSlug: ref.creativeSlug }).catch(() => false);
    let version = (await readVersion())!;
    if (includeSource) {
      const pending = await pendingRenders(creativeDir, [version], itemsOf(version));
      let error: string | null = null;
      if (pending.size > 0) {
        await ctx.turns.runLocked(ref, () => ctx.turns.assertNotDiscarded(ref)); // residual fix (decisions log 866)
        // A render that cannot start (no browser, …) fails these files only: what is already rendered is still exported.
        error = await ctx.renders.renderAndWait(ref, pending).then(jobError, (e: unknown) => (e instanceof Error ? e.message : String(e)));
        rendered.push({ version: n, formats: [...(pending.get(n) ?? [])] });
        version = (await readVersion())!;
      }
      const still = await pendingRenders(creativeDir, [version], itemsOf(version));
      for (const format of absent) files.push({ format, ...(primary ? { locale: primary } : {}), ...sizeOf(format), failure: c.notInVersion({ n }) });
      for (const it of itemsOf(version)) {
        const f: PackFile = { format: it.format, ...(primary ? { locale: primary } : {}), ...sizeOf(it.format) };
        const problems = pending.get(n)?.includes(it.format) ? renderProblems(version, it.format) : [];
        if (still.get(n)?.includes(it.format) || !plainName(it.file)) f.failure = error ? c.renderFailed({ reason: error }) : c.notRendered;
        else if (problems.length > 0) f.failure = c.renderProblems({ list: problems.join('; ') });
        else f.file = it.file;
        files.push(f);
      }
    }

    // Other languages: the current localized render of each format, rendered first when missing or outdated.
    if (others.length > 0) {
      const matches = (vn: number, file: string, sha: string) => renderFileMatches(projectDir, creativeDir, ref.creativeSlug, vn, file, sha);
      const assets = localeAssetsCheck(projectDir, creativeDir);
      const resolve = async () => resolveLocalizedItems(creativeDir, await store.readVersions(ref.creativeSlug), itemsOf(version), others, matches, assets);
      let r = await resolve();
      const errors = new Map<string, string>();
      const now = r.pending.get(n);
      if (now) {
        await ctx.turns.runLocked(ref, () => ctx.turns.assertNotDiscarded(ref)); // residual fix (decisions log 866)
        // One job per language, so a language whose translation needs "render anyway" does not stop the others.
        for (const locale of now.locales) {
          const fs = formats.filter((f) => !r.items.some((x) => x.format === f && x.locale === locale) && !r.missing.some((x) => x.format === f && x.locale === locale));
          try {
            const job = await ctx.renders.renderLocalesAndWait(ref, n, fs, [locale], false);
            if (job?.state === 'failed') errors.set(locale, job.error ?? '');
          } catch (e) {
            errors.set(locale, e instanceof Error ? e.message : String(e));
          }
          rendered.push({ version: n, formats: fs, locale });
        }
        r = await resolve();
      }
      for (const locale of others) {
        for (const format of absent) files.push({ format, locale, ...sizeOf(format), failure: c.notInVersion({ n }) });
        for (const format of formats) {
          const f: PackFile = { format, locale, ...sizeOf(format) };
          const item = r.items.find((x) => x.format === format && x.locale === locale);
          const renderedNow = now?.locales.includes(locale) && now.formats.includes(format);
          if (r.missing.some((x) => x.format === format && x.locale === locale)) f.failure = c.noTranslation({ locale });
          else if (!item) f.failure = errors.has(locale) ? c.renderFailed({ reason: errors.get(locale)! }) : c.notRendered;
          else if (renderedNow && item.problems?.length) f.failure = c.renderProblems({ list: item.problems.join('; ') });
          else { f.file = item.file; f.width = item.width; f.height = item.height; }
          files.push(f);
        }
      }
    }

    // The checks always use the format's size from the catalog (the store's size), never the size the render recorded.
    for (const f of files) Object.assign(f, sizeOf(f.format));
    // From here the pack's code names a file by its slot (caption, number, folder): translate the instances.
    for (const f of files) f.format = slotOf.get(f.format) ?? f.format;
    const result = await exportStorePack({
      creativeDir, n, destination, title: creative.title, storePack: pack, presets: catalog, files, order: creative.brief.formats.filter((f) => owned.has(f)).map((f) => slotOf.get(f)!), notInPack,
      probe: (file) => (ctx.media.available ? ctx.media.probe(file) : Promise.resolve(null)), date: localDay(),
    });
    return rendered.length > 0 ? { ...result, rendered } : result;
  });
  /**
   * Decision 1333: the files of a variant group's pack, `GET …/creatives/:c/store-pack/group-files` → `{ formats, labels }`: the
   * host's pack formats (the brief the group's pack export reads), whichever member asks, so a member whose brief lags behind
   * never lists other files than the export takes. 409 outside a group or without a pack.
   */
  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/store-pack/group-files', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const projectDir = ws.projectDir(req.params.slug);
    const store = new CreativeStore(projectDir);
    await store.assertOpenable(req.params.c);
    const ref: CreativeRef & { store: CreativeStore } = { root: ws.root, projectSlug: req.params.slug, projectDir, creativeSlug: req.params.c, store };
    const svc = new VariantGroupService({ store, turns: ctx.turns });
    await planGroupExport(svc, store, ref); // 409 outside a group
    const creative = await store.get((await svc.resolve(ref)).host.creativeSlug);
    const pack = creative.brief.storePack;
    if (!pack) throw new CodedError(409, t().variants.storePack.notStorePack, 'not-store-pack');
    // Decision 1338: the same list as the export routes and the single creative's dialog (`packFileFormats`).
    const formats = packFileFormats(creative.brief, await presets());
    const labels = Object.fromEntries(formats.flatMap((f) => { const l = creative.brief.formatLabels?.[f]; return l ? [[f, l]] : []; }));
    return { formats, labels };
  });
  /**
   * Phase 15 (spec §6): the store pack of a variant group, `POST …/creatives/:c/store-pack/export-group` `{ destination, locales?, formats? }`.
   * For each pack format the file comes from the member and version of the group selection (the ★, or the default rule on
   * variant A). Translations stay inside their variant: each format's localized renders are those of the member the selection
   * picked, at that version. As in the single pack, a composition or a translation with no current render is rendered first, in
   * its own member (decisions log 854, revised); "no translation", a render that failed and one rendered now with problems are
   * listed in `failed`, like any pack file that cannot be exported.
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/store-pack/export-group', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const projectDir = ws.projectDir(req.params.slug);
    const store = new CreativeStore(projectDir);
    await store.assertOpenable(req.params.c);
    const ref: CreativeRef & { store: CreativeStore } = { root: ws.root, projectSlug: req.params.slug, projectDir, creativeSlug: req.params.c, store };
    const raw = (req.body ?? {}) as { destination?: unknown };
    if (typeof raw.destination !== 'string' || !raw.destination.trim()) throw new CodedError(400, t().export.invalidDestination, 'export-invalid-destination');
    const body = parse(exportBody, req.body);
    const svc = new VariantGroupService({ store, turns: ctx.turns });
    let plan = await planGroupExport(svc, store, ref); // 409 outside a group
    const hostRef = (await svc.resolve(ref)).host;
    const creative = await store.get(hostRef.creativeSlug);
    const pack = creative.brief.storePack;
    if (!pack) throw new CodedError(409, t().variants.storePack.notStorePack, 'not-store-pack');
    const destination = await checkDestination(expandHome(body.destination.trim()), ws.root);
    const catalog = await presets();
    const c = t().variants.storePack.check;

    const locales = creative.brief.locales;
    const tags = body.locales ? [...new Set(body.locales.map((x) => checkedLocale(x, currentLocale())))] : locales ? [locales.primary, ...locales.extra] : [];
    const primary = locales?.primary;
    assertLocalesInBrief(creative.brief, tags, currentLocale());
    const includeSource = !locales || tags.includes(primary!);
    const others = locales ? tags.filter((x) => x !== primary) : [];

    const slotOf = packSlotOf(pack, catalog);
    const owned = new Set(slotOf.keys());
    const packFormats = selectedFormats(packFileFormats(creative.brief, catalog), body.formats);
    const notInPack = creative.brief.formats.filter((f) => !owned.has(f) && isStorePackFormat(f))
      .map((f) => { const label = creative.brief.formatLabels?.[f]; return label ? `${f} (${label})` : f; });
    const sizeOf = (f: string) => { const p = findPreset(catalog, f); return { width: p?.width ?? 0, height: p?.height ?? 0 }; };
    const packPlan = () => plan.filter((p) => packFormats.includes(p.format));
    const jobError = (jobs: Array<JobSummary | null>) => jobs.find((j) => j?.state === 'failed')?.error ?? null;

    const files: PackFile[] = [];
    const rendered: Array<{ version: number; formats: string[]; slug: string; locale?: string }> = [];
    const errors = new Map<string, string>();
    const withProblems = new Set<string>();
    const key = (p: Pick<GroupPlanItem, 'slug' | 'format'>) => `${p.slug}\0${p.format}`;
    if (includeSource) {
      const pending = packPlan().filter((p) => p.state === 'needs-render');
      for (const [slug, versions] of pendingByMember(pending)) {
        const error = await ctx.renders.renderAndWait({ ...ref, creativeSlug: slug }, versions).then(jobError, (e: unknown) => (e instanceof Error ? e.message : String(e)));
        for (const [version, formats] of versions) {
          rendered.push({ version, formats, slug });
          if (error) for (const f of formats) errors.set(`${slug}\0${f}`, error);
        }
      }
      if (pending.length > 0) {
        plan = await planGroupExport(svc, store, ref);
        const fresh = new Set(pending.map(key));
        for (const p of packPlan()) {
          if (p.state !== 'ready' || !fresh.has(key(p))) continue;
          const v = (await store.readVersions(p.slug)).find((x) => x.n === p.version);
          if (v && renderProblems(v, p.format).length > 0) withProblems.add(key(p));
        }
      }
      for (const format of packFormats) {
        const p = packPlan().find((x) => x.format === format);
        const f: PackFile = { format, ...(primary ? { locale: primary } : {}), ...sizeOf(format) };
        if (!p) f.failure = c.notInGroup;
        else if (p.state !== 'ready') f.failure = errors.has(key(p)) ? c.renderFailed({ reason: errors.get(key(p))! }) : c.notRendered;
        else if (withProblems.has(key(p))) f.failure = c.renderProblems({ list: renderProblems((await store.readVersions(p.slug)).find((x) => x.n === p.version)!, p.format).join('; ') });
        else { f.file = p.file; f.dir = p.creativeDir; f.n = p.version; }
        files.push(f);
      }
    }
    if (others.length > 0) {
      const matches = (slug: string, vn: number, file: string, sha: string) => renderFileMatches(projectDir, store.dir(slug), slug, vn, file, sha);
      const checks = { matches, assetsOk: (slug: string, vn: number, row: LocalizationRow) => localeAssetsCheck(projectDir, store.dir(slug))(vn, row) };
      const locPlan = () => packPlan().filter((p) => !withProblems.has(key(p)));
      let r = await resolveGroupLocalized(locPlan(), store, others, checks);
      // As the single pack: a translation without a current render is rendered first, in its own member, one job per member
      // and language (never with "render anyway": one that needs it is listed with the reason, as the single pack does).
      const localeErrors = new Map<string, string>();
      const renderedNow: Array<{ slug: string; version: number; formats: string[]; locale: string }> = [];
      for (const p of r.pending) {
        try {
          const job = await ctx.renders.renderLocalesAndWait({ ...ref, creativeSlug: p.slug }, p.n, p.formats, [p.locale], false);
          if (job?.state === 'failed') localeErrors.set(`${p.slug}\0${p.locale}`, job.error ?? '');
        } catch (e) {
          localeErrors.set(`${p.slug}\0${p.locale}`, e instanceof Error ? e.message : String(e));
        }
        renderedNow.push({ slug: p.slug, version: p.n, formats: [...p.formats], locale: p.locale });
        rendered.push({ version: p.n, formats: [...p.formats], slug: p.slug, locale: p.locale });
      }
      if (r.pending.length > 0) r = await resolveGroupLocalized(locPlan(), store, others, checks);
      for (const locale of others) {
        for (const format of packFormats) {
          const f: PackFile = { format, locale, ...sizeOf(format) };
          const p = packPlan().find((x) => x.format === format);
          const item = r.items.find((x) => x.format === format && x.locale === locale);
          const miss = r.unavailable.find((x) => x.plan.format === format && x.locale === locale);
          const now = p !== undefined && renderedNow.some((x) => x.slug === p.slug && x.version === p.version && x.locale === locale && x.formats.includes(format));
          const error = p !== undefined ? localeErrors.get(`${p.slug}\0${locale}`) : undefined;
          if (!p) f.failure = c.notInGroup;
          else if (miss?.state === 'no-translation') f.failure = c.noTranslation({ locale });
          else if (!item) f.failure = error ? c.renderFailed({ reason: error }) : c.notRendered;
          else if (now && item.problems?.length) f.failure = c.renderProblems({ list: item.problems.join('; ') });
          else { f.file = item.file; f.dir = item.creativeDir ?? p.creativeDir; f.n = item.n; }
          files.push(f);
        }
      }
    }
    for (const f of files) Object.assign(f, sizeOf(f.format));
    for (const f of files) f.format = slotOf.get(f.format) ?? f.format;
    const result = await exportStorePack({
      creativeDir: store.dir(hostRef.creativeSlug), n: Math.max(0, ...packPlan().map((p) => p.version)), group: true, destination, title: creative.title, storePack: pack, presets: catalog, files,
      order: creative.brief.formats.filter((f) => owned.has(f)).map((f) => slotOf.get(f)!), notInPack,
      probe: (file) => (ctx.media.available ? ctx.media.probe(file) : Promise.resolve(null)), date: localDay(),
    });
    return rendered.length > 0 ? { ...result, rendered } : result;
  });
}
