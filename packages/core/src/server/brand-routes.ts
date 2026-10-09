import type { FastifyInstance } from 'fastify';
import { EMPTY_BRAND_KIT, type BrandOverview, type ProposalActivity, type ServerMessage } from '@motion-studio/shared';
import { join } from 'node:path';
import { z } from 'zod';
import { brandJobKey, type BrandService } from '../brand/brand-analysis.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { readProposalActivity } from '../brand/proposal-activity.ts';
import type { Git } from '../git.ts';
import { JsonFileError } from '../json-file.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface BrandRoutesContext { requireWorkspace: () => WorkspaceStore; brand: BrandService; media: MediaTools; git: Git; broadcast: (m: ServerMessage) => void }

const sourceBody = z.union([
  z.object({ kind: z.literal('website'), url: z.string() }),
  z.object({ kind: z.literal('image'), file: z.string() }),
]);
const applyBody = z.object({ acceptedIds: z.array(z.string()).max(500), applyGuidelines: z.boolean() });
const analyzeBody = z.object({ sourceIds: z.array(z.string()).optional() });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequest); return r.data; };

export function registerBrandRoutes(app: FastifyInstance, ctx: BrandRoutesContext) {
  const project = async (slug: string) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    return { ws, projectDir, store: new BrandStore(projectDir), ref: { root: ws.root, projectSlug: slug, projectDir } };
  };
  const done = async (projectDir: string, slug: string, msg: string) => {
    await ctx.git.commitAll(projectDir, msg);
    ctx.broadcast({ type: 'brand', project: slug });
  };

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/brand', async (req): Promise<BrandOverview> => {
    const { ws, store } = await project(req.params.slug);
    let kit = EMPTY_BRAND_KIT; let kitError: string | null = null;
    try { kit = await store.readKit(); } catch (e) { if (!(e instanceof JsonFileError)) throw e; kitError = e.message; }
    let sources: BrandOverview['sources'] = []; let sourcesError: string | null = null;
    try { sources = await store.readSources(); } catch (e) { if (!(e instanceof JsonFileError)) throw e; sourcesError = e.message; }
    return { kit, kitError, guidelines: await store.readGuidelines(), sources, sourcesError, proposals: await store.listProposals(), jobKey: brandJobKey(ws.root, req.params.slug) };
  });

  app.put<{ Params: { slug: string }; Body: { kit?: unknown } }>('/api/projects/:slug/brand/kit', async (req) => {
    const { store, projectDir } = await project(req.params.slug);
    const kit = await store.replaceReadableKit(req.body?.kit); // a corrupt file on disk → 422, never overwritten from the UI
    await done(projectDir, req.params.slug, t().jobs.brandKitCommit);
    return kit;
  });

  app.put<{ Params: { slug: string }; Body: { text?: unknown } }>('/api/projects/:slug/brand/guidelines', async (req) => {
    if (typeof req.body?.text !== 'string') throw new WorkspaceError(400, t().errors.textMissing);
    const { store, projectDir } = await project(req.params.slug);
    await store.writeGuidelines(req.body.text);
    await done(projectDir, req.params.slug, t().jobs.guidelinesCommit);
    return { ok: true };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/brand/sources', async (req, reply) => {
    const body = parse(sourceBody, req.body);
    const { store, projectDir } = await project(req.params.slug);
    if (body.kind === 'image') {
      if (!body.file.startsWith('references/')) throw new WorkspaceError(400, t().errors.imageMustBeReference);
      await new LibraryStore(projectDir, ctx.media).existingFile('references', body.file.slice('references/'.length));
    }
    const source = await store.addSource(body);
    await done(projectDir, req.params.slug, t().jobs.addSourceCommit);
    return reply.status(201).send(source);
  });

  app.delete<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/sources/:id', async (req) => {
    const { store, projectDir } = await project(req.params.slug);
    await store.removeSource(req.params.id);
    await done(projectDir, req.params.slug, t().jobs.removeSourceCommit);
    return { ok: true };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/brand/analyze', async (req, reply) => {
    const { sourceIds } = parse(analyzeBody, req.body);
    const { store, ref } = await project(req.params.slug);
    const lib = new LibraryStore(ref.projectDir, ctx.media);
    const refs = await lib.listReferences(); // a corrupt references.json surfaces as 422
    const exists = (file: string) => lib.existingFile('references', file).then(() => true, () => false);
    const usable = new Set<string>();
    for (const r of refs) if (r.useForBrand && await exists(r.file)) usable.add(`references/${r.file}`);
    // Image sources whose reference is gone from disk or excluded from the brand are dropped; usable references are added.
    const drop: string[] = [];
    for (const s of await store.readSources()) {
      if (s.kind !== 'image' || s.file === null || usable.has(s.file)) continue;
      const file = s.file.slice('references/'.length);
      if (refs.some((r) => r.file === file && !r.useForBrand) || !(await exists(file))) drop.push(s.file);
    }
    // Persist the change even when the analysis is then refused (409/400).
    if (await store.syncImageSources([...usable], drop)) await done(ref.projectDir, req.params.slug, t().jobs.syncSourcesCommit);
    return reply.status(202).send(await ctx.brand.analyze(ref, sourceIds));
  });

  app.post<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/proposals/:id/apply', async (req) => {
    const { acceptedIds, applyGuidelines } = parse(applyBody, req.body);
    const { ref } = await project(req.params.slug);
    return ctx.brand.applyProposal(ref, req.params.id, acceptedIds, applyGuidelines);
  });

  /**
   * Read-only: what ran automatically during an analysis (its `auto_approved` events and Bash tool calls), from the
   * proposal's log.jsonl, confined to the proposal folder and capped (see proposal-activity.ts).
   */
  app.get<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/proposals/:id/activity', async (req): Promise<ProposalActivity> => {
    const { projectDir, store } = await project(req.params.slug);
    if (!/^p-\d{8}-\d{6}(-\d+)?$/.test(req.params.id)) throw new WorkspaceError(400, t().errors.invalidProposalId({ id: req.params.id }));
    return readProposalActivity(join(projectDir, 'brand'), store.proposalDir(req.params.id));
  });

  app.post<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/proposals/:id/discard', async (req) => {
    const { ref } = await project(req.params.slug);
    return ctx.brand.discardProposal(ref, req.params.id);
  });
}
