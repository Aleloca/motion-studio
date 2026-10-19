import { rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AssetEntry, ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import type { BrandService } from '../brand/brand-analysis.ts';
import { BrandStore } from '../brand/brand-store.ts';
import type { Git } from '../git.ts';
import { JsonFileError } from '../json-file.ts';
import { LibraryStore } from '../library/library-store.ts';
import { saveUploads } from '../library/upload.ts';
import { assetWaveform } from '../library/asset-meta.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';
import { t } from '../i18n.ts';

export interface LibraryRoutesContext { requireWorkspace: () => WorkspaceStore; brand: BrandService; media: MediaTools; git: Git; broadcast: (m: ServerMessage) => void }

const assetPatch = z.object({ name: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const refPatch = z.object({ note: z.string().max(2000).optional(), useForBrand: z.boolean().optional() });
const filesBody = z.object({ files: z.array(z.string()).min(1).max(500) });
const describeBody = z.object({ files: z.array(z.string()).max(500).optional() });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequest); return r.data; };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerLibraryRoutes(app: FastifyInstance, ctx: LibraryRoutesContext) {
  const project = async (slug: string) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    return { ws, projectDir, lib: new LibraryStore(projectDir, ctx.media), ref: { root: ws.root, projectSlug: slug, projectDir } };
  };
  const done = async (projectDir: string, slug: string, msg: string, brandToo = false) => {
    await ctx.git.commitAll(projectDir, msg);
    ctx.broadcast({ type: 'library', project: slug });
    if (brandToo) ctx.broadcast({ type: 'brand', project: slug });
  };
  /**
   * Report 44: the project's icon chosen from the image `from` follows it: to its new name `to`, or back to automatic when it
   * was deleted (null). Best effort: the asset change already went through, so a failure here is only logged.
   */
  const followIcon = async (ws: WorkspaceStore, slug: string, from: string, to: string | null) => {
    try {
      const icon = (await ws.getProject(slug)).icon;
      if (typeof icon !== 'object' || icon.asset !== from) return;
      await ws.updateProject(slug, { icon: to === null ? null : { asset: to } });
      ctx.broadcast({ type: 'project', project: slug });
    } catch (e) {
      console.warn(`Motion Studio: the project icon of ${slug} did not follow ${from}: ${message(e)}`);
    }
  };
  /** Saved files whose registration failed must not stay behind as unregistered leftovers. */
  const registerOrRemove = async <T>(dir: string, saved: string[], register: () => Promise<T>): Promise<T> => {
    try { return await register(); }
    catch (err) { await Promise.all(saved.map((n) => rm(join(dir, n), { force: true }))); throw err; }
  };
  /** A reference that is gone or excluded from the brand must not stay an image source of the analysis. */
  const dropImageSource = async (projectDir: string, file: string) => {
    try { return await new BrandStore(projectDir).removeImageSource(`references/${file}`); }
    catch (e) { if (e instanceof JsonFileError) return false; throw e; } // corrupt sources.json: the analyze route reports it
  };

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/assets', async (req) => {
    const { lib } = await project(req.params.slug);
    try {
      // Entries from before the metadata existed get it once (stored in assets.json); a failure here never hides the list.
      const filled = await lib.fillMissingMeta().catch(() => null);
      return { assets: filled?.assets ?? await lib.listAssets(), error: null, unregistered: await lib.unregisteredAssets() };
    }
    catch (e) { if (e instanceof JsonFileError) return { assets: [], error: e.message, unregistered: [] }; throw e; }
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets', async (req, reply) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.listAssets(); // corrupt assets.json → 422 before any file is written
    const saved = await saveUploads(req, lib.dir('assets'));
    const assets = await registerOrRemove(lib.dir('assets'), saved, () => lib.registerAssets(saved.map((file) => ({ file, origin: 'upload' as const }))));
    await done(projectDir, req.params.slug, t().jobs.uploadAssetsCommit({ count: saved.length }));
    return reply.status(201).send({ assets });
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets/register', async (req) => {
    const { files } = parse(filesBody, req.body);
    const { lib, projectDir } = await project(req.params.slug);
    const assets = await lib.registerAssets(files.map((file) => ({ file, origin: 'upload' as const })));
    await done(projectDir, req.params.slug, t().jobs.registerAssetsCommit);
    return { assets };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets/describe', async (req, reply) => {
    const { files } = parse(describeBody, req.body);
    const { ref } = await project(req.params.slug);
    return reply.status(202).send(await ctx.brand.describeAssets(ref, files));
  });

  app.patch<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const { ws, lib, projectDir } = await project(req.params.slug);
    const { name, ...patch } = parse(assetPatch, req.body);
    let file = req.params['*'];
    let renamed: { from: string; brand: boolean; creatives: string[] } | null = null;
    let entry: AssetEntry | undefined;
    try {
      if (name !== undefined) {
        const r = await lib.renameAsset(file, name);
        if (r.entry.file !== file) renamed = { from: file, brand: r.brand, creatives: r.creatives };
        file = r.entry.file;
        entry = r.entry;
      }
      if (Object.keys(patch).length > 0 || !entry) entry = await lib.updateAsset(file, patch);
    } finally {
      // A rename that went through is committed even when the rest of the request fails.
      if (renamed) await done(projectDir, req.params.slug, t().jobs.renameAssetCommit({ from: renamed.from, to: file }), renamed.brand).catch(() => {});
    }
    if (!renamed) await done(projectDir, req.params.slug, t().jobs.updateAssetCommit({ file: entry!.file }));
    // Report 44: the project's icon chosen from this image follows its new name (never failing the rename, review 7).
    else await followIcon(ws, req.params.slug, renamed.from, file);
    for (const creative of renamed?.creatives ?? []) ctx.broadcast({ type: 'creative', project: req.params.slug, creative });
    return entry;
  });

  app.get<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const rest = req.params['*'];
    if (!rest.endsWith('/waveform')) throw new WorkspaceError(404, t().errors.fileNotFoundShort);
    const file = rest.slice(0, -'/waveform'.length);
    const { lib, projectDir } = await project(req.params.slug);
    const entry = (await lib.listAssets()).find((a) => a.file === file);
    if (!entry) throw new WorkspaceError(404, t().errors.assetNotFound({ file }));
    if (entry.kind !== 'audio') throw new WorkspaceError(422, t().errors.waveformUnavailable);
    return { peaks: await assetWaveform({ media: ctx.media, projectDir }, file, await lib.existingFile('assets', file)) };
  });

  app.delete<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const { ws, lib, projectDir } = await project(req.params.slug);
    await lib.removeAsset(req.params['*']);
    await done(projectDir, req.params.slug, t().jobs.deleteAssetCommit({ file: req.params['*'] }));
    // Review 5: an icon chosen from this image goes back to automatic.
    await followIcon(ws, req.params.slug, req.params['*'], null);
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
    const references = await registerOrRemove(lib.dir('references'), saved, () => lib.registerReferences(saved));
    await done(projectDir, req.params.slug, t().jobs.uploadReferencesCommit({ count: saved.length }));
    return reply.status(201).send({ references });
  });

  app.patch<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/references/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    const entry = await lib.updateReference(req.params['*'], parse(refPatch, req.body));
    const dropped = entry.useForBrand ? false : await dropImageSource(projectDir, entry.file);
    await done(projectDir, req.params.slug, t().jobs.updateReferenceCommit({ file: entry.file }), dropped);
    return entry;
  });

  app.delete<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/references/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.removeReference(req.params['*']);
    const dropped = await dropImageSource(projectDir, req.params['*']);
    await done(projectDir, req.params.slug, t().jobs.deleteReferenceCommit({ file: req.params['*'] }), dropped);
    return { ok: true };
  });

  app.get<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/files/*', async (req, reply) => {
    const { projectDir } = await project(req.params.slug);
    const rel = posix.normalize(req.params['*'] ?? '.');
    const lower = rel.toLowerCase();
    if (lower === 'assets/assets.json' || lower === 'references/references.json') return reply.status(404).send({ error: t().errors.fileNotFoundShort });
    return sendConfinedFile(reply, projectDir, req.params['*'] ?? '', ['assets/', 'references/']);
  });
}
