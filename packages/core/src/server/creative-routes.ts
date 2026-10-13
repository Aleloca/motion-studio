import type { Git } from '../git.ts';
import { recoverRenameJournal } from '../library/rename-recovery.ts';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { briefSchema, type PinFramesView, checkLink, defaultLinks, effectiveLinks, formatLabel, isExportDate, issuesText, renderProblems, linkedCodebaseSchema, pinSchema, type Brief, type CreativeDetail, type OutputIssue, type FormatPreset, type RecentCreative, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { brandJobKey } from '../brand/brand-analysis.ts';
import { assertCodebasesOutside, normalizeCodebaseList } from '../codebases.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import { exportResolved, exportVersion, pendingRenders, resolveExportPicks } from '../creatives/export.ts';
import { storyboardDir, storyboardSchema, sweepStoryboardTemps, type PreviewService } from '../creatives/previews.ts';
import { readJsonFile } from '../json-file.ts';
import { isRealDirChain } from '../creatives/core-files.ts';
import type { UrlSigner } from './signed-urls.ts';
import { formatSummaries } from '../creatives/format-summary.ts';
import { withLazyHashes } from '../creatives/output-hashes.ts';
import { creativeJobKey, PICK_RETRY_AFTER_SEC, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import type { RenderJobService } from '../creatives/render-jobs.ts';
import { reconcileRenders } from '../creatives/render-stamps.ts';
import { sweepDerivedCaches, sweepEditorStaging } from '../creatives/cache-sweep.ts';
import { editorCompositionView } from '../creatives/editor-staging.ts';
import { directEditBodySchema, type DirectEditService } from '../creatives/direct-edit.ts';
import { sweepProjectRenders } from '../render/render-sweep.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { completeGitignore, sweepProject } from '../project-maintenance.ts';
import { CodedError, expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';
import { currentLocale, t } from '../i18n.ts';

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
}

const isInsideDir = (p: string, base: string | null) => Boolean(base && p.startsWith(base.endsWith(sep) ? base : base + sep));

/** `formats`: the formats the request applies to (spec §2.5); absent or empty: all of them. */
export const turnBodySchema = z.object({ text: z.string().max(10_000).optional(), pins: z.array(pinSchema).max(50).optional(), formats: z.array(z.string().min(1).max(200)).max(100).optional() });
const createBody = z.object({ title: z.string(), brief: briefSchema, generate: z.boolean().optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });
const editBody = z.object({ title: z.string().optional(), brief: briefSchema.optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });
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
});
const linkBody = z.object({ follower: z.string().min(1).max(200), primary: z.string().min(1).max(200).nullable() });
/** A render request (Task 5): `formats` to render (a follower stands for its primary); absent or empty: every primary. */
const renderBody = z.object({ formats: z.array(z.string().min(1).max(200)).max(100).optional() }).strict();
/**
 * A live preview session (Task 5b): the format, and the exact origin of the UI page that embeds the iframe. `renewFrom`
 * (Phase 10b): the session this one renews; the editor's staged files move to the new one when both show the same version
 * and format.
 */
const previewBody = z.object({ format: z.string().min(1).max(200), parentOrigin: z.string().min(1).max(200), renewFrom: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict();
/** Staging a file for an editor draft (Phase 10b): the live preview session, and a library asset or a brand font. */
const stageBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('library'), file: z.string().min(1).max(300) }).strict(),
    z.object({ kind: z.literal('brandFont'), id: z.string().min(1).max(64) }).strict(),
  ]),
}).strict();
const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
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
    const known = brief.formats.map((id) => presets.find((p) => p.id === id)).filter((p): p is FormatPreset => p !== undefined);
    return defaultLinks(known, undefined);
  }
  const links = effectiveLinks(brief.links, brief.formats);
  const e = t().errors;
  const label = (id: string) => { const p = presets.find((x) => x.id === id); return p ? formatLabel(p, currentLocale()) : id; };
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
}

