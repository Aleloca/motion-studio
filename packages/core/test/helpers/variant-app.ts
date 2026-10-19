import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect, vi } from 'vitest';
import type { ApprovalRequest, CreativeDetail, JobSummary } from '@motion-studio/shared';
import { AppConfigStore } from '../../src/app-config.ts';
import { ApprovalBroker } from '../../src/approvals/broker.ts';
import { AgentBridge } from '../../src/bridge/bridge.ts';
import { Git } from '../../src/git.ts';
import { MemoryVault } from '../../src/secrets/vault.ts';
import { buildServer } from '../../src/server/app.ts';
import { ControlledRunner, type ControlledRun } from './controlled-runner.ts';

/**
 * Phase 15, Task 3: a server on a temp workspace with the controlled runner (in-process, no `claude`) and the `studio`
 * bridge active (an origin and an MCP command that is never started: the test calls the bridge routes itself with the run's
 * token, as the MCP server would). Paid providers answer through `fetches` only: nothing leaves the machine.
 */
export interface VariantApp {
  app: FastifyInstance; runner: ControlledRunner; approvals: ApprovalBroker; base: string; projectDir: string;
  /** Every provider request the tools made (the injected fake fetch). */
  fetches: string[];
  url(slug: string): string;
  /** Creates a creative and its group: `directions[0]` is A's (null: none). */
  group(directions: Array<string | null>, title?: string): Promise<string>;
  detail(slug: string): Promise<CreativeDetail>;
  jobs(): Promise<JobSummary[]>;
  pending(): Promise<ApprovalRequest[]>;
  /** The job of member `slug` (host or sister) of `kind` creative, latest first. */
  jobOf(slug: string): Promise<JobSummary | undefined>;
  /** Calls a `studio` tool for the run's job, as its MCP server would. */
  bridge(run: ControlledRun, tool: string, args: Record<string, unknown>): Promise<LightMyRequestResponse>;
  /** The `nth` run (0: first) of member `slug`, once it started. Concurrent starts begin in any order: pick runs by member, never by index. */
  runOf(slug: string, nth?: number): Promise<ControlledRun>;
  waitIdle(): Promise<void>;
  close(): Promise<void>;
}

export const variantBrief = { goal: 'Lancio app', message: 'Scarica oggi', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
const P = '/api/projects/acme/creatives';

export async function variantApp(o: { keys?: Record<string, string>; settings?: Record<string, unknown>; approvalTimeoutMs?: number; trash?: (p: string) => Promise<void>; claudeVersion?: string } = {}): Promise<VariantApp> {
  const base = await mkdtemp(join(tmpdir(), 'ms-variants-'));
  const runner = new ControlledRunner();
  const bridge = new AgentBridge();
  // Never contacted: the controlled runner starts no MCP server; the bridge only needs an origin to hand out tokens.
  bridge.setOrigin('http://127.0.0.1:9');
  const approvals = new ApprovalBroker({ broadcast: () => {}, ...(o.approvalTimeoutMs ? { timeoutMs: o.approvalTimeoutMs } : {}) });
  const fetches: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetches.push(String(url));
    if (String(url).startsWith('https://api.openai.com/v1/audio/speech')) return new Response(new TextEncoder().encode('fake-voice'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const app = await buildServer({
    agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(), runner,
    doctor: async () => [], claudeVersion: async () => o.claudeVersion ?? '2.1.0', bridge, approvals,
    mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')],
    vault: new MemoryVault(o.keys ?? {}),
    ...(o.trash ? { trash: o.trash } : {}),
    providerHttp: { fetch: fakeFetch, lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] },
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  // Phase 3 of the single agent: these tests drive the per-variant turns of phase 15 (the group's single agent off), unless a
  // test turns it on (`settings.singleAgent`).
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { singleAgent: false, ...o.settings } });
  const jobs = async () => (await app.inject('/api/jobs')).json() as JobSummary[];
  return {
    app, runner, approvals, base, projectDir: join(base, 'ws', 'acme'), fetches,
    url: (slug) => `${P}/${slug}`,
    runOf: async (s, nth = 0) => {
      const mine = () => runner.runs.filter((r) => r.req.prompt.includes(`creatives/${s}/outputs`));
      await vi.waitFor(() => expect(mine().length).toBeGreaterThan(nth), { timeout: 10_000 });
      return mine()[nth]!;
    },
    group: async (directions, title = 'Lancio') => {
      const slug = ((await app.inject({ method: 'POST', url: P, payload: { title, brief: variantBrief, generate: false } })).json() as { slug: string }).slug;
      const res = await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: directions.length, directions } });
      expect(res.statusCode, res.body).toBe(201);
      return slug;
    },
    detail: async (slug) => (await app.inject(`${P}/${slug}`)).json() as CreativeDetail,
    jobs,
    pending: async () => (await app.inject('/api/approvals')).json() as ApprovalRequest[],
    jobOf: async (slug) => (await jobs()).find((j) => j.kind === 'creative' && j.key.endsWith(`:${slug}`)),
    bridge: async (run, tool, args) => {
      const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
      const token = (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
      return app.inject({ method: 'POST', url: `/api/bridge/${tool}`, headers: { 'x-motion-studio-bridge': token }, payload: args });
    },
    waitIdle: () => vi.waitFor(async () => expect((await jobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true), { timeout: 20_000, interval: 20 }),
    close: () => app.close(),
  };
}
