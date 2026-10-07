import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { briefSchema, pinSchema, type CreativeDetail } from '@motion-studio/shared';
import { z } from 'zod';
import { CreativeStore } from '../creatives/creative-store.ts';
import { creativeJobKey, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

export interface CreativeRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  media: MediaTools;
  openPath: (p: string) => Promise<void>;
  isJobActive: (key: string) => boolean;
}

const turnBody = z.object({ text: z.string().max(10_000).optional(), pins: z.array(pinSchema).max(50).optional() });
const createBody = z.object({ title: z.string(), brief: briefSchema, generate: z.boolean().optional() });
const editBody = z.object({ title: z.string().optional(), brief: briefSchema.optional() });
const SERVED_PREFIXES = [`outputs${sep}`, `work${sep}.feedback${sep}`];

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, `Richiesta non valida: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Marks as interrupted the creatives left in `working` by a previous run, in every readable project. */
export async function recoverWorkspace(ws: WorkspaceStore): Promise<void> {
  for (const p of await ws.listProjects()) {
    if (p.ok) await new CreativeStore(ws.projectDir(p.slug)).recoverInterrupted().catch(() => []);
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

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/creatives', async (req, reply) => {
    const body = parse(createBody, req.body);
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const store = new CreativeStore(ws.projectDir(req.params.slug));
    const { slug, creative } = await store.create({ title: body.title, brief: body.brief });
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
    if (ctx.isJobActive(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug))) {
      throw new WorkspaceError(409, 'Attendi la fine della generazione in corso prima di modificare il brief');
    }
    return ref.store.update(ref.creativeSlug, { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.brief ? { brief: body.brief } : {}) });
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
    if (!dir || !(await stat(dir).catch(() => null))?.isDirectory()) throw new WorkspaceError(404, 'Cartella degli output non trovata');
    await ctx.openPath(dir);
    return { ok: true };
  });

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const base = ref.store.dir(ref.creativeSlug);
    const rel = normalize(req.params['*'] ?? ''); // Fastify already decoded the wildcard: never decode twice
    const notFound = () => reply.status(404).send({ error: 'File non trovato' });
    if (!rel || isAbsolute(rel) || rel.split(sep).includes('..') || !SERVED_PREFIXES.some((p) => rel.startsWith(p))) return notFound();
    const info = await lstat(`${base}${sep}${rel}`).catch(() => null);
    if (!info?.isFile()) return notFound();
    const real = await realpath(`${base}${sep}${rel}`).catch(() => null);
    const realBase = await realpath(base).catch(() => base);
    if (!real || relative(realBase, real).startsWith('..')) return notFound();
    return reply.sendFile(rel, base);
  });
}