export async function recoverWorkspace(ws: WorkspaceStore, isJobActive: (key: string) => boolean = () => false, ro: RecoverOptions = {}): Promise<void> {
  for (const p of await ws.listProjects()) {
    if (!p.ok) continue;
    const dir = ws.projectDir(p.slug);
    await new CreativeStore(dir).recoverInterrupted((slug) => isJobActive(creativeJobKey(ws.root, p.slug, slug))).catch((err: Error) => {
      console.warn(`Motion Studio: creative recovery failed in project ${p.slug}: ${err.message}`);
    });
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

export function registerCreativeRoutes(app: FastifyInstance, ctx: CreativeRoutesContext): void {
  const catalog = () => new FormatCatalog(ctx.requireWorkspace().root);
  const refOf = async (slug: string, creativeSlug: string): Promise<CreativeRef & { store: CreativeStore }> => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug); // 404 for unknown projects
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    store.dir(creativeSlug); // 400 for invalid slugs
    return { root: ws.root, projectSlug: slug, projectDir, creativeSlug, store };
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
    const links = initialLinks(body.brief, (await catalog().load()).presets);
    const created = await store.create({ title: body.title, brief: { ...body.brief, links } });
    const slug = created.slug;
    const creative = linkedCodebases ? await store.update(slug, { linkedCodebases }) : created.creative;
    const ref = { root: ws.root, projectSlug: req.params.slug, projectDir: ws.projectDir(req.params.slug), creativeSlug: slug };
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
      slug: ref.creativeSlug, creative, versions,
      jobKey: creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug),
      formats: await formatSummaries(creativeDir, creative, versions, (await catalog().load()).presets),
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
    const body = parse(editBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.updateBrief(ref, body);
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
    return reply.status(202).send(await ctx.renders.start(ref, n, body.formats));
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
    const pattern = typeof body.pattern === 'string' ? body.pattern : (await ctx.requireWorkspace().readSettings()).exportNamePattern;
    const common = { creativeDir, destination, slug: ref.creativeSlug, title: creative.title, forbiddenRoot: ref.root, presets, pattern,
      ...(typeof body.date === 'string' ? { now: body.date } : {}),
      label: (id: string) => { const p = presets.find((x) => x.id === id); return p ? formatLabel(p, currentLocale()) : id; } };
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
    if (pending.size > 0) {
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
    const excluded: Array<{ format: string; version: number; problems: string[]; issues: OutputIssue[] }> = [];
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
    const result = await exportResolved(items, common);
    const withProblems = excluded.length ? { ...result, excluded } : result;
    return rendered.length > 0 ? { ...withProblems, rendered } : withProblems;
  });

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
    await reconcileRenders({ projectDir: ref.projectDir, store: ref.store, creativeSlug: ref.creativeSlug }).catch(() => false);
    const { versions, complete } = await withLazyHashes({ projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug) });
    // As for the export: a follower's version is never decided on partial hashes.
    if (!complete && r.data.follow !== undefined) throw new CodedError(503, t().errors.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
    const items = resolveExportPicks({ creativeDir, destination: '/', slug: ref.creativeSlug, versions, picks: (r.data.picks ?? {}) as Record<string, number>,
      follow: r.data.follow as string[] | Record<string, number> | undefined, links: effectiveLinks(creative.brief.links, creative.brief.formats), storedPicks: creative.exportPicks });
    const pending = await pendingRenders(creativeDir, versions, items);
    const renders = [];
    // Answers at once: an active job of that version is reused for the formats it covers and a follow-up job is queued for
    // the rest (I3), so the job returned covers them all.
    for (const [version, formats] of pending) {
      const { job, covers } = await ctx.renders.ensureJob(ref, version, formats, { wait: false });
      renders.push({ version, formats, job, covers });
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
  app.get<{ Params: { slug: string; c: string; n: string; format: string } }>('/api/projects/:slug/creatives/:c/versions/:n/compositions/:format', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = /^\d{1,6}$/.test(req.params.n) ? Number(req.params.n) : 0;
    const version = n > 0 ? (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
    if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
    return editorCompositionView({
      projectDir: ref.projectDir, creativeDir: ref.store.dir(ref.creativeSlug), version, format: req.params.format,
      presets: (await catalog().load()).presets, locale: currentLocale(),
    });
  });

  /**
   * Stages a library asset or a brand font for a draft (Phase 10b): copied, confined, into the staging folder of the live
   * preview session `token` of this creative, and served under that token. An upload goes through the library's own route
   * first, then is staged from the library.
   */
  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/editor/stage', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(stageBody, req.body);
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

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return sendConfinedFile(reply, ref.store.dir(ref.creativeSlug), req.params['*'] ?? '', ['outputs/', 'work/.feedback/']);
  });
}
