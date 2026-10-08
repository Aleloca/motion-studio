import { lstat, realpath } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { briefSchema, issuesText, linkedCodebaseSchema, pinSchema, type CreativeDetail, type RecentCreative } from '@motion-studio/shared';
import { z } from 'zod';
import { brandJobKey } from '../brand/brand-analysis.ts';
import { assertCodebasesOutside, normalizeCodebaseList } from '../codebases.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import { exportVersion } from '../creatives/export.ts';
import { creativeJobKey, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { completeGitignore, sweepProject } from '../project-maintenance.ts';
import { expandHome, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';
import { currentLocale, t } from '../i18n.ts';

export interface CreativeRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  media: MediaTools;
  openPath: (p: string) => Promise<void>;
  isJobActive: (key: string) => boolean;
}

const isInsideDir = (p: string, base: string | null) => Boolean(base && p.startsWith(base.endsWith(sep) ? base : base + sep));

const turnBody = z.object({ text: z.string().max(10_000).optional(), pins: z.array(pinSchema).max(50).optional() });
const createBody = z.object({ title: z.string(), brief: briefSchema, generate: z.boolean().optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });
const editBody = z.object({ title: z.string().optional(), brief: briefSchema.optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });

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
    const created = await store.create({ title: body.title, brief: body.brief });
    const slug = created.slug;
    const creative = linkedCodebases ? await store.update(slug, { linkedCodebases }) : created.creative;
    const ref = { root: ws.root, projectSlug: req.params.slug, projectDir: ws.projectDir(req.params.slug), creativeSlug: slug };
    const job = body.generate ? await ctx.turns.start(ref) : null;
    return reply.status(201).send({ slug, creative: job ? await store.get(slug) : creative, job });
  });

  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c', async (req): Promise<CreativeDetail> => {
    const ref = await refOf(req.params.slug, req.params.c);
    return {
      slug: ref.creativeSlug,
      creative: await ref.store.get(ref.creativeSlug),
      versions: await ref.store.readVersions(ref.creativeSlug),
      jobKey: creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug),
    };
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
    const body = parse(turnBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const text = body.text?.trim() ?? '';
    const pins = body.pins ?? [];
    const job = await ctx.turns.start(ref, text || pins.length ? { text, pins } : undefined);
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
    return exportVersion({ creativeDir: ref.store.dir(ref.creativeSlug), version, destination, slug: ref.creativeSlug, title: creative.title, formats: rawFormats as string[] | undefined, forbiddenRoot: ref.root });
  });

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return sendConfinedFile(reply, ref.store.dir(ref.creativeSlug), req.params['*'] ?? '', ['outputs/', 'work/.feedback/']);
  });
}
