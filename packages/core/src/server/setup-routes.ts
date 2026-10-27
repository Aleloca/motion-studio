import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupStatus } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { SetupRefused, setupRefusedMessage, type SetupService, type SetupTask } from '../setup/setup-service.ts';

/**
 * User report 91: the setup's buttons (setup/setup-service.ts). Every call needs the UI token like the rest of the API.
 *
 * - `GET /api/setup`: what may run here and the tasks' states (polled by the UI while one runs).
 * - `POST /api/setup/claude/install` `{ consent: true }`, `POST /api/setup/claude/login` `{ consent: true }`,
 *   `POST /api/setup/ffmpeg/install` `{ consent: true }`: start one (202 with the status). Anything but `consent: true` is
 *   refused before anything runs; a server reachable from the network refuses every one (403).
 * - `POST /api/setup/:task/cancel`.
 */

const consent = z.object({ consent: z.literal(true) }).strict();
const TASKS: Record<string, SetupTask> = { 'claude-install': 'claudeInstall', 'claude-login': 'claudeLogin', 'ffmpeg-install': 'ffmpegInstall' };

export function registerSetupRoutes(app: FastifyInstance, ctx: { setup: SetupService }): void {
  app.addHook('preClose', async () => { ctx.setup.close(); });
  const run = (start: () => unknown) => async (req: { body?: unknown }, reply: { status(n: number): { send(b: unknown): unknown } }) => {
    if (!consent.safeParse(req.body ?? {}).success) throw new CodedError(400, t().errors.setupConsentRequired, 'consent-required');
    try { start(); } catch (e) {
      if (e instanceof SetupRefused) throw new CodedError(e.code === 'not-loopback' ? 403 : e.code === 'busy' ? 409 : 503, setupRefusedMessage(e), `setup-${e.code}`);
      throw e;
    }
    return reply.status(202).send(ctx.setup.status());
  };
  app.get('/api/setup', async (): Promise<SetupStatus> => ctx.setup.status());
  app.post('/api/setup/claude/install', run(() => ctx.setup.installClaude()));
  app.post('/api/setup/claude/login', run(() => ctx.setup.signIn()));
  app.post('/api/setup/ffmpeg/install', run(() => ctx.setup.installFfmpeg()));
  app.post<{ Params: { task: string } }>('/api/setup/:task/cancel', async (req): Promise<SetupStatus> => {
    const task = TASKS[req.params.task];
    if (!task) throw new CodedError(404, t().errors.notFound, 'not-found');
    ctx.setup.cancel(task);
    return ctx.setup.status();
  });
}
