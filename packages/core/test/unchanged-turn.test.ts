// @vitest-environment node
/**
 * Decision 1060 (user call 972, notes 29–30): a turn that changes no video or image makes no version. The same harness as
 * agent-actions.test.ts: the controlled runner (no `claude`), the `studio` bridge, the run's compositions written by the test.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConversationEntry, type CreativeDetail, type CreativeFile, type JobSummary } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
import { Git } from '../src/git.ts';
import { t } from '../src/i18n.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { ControlledRunner, type ControlledRun } from './helpers/controlled-runner.ts';

const P = '/api/projects/acme/creatives';
const brief = { goal: 'Lancio app', message: '', formats: ['youtube-16x9'], durationSec: 6, assets: [], notes: '' };

let base: string;
let app: FastifyInstance;
let runner: ControlledRunner;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-unchanged-turn-'));
  runner = new ControlledRunner();
  const bridge = new AgentBridge();
  // Never contacted: the controlled runner starts no MCP server; the bridge only needs an origin to hand out tokens.
  bridge.setOrigin('http://127.0.0.1:9');
  app = await buildServer({
    uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(), runner,
    doctor: async () => [], claudeVersion: async () => '2.1.0', bridge, approvals: new ApprovalBroker({ broadcast: () => {} }),
    mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')], vault: new MemoryVault({}),
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => {
  for (const r of runner.runs) r.end();
  await app.close();
  // Late writes of a settled turn (its git commit, storyboards) may still land: retried.
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const jobs = async () => (await app.inject('/api/jobs')).json() as JobSummary[];
const waitIdle = () => vi.waitFor(async () => expect((await jobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true), { timeout: 20_000, interval: 20 });
const detail = async (slug: string) => (await app.inject(`${P}/${slug}`)).json() as CreativeDetail;
const conversation = async (slug: string) => (await app.inject(`${P}/${slug}/conversation`)).json() as ConversationEntry[];
const actionLines = async (slug: string) => (await conversation(slug)).filter((e): e is Extract<ConversationEntry, { type: 'system' }> => e.type === 'system' && e.origin === 'agent').map((e) => e.text);
const create = async (generate = true, b: Record<string, unknown> = brief) => ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief: b, generate } })).json() as { slug: string }).slug;
/** The `nth` run (0: first) of creative `slug`. */
const runOf = async (slug: string, nth = 0): Promise<ControlledRun> => {
  const mine = () => runner.runs.filter((r) => r.req.prompt.includes(`creatives/${slug}/outputs`));
  await vi.waitFor(() => expect(mine().length).toBeGreaterThan(nth), { timeout: 10_000 });
  return mine()[nth]!;
};
/** Calls a `studio` tool for the run's job, as its MCP server would. */
const bridge = async (run: ControlledRun, tool: string, args: Record<string, unknown>): Promise<LightMyRequestResponse> => {
  const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
  const token = (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
  return app.inject({ method: 'POST', url: `/api/bridge/${tool}`, headers: { 'x-motion-studio-bridge': token }, payload: args });
};
/** Writes a minimal composition for each format the run's prompt asks for (videos last `duration` seconds). */
const writeCompositions = (run: ControlledRun, duration: number) => {
  const block = parseStudioBlock(run.req.prompt)!;
  for (const f of block.formats) {
    const dir = join(run.req.cwd, f.compositionDir!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({ $schema: 'motion-studio/composition@1', width: f.width, height: f.height, fps: 30, duration: f.kind === 'video' ? duration : 0, background: '#000000', fonts: [], scenes: [], tracks: [] }));
  }
  return block.formats.map((f) => f.id);
};


const versionEntries = async (slug: string) => (await conversation(slug)).filter((e) => e.type === 'version');
const systemTexts = async (slug: string) => (await conversation(slug)).filter((e): e is Extract<ConversationEntry, { type: 'system' }> => e.type === 'system').map((e) => e.text);
/** v1 of `slug` made 60 s long against a 6 s brief: incomplete after the two repair attempts. */
const incompleteV1 = async (slug: string) => {
  const first = await runOf(slug);
  writeCompositions(first, 60);
  first.finish({ write: false });
  for (const nth of [1, 2]) (await runOf(slug, nth)).finish({ write: false });
  await waitIdle();
  expect((await detail(slug)).versions.map((v) => v.status)).toEqual(['incomplete']);
};

describe('a turn that changes no output (decision 1060)', () => {
  it('only update_brief: no v2, the brief changes, v1 is checked again and is complete, the chat says so', async () => {
    const slug = await create();
    await incompleteV1(slug);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Porta il brief a 60 s' } })).statusCode).toBe(202);
    const run = await runOf(slug, 3);
    expect((await bridge(run, 'update_brief', { durationSec: 60 })).statusCode).toBe(200);
    // The agent writes the same composition again: the same hash as v1's.
    writeCompositions(run, 60);
    run.finish({ write: false });
    await waitIdle();
    await vi.waitFor(async () => expect((await detail(slug)).creative.brief.durationSec).toBe(60));
    // The re-check follows the brief's write when the turn settles.
    await vi.waitFor(async () => expect((await detail(slug)).versions.map((v) => [v.n, v.status])).toEqual([[1, 'complete']]));
    const d = await detail(slug);
    expect(d.creative.status).toBe('ready');
    expect(runner.runs).toHaveLength(4);
    expect((await versionEntries(slug)).length).toBe(1);
    const texts = await systemTexts(slug);
    expect(texts).toContain(t().jobs.noOutputChanged({ n: 1, brief: true }));
    expect(texts).toContain(t().agentActions.recheckComplete({ n: 1, target: t().agentActions.seconds({ n: 60 }) }));
    // The unsaved version's folder is gone; the next turn takes v2 again.
    expect(existsSync(join(base, 'ws', 'acme', 'creatives', slug, 'outputs', 'v2'))).toBe(false);
    // The agent's session goes on from that turn (its conversation is kept), on the version that holds its content.
    expect(d.versions[0]!.sessionId).toBe(run.sessionId);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Più luce' } })).statusCode).toBe(202);
    const next = await runOf(slug, 4);
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    expect(next.req.prompt).toContain(`creatives/${slug}/outputs/v2`);
    writeCompositions(next, 58);
    next.finish({ write: false });
    await waitIdle();
    expect((await detail(slug)).versions.map((v) => v.n)).toEqual([1, 2]);
  });

  it('what the agent left for after the turn acts on the version that holds the content', async () => {
    const slug = await create();
    const first = await runOf(slug);
    writeCompositions(first, 6);
    first.finish({ write: false });
    await waitIdle();
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Duplica il formato' } })).statusCode).toBe(202);
    const run = await runOf(slug, 1);
    expect((await bridge(run, 'duplicate_format', { format: 'youtube-16x9', label: 'Seconda' })).statusCode).toBe(200);
    writeCompositions(run, 6);
    run.finish({ write: false });
    await waitIdle();
    await vi.waitFor(async () => expect(await actionLines(slug)).toContain(t().agentActions.duplicateDone({ format: 'Seconda', n: 2 })));
    expect(await systemTexts(slug)).toContain(t().jobs.noOutputChanged({ n: 1, brief: false }));
    const d = await detail(slug);
    expect(d.versions.map((v) => [v.n, v.origin ?? 'agent'])).toEqual([[1, 'agent'], [2, 'editor']]);
  });

  it('a turn that changes one format makes a version as before', async () => {
    const slug = await create(true, { ...brief, formats: ['youtube-16x9', 'tiktok-9x16'] });
    const first = await runOf(slug);
    writeCompositions(first, 6);
    first.finish({ write: false });
    await waitIdle();
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Più corto', formats: ['tiktok-9x16'] } })).statusCode).toBe(202);
    const run = await runOf(slug, 1);
    writeCompositions(run, 5.5);
    run.finish({ write: false });
    await waitIdle();
    const d = await detail(slug);
    expect(d.versions.map((v) => v.n)).toEqual([1, 2]);
    // The format the turn did not change keeps following v1.
    expect(d.formats!.find((f) => f.id === 'youtube-16x9')!.history).toEqual([1]);
    expect(d.formats!.find((f) => f.id === 'tiktok-9x16')!.history).toEqual([1, 2]);
  });

  it('in a variant group each variant is judged on its own outputs', async () => {
    const slug = await create(false);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2, directions: ['Calmo', 'Ironico'] } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: ['a', 'b'], request: null } })).statusCode).toBe(202);
    const b = `${slug}~b`;
    for (const s of [slug, b]) {
      const r = await runOf(s);
      writeCompositions(r, 6);
      r.finish({ write: false });
    }
    await waitIdle();
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: ['a', 'b'], request: { text: 'Rivedi' } } })).statusCode).toBe(202);
    const ra = await runOf(slug, 1);
    writeCompositions(ra, 6);
    ra.finish({ write: false });
    const rb = await runOf(b, 1);
    writeCompositions(rb, 7);
    rb.finish({ write: false });
    await waitIdle();
    expect((await detail(slug)).versions.map((v) => v.n)).toEqual([1]);
    expect((await detail(b)).versions.map((v) => v.n)).toEqual([1, 2]);
  });
});
