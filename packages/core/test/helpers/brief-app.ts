import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect, vi } from 'vitest';
import { EMPTY_BRIEF_FORM, type BriefSessionView, type ConversationEntry, type JobSummary, type ServerMessage } from '@motion-studio/shared';
import { AppConfigStore } from '../../src/app-config.ts';
import { ApprovalBroker } from '../../src/approvals/broker.ts';
import { AgentBridge } from '../../src/bridge/bridge.ts';
import { Git } from '../../src/git.ts';
import { MemoryVault } from '../../src/secrets/vault.ts';
import { buildServer } from '../../src/server/app.ts';
import { ControlledRunner, type ControlledRun } from './controlled-runner.ts';

/**
 * Decisions 1421–1423: a server on a temp workspace with the controlled runner (no `claude`) and the `studio` bridge active
 * (an origin and an MCP command that is never started: the test calls the bridge routes with the run's token, as the MCP
 * server would), a project `acme`, a codebase folder with a `.env` outside the workspace and a library asset.
 */
export const S = '/api/projects/acme/brief-session';

export interface BriefApp {
  app: FastifyInstance; runner: ControlledRunner; base: string; code: string; projectDir: string; sent: ServerMessage[];
}

export async function briefApp(o: { live?: boolean; settings?: Record<string, unknown> } = {}): Promise<BriefApp> {
  const base = await mkdtemp(join(tmpdir(), 'ms-brief-'));
  const runner = new ControlledRunner();
  const bridge = new AgentBridge();
  // Never contacted: the controlled runner starts no MCP server; the bridge only needs an origin to hand out tokens.
  bridge.setOrigin('http://127.0.0.1:9');
  const sent: ServerMessage[] = [];
  const app = await buildServer({
    uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(), runner,
    doctor: async () => [], claudeVersion: async () => (o.live ? '2.1.301' : '2.1.0'), bridge, approvals: new ApprovalBroker({ broadcast: () => {} }),
    // Every message the hub sends, as a client would see it.
    onBroadcast: (m) => sent.push(m),
    mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')], vault: new MemoryVault({}), agentContract: 'media',
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  if (o.settings) await app.inject({ method: 'PUT', url: '/api/settings', payload: o.settings });
  const code = join(base, 'code');
  await mkdir(code, { recursive: true });
  await writeFile(join(code, '.env'), 'SECRET=1');
  await writeFile(join(code, 'index.ts'), 'export {}');
  const projectDir = join(base, 'ws', 'acme');
  await mkdir(join(projectDir, 'assets'), { recursive: true });
  await writeFile(join(projectDir, 'assets', 'hero.png'), 'png');
  return { app, runner, base, code, projectDir, sent };
}

let n = 0;
/** The helpers of one server. */
export function briefHelpers(t: BriefApp) {
  const cid = () => `brief-msg-${++n}`;
  const jobs = async () => (await t.app.inject('/api/jobs')).json() as JobSummary[];
  const tokenOf = async (run: ControlledRun) => {
    const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
    return (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
  };
  return {
    cid, jobs,
    waitIdle: () => vi.waitFor(async () => expect((await jobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true), { timeout: 20_000, interval: 20 }),
    view: async () => (await t.app.inject(S)).json() as BriefSessionView | null,
    open: async (form = EMPTY_BRIEF_FORM) => (await t.app.inject({ method: 'POST', url: S, payload: { form, userEdited: [] } })).json() as BriefSessionView,
    conversation: async (id: string) => (await t.app.inject(`${S}/${id}/conversation`)).json() as ConversationEntry[],
    send: (id: string, text: string, o: { codebases?: Array<{ path: string; note?: string }>; assets?: string[]; mode?: 'live' | 'queued'; form?: typeof EMPTY_BRIEF_FORM; userEdited?: string[] } = {}) =>
      t.app.inject({ method: 'POST', url: `${S}/${id}/messages`, payload: { clientId: cid(), text, context: { codebases: o.codebases ?? [], assets: o.assets ?? [] }, form: o.form ?? EMPTY_BRIEF_FORM, userEdited: o.userEdited ?? [], ...(o.mode ? { mode: o.mode } : {}) } }),
    tool: async (run: ControlledRun, name: string, args: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      t.app.inject({ method: 'POST', url: `/api/bridge/${name}`, headers: { 'x-motion-studio-bridge': await tokenOf(run) }, payload: args }),
    briefMessages: () => t.sent.filter((m): m is Extract<ServerMessage, { type: 'brief-session' }> => m.type === 'brief-session'),
  };
}
