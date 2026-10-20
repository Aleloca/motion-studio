import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { briefContextSchema, briefFormSaveSchema, briefMessageSchema } from '@motion-studio/shared';
import type { BriefProjectRef, BriefSessionService } from '../brief/brief-session.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

/** A body checked with `schema`; the first problem is the 400's text. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new WorkspaceError(400, i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'invalid body');
  }
  return r.data;
}

/**
 * Decisions 1421–1422: the brief session's routes (`/api/projects/:slug/brief-session`). An unknown project answers 404, a
 * session id that is not the open one 409 `brief-session-gone`. Stop is the jobs' own route; there is no redirect.
 */
export function registerBriefRoutes(app: FastifyInstance, ctx: { requireWorkspace: () => WorkspaceStore; briefs: BriefSessionService; configDir: string }) {
  const refOf = async (slug: string): Promise<BriefProjectRef> => {
    const ws = ctx.requireWorkspace();
    const project = await ws.getProject(slug);
    return { root: ws.root, projectSlug: slug, projectDir: ws.projectDir(slug), projectName: project.name, projectCodebases: project.linkedCodebases, configDir: ctx.configDir };
  };
  type P = { Params: { slug: string } };
  type PI = { Params: { slug: string; id: string } };

  app.get<P>('/api/projects/:slug/brief-session', async (req) => ctx.briefs.view(await refOf(req.params.slug)));
  app.post<P>('/api/projects/:slug/brief-session', async (req, reply) => {
    const ref = await refOf(req.params.slug);
    return reply.status(201).send(await ctx.briefs.start(ref, parse(briefFormSaveSchema, req.body)));
  });
  app.get<PI>('/api/projects/:slug/brief-session/:id/conversation', async (req) => ctx.briefs.conversation(await refOf(req.params.slug), req.params.id));
  app.post<PI>('/api/projects/:slug/brief-session/:id/messages', async (req, reply) => {
    const ref = await refOf(req.params.slug);
    const out = await ctx.briefs.send(ref, req.params.id, parse(briefMessageSchema, req.body));
    return reply.status(out.outcome === 'started' ? 202 : 200).send(out);
  });
  app.put<PI>('/api/projects/:slug/brief-session/:id/form', async (req) => {
    await ctx.briefs.saveForm(await refOf(req.params.slug), req.params.id, parse(briefFormSaveSchema, req.body));
    return { ok: true };
  });
  app.put<PI>('/api/projects/:slug/brief-session/:id/context', async (req) => ctx.briefs.setContext(await refOf(req.params.slug), req.params.id, parse(briefContextSchema, req.body)));
  app.delete<{ Params: { slug: string; id: string; clientId: string } }>('/api/projects/:slug/brief-session/:id/queue/:clientId', async (req) =>
    ctx.briefs.removeQueued(await refOf(req.params.slug), req.params.id, req.params.clientId));
  app.delete<PI>('/api/projects/:slug/brief-session/:id', async (req, reply) => {
    await ctx.briefs.discard(await refOf(req.params.slug), req.params.id);
    return reply.status(204).send();
  });
}
