// @vitest-environment node
/**
 * Phase 3 of the single agent: the group turn end to end, with the real runner and the fake `claude` CLI (no real agent, no
 * provider): the coordinator's run calls the studio bridge on the core's port, the helper writes its outputs, the core
 * resumes the coordinator for the closing message and records the group-turn entry. The ask guard holds on the real path.
 * This is the test the `singleAgent` default waited for (spec §13, phase 3).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, JobSummary } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
const P = '/api/projects/acme/creatives';
const ENV = ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_GROUP_CALLS', 'FAKE_CLAUDE_GROUP_REPORT_CALLS', 'FAKE_CLAUDE_BRIDGE_LOG', 'FAKE_CLAUDE_PROMPT_FILE'];
let app: FastifyInstance;
let base: string;
let log: string;
let prompts: string;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-group-e2e-'));
  log = join(base, 'bridge.jsonl');
  prompts = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
  process.env.FAKE_CLAUDE_PROMPT_FILE = prompts;
  const bridge = new AgentBridge();
  app = await buildServer({
    agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [], openPath: async () => {},
    bridge, mcpCommand: [process.execPath, '-e', ''],
  });
  bridge.setOrigin(await app.listen({ port: 0, host: '127.0.0.1' }));
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { singleAgent: true, confirmPaidProviders: false } });
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

const group = async () => {
  const slug = ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, generate: false } })).json() as { slug: string }).slug;
  expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2, directions: ['Audace', 'Calma'] } })).statusCode).toBe(201);
  return slug;
};
const settled = async (id: string): Promise<JobSummary> => {
  for (let i = 0; i < 2000; i++) {
    const j = ((await app.inject('/api/jobs')).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
};
const idle = async () => {
  for (let i = 0; i < 2000; i++) {
    if (((await app.inject('/api/jobs')).json() as JobSummary[]).every((j) => j.state !== 'queued' && j.state !== 'running')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('not idle');
};
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; phase: string; status: number; body: Record<string, unknown> }) : []);

describe('the group turn with the fake CLI', () => {
  it('a message naming B: the coordinator dispatches B, B\'s helper makes v1, the coordinator closes, the chat records it', async () => {
    const slug = await group();
    process.env.FAKE_CLAUDE_GROUP_CALLS = JSON.stringify([
      ['list_variants', {}],
      ['work_on_variants', { items: [{ variant: 'b', instruction: 'Titolo più grande' }] }],
    ]);
    const res = await app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Nella variante B il titolo più grande' } });
    expect(res.statusCode, res.body).toBe(202);
    const job = res.json() as JobSummary;
    expect(job.kind).toBe('creative-group');
    expect((await settled(job.id)).state).toBe('succeeded');
    await idle();
    const plan = calls().filter((c) => c.phase === 'coordinator');
    expect(plan.map((c) => [c.tool, c.status])).toEqual([['list_variants', 200], ['work_on_variants', 200]]);
    expect((plan[0]!.body as { variants: Array<{ variant: string; folder: string }> }).variants.map((v) => [v.variant, v.folder])).toEqual([['a', `creatives/${slug}`], ['b', `creatives/${slug}~b`]]);
    // B has its first version; A has none (nothing was asked of it).
    const versionsOf = async (s: string) => ((await app.inject(`${P}/${s}`)).json() as { versions: Array<{ n: number; request: string }> }).versions;
    expect((await versionsOf(`${slug}~b`)).map((v) => [v.n, v.request])).toEqual([[1, 'Titolo più grande']]);
    expect(await versionsOf(slug)).toEqual([]);
    // Three runs: the plan, B's helper, the report (the plan's session, resumed).
    const runs = readFileSync(prompts, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { prompt: string; args: string[] });
    expect(runs).toHaveLength(3);
    expect(runs[0]!.prompt).toContain('{"phase":"coordinator"}');
    expect(runs[1]!.prompt).toContain('## Working for the agent the user talks to');
    expect(runs[2]!.prompt).toContain('{"phase":"report"}');
    expect(runs[2]!.prompt).toContain('- B: saved v1 (complete)');
    expect(runs[2]!.args.join(' ')).toContain('--resume fake-session-1');
    const conv = (await app.inject(`${P}/${slug}~b/conversation`)).json() as ConversationEntry[];
    expect(conv.find((e) => e.type === 'group-turn')).toMatchObject({ jobId: job.id, outcome: [{ variant: 'b', version: 1, status: 'complete', kept: false }] });
    expect(conv.filter((e) => e.type === 'agent' && e.jobId === job.id && e.event.kind === 'text').every((e) => e.group)).toBe(true);
  });

  it('a message naming no variant: work_on_variants is refused on the real path too, nothing runs but the coordinator', async () => {
    const slug = await group();
    process.env.FAKE_CLAUDE_GROUP_CALLS = JSON.stringify([['work_on_variants', { items: [{ variant: 'a', instruction: 'Più luce' }] }]]);
    const job = (await app.inject({ method: 'POST', url: `${P}/${slug}~b/turns`, payload: { text: 'Più luce' } })).json() as JobSummary;
    expect((await settled(job.id)).state).toBe('succeeded');
    await idle();
    expect(calls().map((c) => [c.tool, c.status])).toEqual([['work_on_variants', 409]]);
    expect(String(calls()[0]!.body.error)).toMatch(/ask the user which variant/);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    const conv = (await app.inject(`${P}/${slug}/conversation`)).json() as ConversationEntry[];
    expect(conv.some((e) => e.type === 'group-turn')).toBe(false);
  });
});
