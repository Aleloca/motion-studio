import type { FastifyInstance } from 'fastify';
import { linkedCodebaseSchema, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { checkCodebases } from '../codebases.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

const body = z.object({ name: z.string().optional(), description: z.string().max(2000).optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });

export function registerProjectRoutes(app: FastifyInstance, ctx: { requireWorkspace: () => WorkspaceStore; jobKeyOf: (root: string, slug: string) => string; broadcast: (m: ServerMessage) => void }) {
  app.put<{ Params: { slug: string } }>('/api/projects/:slug', async (req) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) throw new WorkspaceError(400, 'Richiesta non valida');
    const ws = ctx.requireWorkspace();
    const project = await ws.updateProject(req.params.slug, parsed.data);
    ctx.broadcast({ type: 'project', project: req.params.slug });
    return { slug: req.params.slug, project, jobKey: ctx.jobKeyOf(ws.root, req.params.slug) };
  });
  app.get<{ Params: { slug: string } }>('/api/projects/:slug/codebases', async (req) => {
    const project = await ctx.requireWorkspace().getProject(req.params.slug);
    return checkCodebases(project.linkedCodebases);
  });
}
