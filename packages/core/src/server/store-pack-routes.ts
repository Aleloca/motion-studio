import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  briefSchema, briefWriteSchema, issuesText, renderProblems, storePackSchema, type JobSummary, type VersionEntry,
} from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { checkDestination, pendingRenders, plainName, resolveLocalizedItems, type ExportItem } from '../creatives/export.ts';
import type { RenderJobService } from '../creatives/render-jobs.ts';
import { reconcileRenders, renderFileMatches } from '../creatives/render-stamps.ts';
import { FormatCatalog, findPreset } from '../formats/format-catalog.ts';
import { checkedLocale } from '../localization/validate.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { storePackBrief, verifyScreens } from '../store-pack/brief.ts';
import { exportStorePack, packEntry, type PackFile } from '../store-pack/pack-export.ts';
import { CodedError, expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { localeAssetsCheck } from './creative-routes.ts';

/**
 * App store pack routes (Phase 12, Task 6, spec §4):
 * - `POST /api/projects/:slug/creatives/store-pack` `{ title, storePack, locales?, generate? }` → 201 `{ slug, creative, job }`:
 *   the brief is built by the core from the choices (`storePackBrief`), every app screen checked in the project library.
 * - `POST …/creatives/:c/versions/:n/store-pack/export` `{ destination, locales? }` → `{ folder, written, failed, rendered? }`:
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
}).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }));
  return r.data;
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
    const brief = parse(briefWriteSchema, storePackBrief(body.storePack, { locale: currentLocale(), presets: await presets(), ...(body.locales ? { locales: body.locales } : {}) }));
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
    for (const tag of tags) if (!locales || (tag !== primary && !locales.extra.includes(tag))) throw new CodedError(400, t().variants.localeNotInBrief({ tag }), 'locale-not-in-brief');
    const includeSource = !locales || tags.includes(primary!);
    const others = locales ? tags.filter((x) => x !== primary) : [];

    // The pack's formats in this version, in the brief's order.
    const base = (await readVersion())!;
    const inVersion = (v: VersionEntry, f: string) => v.outputs.some((o) => o.format === f) || v.compositions?.some((x) => x.format === f) === true;
    // A pack format of the brief that this version lacks (the brief changed after it) is listed, never dropped silently (I1).
    const packFormats = creative.brief.formats.filter((f) => packEntry(pack, f, undefined) !== null);
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
    const result = await exportStorePack({
      creativeDir, n, destination, title: creative.title, storePack: pack, presets: catalog, files,
      probe: (file) => (ctx.media.available ? ctx.media.probe(file) : Promise.resolve(null)), date: localDay(),
    });
    return rendered.length > 0 ? { ...result, rendered } : result;
  });
}
