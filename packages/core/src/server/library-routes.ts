import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import type { BrandService } from '../brand/brand-analysis.ts';
import type { Git } from '../git.ts';
import { JsonFileError } from '../json-file.ts';
import { LibraryStore } from '../library/library-store.ts';
import { saveUploads } from '../library/upload.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';

export interface LibraryRoutesContext { requireWorkspace: () => WorkspaceStore; brand: BrandService; media: MediaTools; git: Git; broadcast: (m: ServerMessage) => void }

const assetPatch = z.object({ description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const refPatch = z.object({ note: z.string().max(2000).optional(), useForBrand: z.boolean().optional() });
const filesBody = z.object({ files: z.array(z.string()).min(1).max(500) });
const describeBody = z.object({ files: z.array(z.string()).max(500).optional() });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, 'Richiesta non valida'); return r.data; };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerLibraryRoutes(app: FastifyInstance, ctx: LibraryRoutesContext) {
  const project = async (slug: string) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    return { ws, projectDir, lib: new LibraryStore(projectDir, ctx.media), ref: { root: ws.root, projectSlug: slug, projectDir } };
  };
  const done = async (projectDir: string, slug: string, msg: string) => {
    await ctx.git.commitAll(projectDir, msg);
    ctx.broadcast({ type: 'library', project: slug });
  };

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/assets', async (req) => {
    const { lib } = await project(req.params.slug);
    try { return { assets: await lib.listAssets(), error: null, unregistered: await lib.unregisteredAssets() }; }
    catch (e) { if (e instanceof JsonFileError) return { assets: [], error: e.message, unregistered: [] }; throw e; }
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets', async (req, reply) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.listAssets(); // corrupt assets.json → 422 before any file is written
    const saved = await saveUploads(req, lib.dir('assets'));
    const assets = await lib.registerAssets(saved.map((file) => ({ file, origin: 'upload' as const })));
    await done(projectDir, req.params.slug, `Carica ${saved.length} asset`);
    return reply.status(201).send({ assets });
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets/register', async (req) => {
    const { files } = parse(filesBody, req.body);
    const { lib, projectDir } = await project(req.params.slug);
    const assets = await lib.registerAssets(files.map((file) => ({ file, origin: 'upload' as const })));
    await done(projectDir, req.params.slug, 'Registra asset');
    return { assets };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets/describe', async (req, reply) => {
    const { files } = parse(describeBody, req.body);
    const { ref } = await project(req.params.slug);
    return reply.status(202).send(await ctx.brand.describeAssets(ref, files));
  });

  app.patch<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    const entry = await lib.updateAsset(req.params['*'], parse(assetPatch, req.body));
    await done(projectDir, req.params.slug, `Aggiorna asset ${entry.file}`);
    return entry;
  });

  app.delete<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.removeAsset(req.params['*']);
    await done(projectDir, req.params.slug, `Elimina asset ${req.params['*']}`);
    return { ok: true };
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/references', async (req) => {
    const { lib } = await project(req.params.slug);
    try { return { references: await lib.listReferences(), error: null }; }
    catch (e) { if (e instanceof JsonFileError) return { references: [], error: message(e) }; throw e; }
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/references', async (req, reply) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.listReferences();
    const saved = await saveUploads(req, lib.dir('references'));
    const references = await lib.registerReferences(saved);
    await done(projectDir, req.params.slug, `Carica ${saved.length} riferimenti`);
    return reply.status(201).send({ references });
  });

  app.patch<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/references/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    const entry = await lib.updateReference(req.params['*'], parse(refPatch, req.body));
    await done(projectDir, req.params.slug, `Aggiorna riferimento ${entry.file}`);
    return entry;
  });

  app.delete<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/references/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.removeReference(req.params['*']);
    await done(projectDir, req.params.slug, `Elimina riferimento ${req.params['*']}`);
    return { ok: true };
  });

  app.get<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/files/*', async (req, reply) => {
    const { projectDir } = await project(req.params.slug);
    return sendConfinedFile(reply, projectDir, req.params['*'] ?? '', ['assets/', 'references/']);
  });
}
