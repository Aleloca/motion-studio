import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DoctorCheck, ProjectDetail, WorkspaceInfo, WorkspaceProblem, WorkspaceSettings } from '@motion-studio/shared';
import { CreativeTurnService } from '../creatives/creative-turns.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import { NoMediaTools, type MediaTools } from '../media/media-tools.ts';
import type { AgentRunner } from '../agent/runner.ts';
import type { AppConfigStore } from '../app-config.ts';
import type { Git } from '../git.ts';
import { JobConflictError, JobQueue } from '../jobs/job-queue.ts';
import { JsonFileError } from '../json-file.ts';
import { WorkspaceError, WorkspaceStore } from '../workspace-store.ts';
import { recoverWorkspace, registerCreativeRoutes } from './creative-routes.ts';
import { EventHub } from './event-hub.ts';

export interface ServerDeps {
  appConfig: AppConfigStore;
  git: Git;
  runner: AgentRunner;
  doctor: () => Promise<DoctorCheck[]>;
  webDir?: string;
  media?: MediaTools;
  openPath?: (path: string) => Promise<void>;
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOST.test(host);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
      && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

// 1..128 of [A-Za-z0-9-], not starting with '-' so it can never be read as a CLI flag after --resume.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** `~` and `~/…` refer to the user's home folder. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function describeWorkspaceProblem(err: unknown): WorkspaceProblem {
  if (err instanceof WorkspaceError && err.code) return { code: err.code, message: err.message };
  return { code: 'invalid', message: err instanceof Error ? err.message : String(err) };
}

