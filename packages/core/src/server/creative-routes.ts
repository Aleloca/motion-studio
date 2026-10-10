import { lstat, realpath } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { briefSchema, checkLink, defaultLinks, effectiveLinks, formatLabel, isExportDate, issuesText, linkedCodebaseSchema, pinSchema, type Brief, type CreativeDetail, type FormatPreset, type RecentCreative, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { brandJobKey } from '../brand/brand-analysis.ts';
import { assertCodebasesOutside, normalizeCodebaseList } from '../codebases.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import { exportPicks, exportVersion } from '../creatives/export.ts';
import { formatSummaries } from '../creatives/format-summary.ts';
import { withLazyHashes } from '../creatives/output-hashes.ts';
import { creativeJobKey, PICK_RETRY_AFTER_SEC, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { completeGitignore, sweepProject } from '../project-maintenance.ts';
import { CodedError, expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';
import { currentLocale, t } from '../i18n.ts';

export interface CreativeRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  media: MediaTools;
  openPath: (p: string) => Promise<void>;
  isJobActive: (key: string) => boolean;
  /** Tells the clients a creative changed (e.g. lazy hashes finished after the GET answered). */
  broadcast?: (msg: ServerMessage) => void;
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
export async function recoverWorkspace(ws: WorkspaceStore, isJobActive: (key: string) => boolean = () => false): Promise<void> {
  for (const p of await ws.listProjects()) {
    if (!p.ok) continue;
    const dir = ws.projectDir(p.slug);
    await new CreativeStore(dir).recoverInterrupted((slug) => isJobActive(creativeJobKey(ws.root, p.slug, slug))).catch((err: Error) => {
      console.warn(`Motion Studio: creative recovery failed in project ${p.slug}: ${err.message}`);
    });
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
    // The same hashed versions as the creative GET, so a follower's ★ here is the one the dialog showed.
    const { versions, complete } = await withLazyHashes({ projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir, versions: await ref.store.readVersions(ref.creativeSlug) });
    // A follower's version is decided on hashes: never on partial ones (a refusal now would only mean "not hashed yet").
    // The hashing goes on; the client retries after Retry-After, as for a ★ pick.
    if (!complete && body.follow !== undefined) throw new CodedError(503, t().errors.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
    return exportPicks({ ...common, versions, picks: (body.picks ?? {}) as Record<string, number>, follow: body.follow as string[] | Record<string, number> | undefined,
      links: effectiveLinks(creative.brief.links, creative.brief.formats), storedPicks: creative.exportPicks });
  });

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return sendConfinedFile(reply, ref.store.dir(ref.creativeSlug), req.params['*'] ?? '', ['outputs/', 'work/.feedback/']);
  });
}
