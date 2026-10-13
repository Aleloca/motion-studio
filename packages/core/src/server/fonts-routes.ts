import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BrandFont, ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { BrandStore } from '../brand/brand-store.ts';
import type { Git } from '../git.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { installGoogleFont, type InstallIo } from '../providers/google-fonts.ts';
import type { GoogleFontsCatalog } from '../providers/google-fonts-catalog.ts';
import { ProviderError, type HttpDeps } from '../providers/http.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface FontsRoutesContext {
  requireWorkspace: () => WorkspaceStore; media: MediaTools; git: Git; broadcast: (m: ServerMessage) => void;
  catalog: GoogleFontsCatalog; http: HttpDeps; installIo?: InstallIo;
}

const addBody = z.object({
  family: z.string().trim().min(1).max(60),
  weights: z.array(z.number().int().min(100).max(900)).min(1).max(9),
  italic: z.boolean(),
  role: z.enum(['heading', 'body', 'accent', 'other']),
});
const previewQuery = z.object({ family: z.string().min(1).max(60), weight: z.coerce.number().int().default(400) });
const searchQuery = z.object({ q: z.string().max(80).optional(), category: z.string().max(40).optional(), limit: z.coerce.number().int().optional() });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequest); return r.data; };
/** A provider failure is an answer with its own status, not a 500. */
const asHttp = async <T>(run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (e) { if (e instanceof ProviderError) throw new WorkspaceError(e.status === 400 || e.status === 404 || e.status === 429 ? e.status : 503, e.message); throw e; }
};
/** Aborts the work of a request whose client went away. */
const abortOnClose = (reply: FastifyReply): AbortSignal => {
  const ac = new AbortController();
  reply.raw.once('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
  return ac.signal;
};

export function registerFontsRoutes(app: FastifyInstance, ctx: FontsRoutesContext) {
  app.get('/api/fonts/google', async (req) => {
    const q = parse(searchQuery, req.query);
    return ctx.catalog.search(q);
  });

  // Loaded by FontFace (no headers): exempt from the UI token like the project files; only validated names reach Google.
  app.get('/api/fonts/google/preview', async (req, reply) => {
    const q = parse(previewQuery, req.query);
    const bytes = await asHttp(() => ctx.catalog.preview(q.family, q.weight, abortOnClose(reply)));
    return reply.header('content-type', 'font/woff2').header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff').send(bytes);
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/brand/fonts/google', async (req, reply) => {
    const body = parse(addBody, req.body);
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const projectDir = ws.projectDir(req.params.slug);
    const store = new BrandStore(projectDir);
    await store.readKit(); // a corrupt kit refuses (422) before anything is downloaded
    const signal = abortOnClose(reply);
    const http: HttpDeps = { ...ctx.http, fetch: ((u, i = {}) => ctx.http.fetch(u, { ...i, signal: i.signal ? AbortSignal.any([i.signal, signal]) : signal })) as typeof fetch };
    const { files, fonts } = await asHttp(() => installGoogleFont({ http, projectDir, media: ctx.media, family: body.family, weights: body.weights, italic: body.italic, ...(ctx.installIo ? { io: ctx.installIo } : {}) }));
    const family = body.family.trim();
    const weights = [...new Set(fonts.map((f) => f.weight))].sort((a, b) => a - b);
    // The kit points at the regular file when there is one; the other files are in the library.
    const upright = fonts.map((f, i) => ({ f, i })).filter((x) => !x.f.italic);
    const main = (upright.find((x) => x.f.weight === 400) ?? upright[0])?.i ?? 0;
    const file = `assets/${files[main]!}`;
    let font!: BrandFont;
    try {
      await store.updateReadableKit((kit) => {
        const same = kit.fonts.find((f) => f.family.toLowerCase() === family.toLowerCase());
        if (same) {
          font = { ...same, role: body.role, weights, file, source: { kind: 'manual', ref: null } };
          return { ...kit, fonts: kit.fonts.map((f) => (f === same ? font : f)) };
        }
        const base = `font-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font'}`;
        const ids = new Set(kit.fonts.map((f) => f.id));
        let id = base;
        for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
        font = { id, family, role: body.role, weights, file, source: { kind: 'manual', ref: null } };
        return { ...kit, fonts: [...kit.fonts, font] };
      });
    } catch (e) {
      // The set stays out of the project when the kit cannot take it.
      const lib = new LibraryStore(projectDir, ctx.media);
      for (const f of files) await lib.removeAsset(f).catch(() => {});
      throw e;
    }
    await ctx.git.commitAll(projectDir, t().jobs.addGoogleFontCommit({ family }));
    ctx.broadcast({ type: 'library', project: req.params.slug });
    ctx.broadcast({ type: 'brand', project: req.params.slug });
    return { font, files: files.map((f) => `assets/${f}`) };
  });
}
