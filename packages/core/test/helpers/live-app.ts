import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { AppConfigStore } from '../../src/app-config.ts';
import { Git } from '../../src/git.ts';
import { buildServer } from '../../src/server/app.ts';
import { ControlledRunner } from './controlled-runner.ts';

/** Phase 13: a server on a temp workspace with the controlled runner, a project `acme` and a draft creative. */
export interface LiveApp {
  app: FastifyInstance; runner: ControlledRunner; base: string; slug: string;
  /** `/api/projects/acme/creatives/<slug>` */
  url: string;
  jobs(): Promise<Array<{ id: string; kind: string; state: string; sessionId?: string; liveMessages?: number }>>;
  waitIdle(): Promise<void>;
  creative(): Promise<{ queued?: Array<{ clientId: string; text: string }>; stoppedSession?: { sessionId: string; jobId: string }; status: string }>;
  conversation(): Promise<Array<Record<string, unknown>>>;
  versions(): Promise<unknown[]>;
}

export const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };

/**
 * `live`: the workspace opts in to live input and interrupt (with a known Claude Code version), as Settings would.
 * `base`/`runner`: reuse a workspace and runner (a second start of the app on the same data).
 */
export async function liveApp(o: { live?: boolean; base?: string; runner?: ControlledRunner; slug?: string } = {}): Promise<LiveApp> {
  const base = o.base ?? await mkdtemp(join(tmpdir(), 'ms-live-'));
  const runner = o.runner ?? new ControlledRunner();
  const app = await buildServer({
    agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'),
    git: new Git(), runner, doctor: async () => [], claudeVersion: async () => '2.1.0',
  });
  let slug = o.slug ?? '';
  if (!o.base) {
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    if (o.live) await app.inject({ method: 'PUT', url: '/api/settings', payload: { agentLiveInput: true, agentInterrupt: true } });
    slug = (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief, generate: false } })).json().slug;
  }
  const url = `/api/projects/acme/creatives/${slug}`;
  const jobs = async () => (await app.inject('/api/jobs')).json();
  return {
    app, runner, base, slug, url, jobs,
    waitIdle: () => vi.waitFor(async () => expect((await jobs()).every((j: { state: string }) => j.state !== 'queued' && j.state !== 'running')).toBe(true), { timeout: 20_000, interval: 20 }),
    creative: async () => (await app.inject(url)).json().creative,
    conversation: async () => (await app.inject(`${url}/conversation`)).json(),
    versions: async () => (await app.inject(url)).json().versions,
  };
}

/** A fresh client message id (what the web sends; a UUID). */
let n = 0;
export const cid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
