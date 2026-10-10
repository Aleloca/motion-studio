import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { linkedCodebaseSchema, type ProjectIntegrity, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { checkCodebases } from '../codebases.ts';
import { inspectGitSafety } from '../git-safety.ts';
import { activeIntegrityStore, type IntegrityChange, type IntegritySnapshot } from '../project-integrity.ts';
import { CodedError, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { t } from '../i18n.ts';

const body = z.object({ name: z.string().optional(), description: z.string().max(2000).optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });

/** Identifies the listed state: each listed path with its kind of change and its current content hash. */
const integrityToken = (files: IntegrityChange[], snapshot: IntegritySnapshot) =>
  createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, f.change, snapshot[f.path] ?? null]))).digest('hex');
const acceptBody = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });

export function registerProjectRoutes(app: FastifyInstance, ctx: { requireWorkspace: () => WorkspaceStore; jobKeyOf: (root: string, slug: string) => string; broadcast: (m: ServerMessage) => void }) {
  const integrityOf = async (slug: string) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const dir = ws.projectDir(slug);
    const status = await activeIntegrityStore().status(dir);
    const gitProblem = await inspectGitSafety(dir);
    const view: ProjectIntegrity = { quarantined: status.quarantined, files: status.files, gitProblem, token: integrityToken(status.files, status.snapshot) };
    return { dir, view, snapshot: status.snapshot };
  };
  /** The project's integrity state (decisions log 141): the quarantine's changed files and any git problem. */
  app.get<{ Params: { slug: string } }>('/api/projects/:slug/integrity', async (req) => (await integrityOf(req.params.slug)).view);
  /**
   * "I made these changes": the user accepts the listed protected files as their own. Refused (409) when the files changed
   * since the list was shown (`token`), and whenever a git problem remains: those are never acceptable, only fixable.
   */
  app.post<{ Params: { slug: string } }>('/api/projects/:slug/integrity/accept', async (req) => {
    const parsed = acceptBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidRequest);
    const { dir, view, snapshot } = await integrityOf(req.params.slug);
    if (view.gitProblem !== null) throw new CodedError(409, view.gitProblem, 'git-unsafe');
    if (view.token !== parsed.data.token) throw new CodedError(409, t().errors.integrityChangedSince, 'integrity-changed');
    if (view.quarantined) await activeIntegrityStore().accept(dir, snapshot);
    ctx.broadcast({ type: 'project', project: req.params.slug });
    return { ...view, quarantined: false, files: [] } satisfies ProjectIntegrity;
  });
  app.put<{ Params: { slug: string } }>('/api/projects/:slug', async (req) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidRequest);
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
