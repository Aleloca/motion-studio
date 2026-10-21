import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assetKindOf, transcriptionChoiceSchema, type VideoAnalysisView } from '@motion-studio/shared';
import type { ProjectRef, VideoAnalysisService } from '../analysis/video-analysis.ts';
import { readSidecar, replaceBody, writeSidecar } from '../analysis/sidecar.ts';
import { hashVideo } from '../analysis/video-hash.ts';
import type { Git } from '../git.ts';
import { t } from '../i18n.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { CodedError, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

const fileSchema = z.string().min(1).max(1024);
const startSchema = z.object({ file: fileSchema, overwrite: z.boolean().optional() }).strict();
const confirmSchema = z.object({ file: fileSchema, density: z.enum(['full', 'reduced']) }).strict();
const bodySchema = z.object({ file: fileSchema, body: z.string().max(1024 * 1024) }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new WorkspaceError(400, i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'invalid body');
  }
  return r.data;
}

/**
 * Decision 1468: the video analyses of a project (`/api/projects/:slug/video-analyses`): list, one video's view, Analizza /
 * Rianalizza (an edited sidecar asks first: 409 `analysis-edited` without `overwrite`, decision 1480), the long video's
 * confirmation, the user's edit of the body, and stop. An unknown project or video answers 404, a file that is not a video
 * of the library 400 `analysis-not-video`.
 */
export function registerAnalysisRoutes(app: FastifyInstance, ctx: { requireWorkspace: () => WorkspaceStore; analyses: VideoAnalysisService; media: MediaTools; git: Git }) {
  const refOf = async (slug: string): Promise<ProjectRef> => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    return { root: ws.root, projectSlug: slug, projectDir: ws.projectDir(slug) };
  };
  /** `file` is a video of the project library (`assets/…`), present on disk. */
  const videoOf = async (ref: ProjectRef, file: unknown): Promise<string> => {
    if (typeof file !== 'string' || !file.startsWith('assets/') || file.startsWith('assets/.') || assetKindOf(file) !== 'video') {
      throw new CodedError(400, t().errors.analysisNotVideo, 'analysis-not-video');
    }
    const lib = new LibraryStore(ref.projectDir, ctx.media);
    const abs = await lib.existingFile('assets', file.slice('assets/'.length)).catch(() => null);
    if (!abs || !(await hashVideo(abs).catch(() => null))) throw new CodedError(404, t().errors.analysisGone, 'analysis-not-found');
    return file;
  };
  type P = { Params: { slug: string } };

  app.get<P>('/api/projects/:slug/video-analyses', async (req): Promise<VideoAnalysisView[]> => {
    const ref = await refOf(req.params.slug);
    const assets = await new LibraryStore(ref.projectDir, ctx.media).listAssets();
    return ctx.analyses.list(ref, assets.filter((a) => a.kind === 'video').map((a) => `assets/${a.file}`));
  });
  app.get<P & { Querystring: { file?: string } }>('/api/projects/:slug/video-analyses/view', async (req) => {
    const ref = await refOf(req.params.slug);
    return ctx.analyses.view(ref, await videoOf(ref, req.query.file));
  });
  app.post<P>('/api/projects/:slug/video-analyses', async (req, reply) => {
    const ref = await refOf(req.params.slug);
    const body = parse(startSchema, req.body);
    const file = await videoOf(ref, body.file);
    const sidecar = await readSidecar(ref.projectDir, file);
    if (sidecar?.header.edited && !body.overwrite) throw new CodedError(409, t().errors.analysisEdited, 'analysis-edited');
    const [view] = await ctx.analyses.ensure(ref, [file], { from: 'library', overwrite: true });
    return reply.status(202).send(view);
  });
  app.post<P>('/api/projects/:slug/video-analyses/confirm-long', async (req) => {
    const ref = await refOf(req.params.slug);
    const body = parse(confirmSchema, req.body);
    return ctx.analyses.confirmLong(ref, await videoOf(ref, body.file), body.density);
  });
  // Spec §6: the answer to the transcription dialog (409 when nothing asks, or the choice cannot be honoured).
  app.post<P>('/api/projects/:slug/video-analyses/transcription-choice', async (req) => {
    const ref = await refOf(req.params.slug);
    const body = parse(transcriptionChoiceSchema, req.body);
    const view = await ctx.analyses.chooseTranscription(ref, { ...body, file: await videoOf(ref, body.file) });
    if (!view) throw new CodedError(409, t().errors.transcriptionNothingAsks, 'transcription-not-asked');
    return view;
  });
  app.put<P>('/api/projects/:slug/video-analyses/body', async (req) => {
    const ref = await refOf(req.params.slug);
    const body = parse(bodySchema, req.body);
    const file = await videoOf(ref, body.file);
    const sidecar = await readSidecar(ref.projectDir, file);
    if (!sidecar) throw new CodedError(404, t().errors.notFound, 'analysis-not-found');
    let text: string;
    try { text = replaceBody(sidecar.text, body.body); } catch (err) { throw new WorkspaceError(400, err instanceof Error ? err.message : String(err)); }
    await writeSidecar(ref.projectDir, file, text);
    await ctx.git.commitAll(ref.projectDir, t().videoAnalysis.editedCommit({ file: file.slice(file.lastIndexOf('/') + 1) })).catch(() => null);
    return ctx.analyses.view(ref, file);
  });
  // Decision 1478: the first turn's wait for its videos' analyses, and Salta.
  type PC = { Params: { slug: string; c: string } };
  app.get<PC>('/api/projects/:slug/creatives/:c/analysis-wait', async (req) => ({ files: ctx.analyses.waitingFiles(await refOf(req.params.slug), req.params.c) }));
  app.post<PC>('/api/projects/:slug/creatives/:c/analysis-wait/skip', async (req, reply) => {
    if (!ctx.analyses.skip(await refOf(req.params.slug), req.params.c)) throw new CodedError(404, t().errors.analysisNothingWaits, 'analysis-wait-none');
    return reply.status(204).send();
  });
  app.delete<P & { Querystring: { file?: string } }>('/api/projects/:slug/video-analyses', async (req) => {
    const ref = await refOf(req.params.slug);
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    if (!file.startsWith('assets/')) throw new CodedError(400, t().errors.analysisNotVideo, 'analysis-not-video');
    return { cancelled: ctx.analyses.cancel(ref, file) };
  });
}
