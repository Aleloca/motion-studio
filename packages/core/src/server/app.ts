import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DoctorCheck, WorkspaceSettings } from '@motion-studio/shared';
import type { AgentRunner } from '../agent/runner.ts';
import type { AppConfigStore } from '../app-config.ts';
import type { Git } from '../git.ts';
import { JobConflictError, JobQueue } from '../jobs/job-queue.ts';
import { JsonFileError } from '../json-file.ts';
import { WorkspaceError, WorkspaceStore } from '../workspace-store.ts';
import { EventHub } from './event-hub.ts';

export interface ServerDeps {
  appConfig: AppConfigStore;
  git: Git;
  runner: AgentRunner;
  doctor: () => Promise<DoctorCheck[]>;
  webDir?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hub = new EventHub();
  const queue = new JobQueue({ concurrency: 2, onUpdate: (job) => hub.broadcast({ type: 'job', job }) });
  let workspace: WorkspaceStore | null = null;

  const configured = (await deps.appConfig.read()).workspacePath;
  if (configured) {
    try {
      workspace = await WorkspaceStore.open(configured, deps.git);
      queue.setConcurrency((await workspace.readSettings()).maxConcurrentJobs);
    } catch {
      workspace = null; // surfaced to the UI as "workspace not configured"
    }
  }

  const requireWorkspace = () => {
    if (!workspace) throw new WorkspaceError(409, 'Nessun workspace configurato: scegli una cartella di lavoro');
    return workspace;
  };

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

  app.get('/api/workspace', async () => ({
    path: workspace?.root ?? null,
    settings: workspace ? await workspace.readSettings() : null,
  }));

  app.put<{ Body: { path?: unknown } }>('/api/workspace', async (req) => {
    const path = req.body?.path;
    if (typeof path !== 'string' || !isAbsolute(path)) throw new WorkspaceError(400, 'Indica un percorso assoluto per il workspace');
    const ws = await WorkspaceStore.open(path, deps.git);
    await deps.appConfig.setWorkspacePath(path);
    workspace = ws;
    const settings = await ws.readSettings();
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

  app.get<{ Params: { slug: string } }>('/api/projects/:slug', async (req) => {
    const project = await requireWorkspace().getProject(req.params.slug);
    return { slug: req.params.slug, project };
  });

  app.post<{ Params: { slug: string }; Body: { prompt?: unknown; resumeSessionId?: unknown } }>(
    '/api/projects/:slug/turns',
    async (req, reply) => {
      const ws = requireWorkspace();
      const { slug } = req.params;
      const project = await ws.getProject(slug);
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) throw new WorkspaceError(400, 'Scrivi una richiesta per l\'agente');
      const resumeSessionId = typeof req.body?.resumeSessionId === 'string' ? req.body.resumeSessionId : undefined;
      const settings = await ws.readSettings();
      const cwd = ws.projectDir(slug);
      const job = queue.enqueue({
        key: `project:${slug}`,
        label: `Turno · ${project.name}`,
        run: async (signal, jobId) => {
          const run = deps.runner.start(
            {
              cwd,
              prompt,
              resumeSessionId,
              addDirs: project.linkedCodebases.map((c) => c.path),
              model: settings.model ?? undefined,
            },
            (event) => hub.broadcast({ type: 'agent', jobId, event }),
          );
          signal.addEventListener('abort', () => run.cancel(), { once: true });
          const result = await run.done;
          if (result.status === 'failed') throw new Error(result.error ?? 'Turno non riuscito');
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

  if (deps.webDir && (await stat(deps.webDir).catch(() => null))?.isDirectory()) {
    await app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Non trovato' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