/** Key of a project's agent jobs: unique per workspace root, so two workspaces never collide. */
const projectJobKey = (root: string, slug: string) => `project:${root}:${slug}`;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hub = new EventHub();
  const queue = new JobQueue({ concurrency: 2, onUpdate: (job) => hub.broadcast({ type: 'job', job }) });
  const media = deps.media ?? NoMediaTools;
  const isJobActive = (key: string) => queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
  let workspace: WorkspaceStore | null = null;
  // Why the configured workspace could not be opened at startup (shown by the onboarding).
  let workspaceProblem: { path: string; error: WorkspaceProblem } | null = null;

  const configured = (await deps.appConfig.read()).workspacePath;
  if (configured) {
    try {
      // Never recreate a vanished workspace folder nor rewrite corrupt settings: report them instead.
      const ws = await WorkspaceStore.open(configured, deps.git, { create: false });
      queue.setConcurrency((await ws.readSettings()).maxConcurrentJobs);
      workspace = ws;
      await recoverWorkspace(ws);
    } catch (err) {
      workspaceProblem = { path: configured, error: describeWorkspaceProblem(err) };
    }
  }

  const requireWorkspace = () => {
    if (!workspace) throw new WorkspaceError(409, 'Nessun workspace configurato: scegli una cartella di lavoro');
    return workspace;
  };

  const turns = new CreativeTurnService({
    queue, runner: deps.runner, git: deps.git, media,
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    model: async () => (await requireWorkspace().readSettings()).model,
    broadcast: (msg) => hub.broadcast(msg),
  });

  app.setErrorHandler((error: unknown, _req, reply) => {
    const err = error as Error;
    if (err instanceof WorkspaceError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof JobConflictError) return reply.status(409).send({ error: err.message });
    if (err instanceof JsonFileError) return reply.status(422).send({ error: err.message });
    if ((err as { validation?: unknown }).validation) return reply.status(400).send({ error: err.message });
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return reply.status(status).send({ error: err.message });
    return reply.status(500).send({ error: err.message });
  });

  // Loopback-only by design: blocks DNS rebinding (Host) and cross-site requests/WebSockets (Origin).
  // In phase 5 Electron loads the UI from http://127.0.0.1:<port>, so this check stays valid.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!isLoopbackHost(req.headers.host) || (origin !== undefined && !isLoopbackOrigin(origin))) {
      // A rejected WebSocket upgrade leaves the raw socket open (nobody owns it any more): close it once the 403 is flushed.
      if (req.raw.headers.upgrade) reply.raw.once('finish', () => req.raw.socket.destroy());
      return reply.status(403).send({ error: 'Richiesta non consentita: origine non locale' });
    }
  });

  // preClose, registered before the websocket plugin's own preClose, so clients still
  // receive the final 'cancelled' job updates before their sockets are closed.
  app.addHook('preClose', async () => {
    for (const j of queue.list()) queue.cancel(j.id);
    await queue.whenIdle();
  });

  await app.register(fastifyWebsocket);

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/doctor', async () => deps.doctor());

  app.get('/api/workspace', async (): Promise<WorkspaceInfo> => {
    if (!workspace) return { path: workspaceProblem?.path ?? null, settings: null, error: workspaceProblem?.error ?? null };
    try {
      return { path: workspace.root, settings: await workspace.readSettings(), error: null };
    } catch (err) {
      return { path: workspace.root, settings: null, error: describeWorkspaceProblem(err) };
    }
  });

  app.put<{ Body: { path?: unknown } }>('/api/workspace', async (req) => {
    const raw = req.body?.path;
    const path = typeof raw === 'string' ? expandHome(raw.trim()) : '';
    if (!isAbsolute(path)) throw new WorkspaceError(400, 'Indica un percorso assoluto per il workspace');
    const ws = await WorkspaceStore.open(path, deps.git);
    const settings = await ws.readSettings(); // corrupt settings → 422 before the choice is persisted
    await deps.appConfig.setWorkspacePath(path);
    // Re-selecting the workspace in use must not mark its running creatives as interrupted.
    if (workspace?.root !== ws.root) await recoverWorkspace(ws);
    workspace = ws;
    workspaceProblem = null;
    queue.setConcurrency(settings.maxConcurrentJobs);
    return { path, settings };
  });

  app.put<{ Body: Partial<WorkspaceSettings> }>('/api/settings', async (req) => {
    const { schemaVersion: _ignored, ...patch } = (req.body ?? {}) as Partial<WorkspaceSettings>;
    const settings = await requireWorkspace().updateSettings(patch);
    queue.setConcurrency(settings.maxConcurrentJobs);
    return settings;
  });

  app.get('/api/projects', async () => requireWorkspace().listProjects());

  app.post<{ Body: { name?: unknown; description?: unknown } }>('/api/projects', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : undefined;
    const created = await requireWorkspace().createProject({ name, description });
    return reply.status(201).send(created);
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug', async (req): Promise<ProjectDetail> => {
    const ws = requireWorkspace();
    const project = await ws.getProject(req.params.slug);
    return { slug: req.params.slug, project, jobKey: projectJobKey(ws.root, req.params.slug) };
  });

  app.post<{ Params: { slug: string }; Body: { prompt?: unknown; resumeSessionId?: unknown } }>(
    '/api/projects/:slug/turns',
    async (req, reply) => {
      const ws = requireWorkspace();
      const { slug } = req.params;
      const project = await ws.getProject(slug);
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) throw new WorkspaceError(400, 'Scrivi una richiesta per l\'agente');
      const rawSession = req.body?.resumeSessionId;
      if (rawSession != null && (typeof rawSession !== 'string' || !SESSION_ID_RE.test(rawSession))) {
        throw new WorkspaceError(400, 'Identificativo della sessione non valido');
      }
      const resumeSessionId = rawSession ?? undefined;
      const settings = await ws.readSettings();
      const cwd = ws.projectDir(slug);
      const job = queue.enqueue({
        key: projectJobKey(ws.root, slug),
        label: `Turno · ${project.name}`,
        run: async (signal, jobId) => {
          const run = deps.runner.start(
            {
              cwd,
              prompt,
              resumeSessionId,
              // Phase 1 deliberately ignores project.linkedCodebases (no --add-dir): phase 3 will pass them
              // together with per-session deny rules on Edit/Write so they stay read-only (spec §6.3).
              model: settings.model ?? undefined,
            },
            (event) => {
              hub.broadcast({ type: 'agent', jobId, event });
              const sessionId = event.kind === 'session' ? event.sessionId : event.kind === 'result' ? event.sessionId : undefined;
              if (sessionId) queue.patch(jobId, { sessionId });
            },
          );
          signal.addEventListener('abort', () => run.cancel(), { once: true });
          const result = await run.done;
          if (result.status === 'failed') throw new Error(result.error ?? 'Turno non riuscito');
          // A cancel that arrived after an ok result yields 'succeeded' from the runner: keep it.
          return result.status === 'cancelled' ? 'cancelled' : undefined;
        },
      });
      return reply.status(202).send(job);
    },
  );

  app.get('/api/jobs', async () => queue.list());
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => ({ cancelled: queue.cancel(req.params.id) }));

  app.get('/api/events', { websocket: true }, (socket) => {
    hub.add(socket);
    hub.send(socket, { type: 'snapshot', jobs: queue.list() });
  });

  registerCreativeRoutes(app, { requireWorkspace, turns, media, openPath: deps.openPath ?? (async () => {}), isJobActive });

  const serveWeb = Boolean(deps.webDir && (await stat(deps.webDir).catch(() => null))?.isDirectory());
  // Always registered: it provides reply.sendFile to the creative file route; it serves the web build only when present.
  await app.register(fastifyStatic, { root: serveWeb ? deps.webDir! : tmpdir(), serve: serveWeb });
  // A single handler (Fastify allows one per context): unknown API routes always get a JSON 404,
  // other paths fall back to the SPA when the web build is available.
  app.setNotFoundHandler((req, reply) =>
    !serveWeb || req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Non trovato' }) : reply.sendFile('index.html'),
  );

  return app;
}
