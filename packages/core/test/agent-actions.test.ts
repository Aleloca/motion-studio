// @vitest-environment node
/**
 * Decision 917 (user note 6): the agent's app actions. A server on a temp workspace with the controlled runner (no `claude`)
 * and the `studio` bridge active; the test calls the bridge routes with the run's token, as the MCP server would, and writes
 * the run's compositions itself (output contract v2). No render engine: a render answers the app's own 503.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FORMATS, formatDisplayName, type ConversationEntry, type CreativeDetail, type CreativeFile, type JobSummary } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge, type BridgeContext } from '../src/bridge/bridge.ts';
import { AgentActionService, APP_ACTIONS_PER_TURN } from '../src/creatives/agent-actions.ts';
import type { CreativeTurnService } from '../src/creatives/creative-turns.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
import { Git } from '../src/git.ts';
import { currentLocale, t } from '../src/i18n.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { ControlledRunner, type ControlledRun } from './helpers/controlled-runner.ts';

const P = '/api/projects/acme/creatives';
const brief = { goal: 'Lancio app', message: '', formats: ['youtube-16x9'], durationSec: 6, assets: [], notes: '' };

let base: string;
let app: FastifyInstance;
let runner: ControlledRunner;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-agent-actions-'));
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

describe('update_brief during the turn (user note 6)', () => {
  it('a new duration applies to the turn\'s checks at once and to the brief when the turn ends', async () => {
    const slug = await create();
    const run = await runOf(slug);
    expect(run.req.prompt).toContain('## Acting on the app');
    writeCompositions(run, 60);
    const res = await bridge(run, 'update_brief', { durationSec: 60 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, brief: { durationSec: 60 } });
    // The brief itself never changes under the running turn.
    expect((await detail(slug)).creative.brief.durationSec).toBe(6);
    const check = await bridge(run, 'validate_composition', {});
    expect(check.json().problems).toEqual([]);
    run.finish({ write: false });
    await waitIdle();
    // The pending brief is applied once the turn settled.
    await vi.waitFor(async () => expect((await detail(slug)).creative.brief.durationSec).toBe(60));
    const d = await detail(slug);
    expect(d.versions.map((v) => v.status)).toEqual(['complete']);
    expect(runner.runs).toHaveLength(1);
    const a = t().agentActions;
    expect(await actionLines(slug)).toContain(`${a.briefDuration({ from: a.seconds({ n: 6 }), to: a.seconds({ n: 60 }) })} · ${a.afterTurn}`);
  });

  it('without it the version is incomplete and says why; a brief edit checks it again with no new turn', async () => {
    const slug = await create();
    const first = await runOf(slug);
    writeCompositions(first, 60);
    first.finish({ write: false });
    // Two repair attempts: each prompt offers the brief change instead of another loop.
    for (const nth of [1, 2]) {
      const fix = await runOf(slug, nth);
      expect(fix.req.prompt).toContain('call update_brief with durationSec 60');
      fix.finish({ write: false });
    }
    await waitIdle();
    let d = await detail(slug);
    expect(d.versions.map((v) => v.status)).toEqual(['incomplete']);
    expect(d.creative.status).toBe('incomplete');
    const a = t().agentActions;
    expect((await conversation(slug)).some((e) => e.type === 'system' && e.level === 'warning' && e.text === a.incompleteDuration({ n: 1, duration: '60', target: '6' }))).toBe(true);
    // The user changes the duration in the brief: v1 is checked again, no agent.
    const res = await app.inject({ method: 'PUT', url: `${P}/${slug}`, payload: { brief: { ...brief, durationSec: 60 } } });
    expect(res.statusCode, res.body).toBe(200);
    d = await detail(slug);
    expect(d.versions.map((v) => v.status)).toEqual(['complete']);
    expect(d.versions[0]!.problems).toEqual([]);
    expect(d.versions[0]!.compositions![0]!.problems).toEqual([]);
    expect(d.creative.status).toBe('ready');
    expect(runner.runs).toHaveLength(3);
    expect((await conversation(slug)).some((e) => e.type === 'system' && e.text === a.recheckComplete({ n: 1, target: a.seconds({ n: 60 }) }))).toBe(true);
  });

  it('a user edit right after the turn builds on the agent\'s pending brief, never under it', async () => {
    const slug = await create();
    const run = await runOf(slug);
    writeCompositions(run, 6);
    expect((await bridge(run, 'update_brief', { notes: 'Dal agente' })).statusCode).toBe(200);
    run.finish({ write: false });
    await waitIdle();
    const res = await app.inject({ method: 'PUT', url: `${P}/${slug}`, payload: { services: { images: 'none' } } });
    expect(res.statusCode, res.body).toBe(200);
    await vi.waitFor(async () => expect((await detail(slug)).creative.brief).toMatchObject({ notes: 'Dal agente', services: { images: 'none' } }));
  });

  it('a recheck leaves a version whose composition changed on disk as it is', async () => {
    const slug = await create();
    const first = await runOf(slug);
    writeCompositions(first, 60);
    first.finish({ write: false });
    for (const nth of [1, 2]) (await runOf(slug, nth)).finish({ write: false });
    await waitIdle();
    const dir = join(base, 'ws', 'acme', 'creatives', slug, 'outputs', 'v1', 'compositions', 'youtube-16x9');
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({ $schema: 'motion-studio/composition@1', width: 1920, height: 1080, fps: 30, duration: 60, background: '#111111', fonts: [], scenes: [], tracks: [] }));
    await app.inject({ method: 'PUT', url: `${P}/${slug}`, payload: { brief: { ...brief, durationSec: 60 } } });
    expect((await detail(slug)).versions.map((v) => v.status)).toEqual(['incomplete']);
  });

  it('in a variant group, the group\'s new duration checks each variant\'s latest version again', async () => {
    const slug = await create(false);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2, directions: ['Calmo', 'Ironico'] } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: ['b'], request: null } })).statusCode).toBe(202);
    const b = `${slug}~b`;
    const first = await runOf(b);
    writeCompositions(first, 60);
    first.finish({ write: false });
    for (const nth of [1, 2]) (await runOf(b, nth)).finish({ write: false });
    await waitIdle();
    expect((await detail(b)).versions.map((v) => v.status)).toEqual(['incomplete']);
    // The user edits the brief on A: the group's brief reaches B, whose v1 is checked again.
    const res = await app.inject({ method: 'PUT', url: `${P}/${slug}`, payload: { brief: { ...brief, durationSec: 60 } } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await detail(b)).versions.map((v) => v.status)).toEqual(['complete']);
    expect((await detail(b)).creative.status).toBe('ready');
  });

  it('in a variant group it is the group\'s edit: idle variants now, the working one when its turn ends', async () => {
    const slug = await create(false);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2, directions: ['Calmo', 'Ironico'] } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: ['a'], request: null } })).statusCode).toBe(202);
    const run = await runOf(slug);
    expect((await bridge(run, 'update_brief', { notes: 'Chiudi con il logo' })).statusCode).toBe(200);
    expect((await detail(`${slug}~b`)).creative.brief.notes).toBe('Chiudi con il logo');
    expect((await detail(slug)).creative.brief.notes).toBe('');
    writeCompositions(run, 6);
    run.finish({ write: false });
    await waitIdle();
    await vi.waitFor(async () => expect((await detail(slug)).creative.brief.notes).toBe('Chiudi con il logo'));
  });
});

describe('formats and languages', () => {
  it('add_format: the brief has it after the turn and ONE follow-up turn makes it (never a second one)', async () => {
    const slug = await create();
    const run = await runOf(slug);
    writeCompositions(run, 6);
    const res = await bridge(run, 'add_format', { format: 'instagram-reel-9x16' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await bridge(run, 'add_format', { format: 'youtube-16x9' })).statusCode).toBe(409);
    expect((await bridge(run, 'add_format', { format: 'identity-logo' })).statusCode).toBe(400);
    expect((await bridge(run, 'add_format', { format: 'no-such-format' })).statusCode).toBe(400);
    run.finish({ write: false });
    const follow = await runOf(slug, 1);
    expect(parseStudioBlock(follow.req.prompt)!.formats.map((f) => f.id)).toEqual(['instagram-reel-9x16']);
    // The follow-up turn's own new format waits for the next turn.
    expect((await bridge(follow, 'add_format', { format: 'linkedin-4x5' })).statusCode).toBe(200);
    writeCompositions(follow, 6);
    follow.finish({ write: false });
    await waitIdle();
    // The actions after a turn run once it settled (after its pending brief): the line comes right after.
    await vi.waitFor(async () => expect(await actionLines(slug)).toContain(t().agentActions.formatMadeNext({ formats: 'LinkedIn · Post 4:5' })));
    expect(runner.runs).toHaveLength(2);
    const d = await detail(slug);
    expect(d.creative.brief.formats).toEqual(['youtube-16x9', 'instagram-reel-9x16', 'linkedin-4x5']);
    expect(d.versions.map((v) => v.status)).toEqual(['complete', 'complete']);
  });

  it('duplicate_format runs after the turn, on the version it saved', async () => {
    const slug = await create();
    const run = await runOf(slug);
    writeCompositions(run, 6);
    expect((await bridge(run, 'duplicate_format', { format: 'youtube-16x9', label: 'Seconda' })).statusCode).toBe(200);
    expect((await bridge(run, 'duplicate_format', { format: 'tiktok-9x16' })).statusCode).toBe(400);
    run.finish({ write: false });
    await waitIdle();
    await vi.waitFor(async () => expect(await actionLines(slug)).toContain(t().agentActions.duplicateDone({ format: 'Seconda', n: 2 })));
    const d = await detail(slug);
    expect(d.versions).toHaveLength(2);
    expect(d.versions[1]!.origin).toBe('editor');
    expect(d.creative.brief.formats).toEqual(['youtube-16x9', 'youtube-16x9@2']);
    expect(d.creative.brief.formatLabels).toEqual({ 'youtube-16x9@2': 'Seconda' });
  });

  it('add_language needs the primary language on a brief without languages and adds the language when the turn ends', async () => {
    const slug = await create();
    const run = await runOf(slug);
    expect((await bridge(run, 'add_language', { locale: 'de' })).statusCode).toBe(400);
    expect((await bridge(run, 'add_language', { locale: 'de', primary: 'it' })).statusCode).toBe(200);
    expect((await bridge(run, 'add_language', { locale: 'it' })).statusCode).toBe(409);
    writeCompositions(run, 6);
    run.finish({ write: false });
    await waitIdle();
    await vi.waitFor(async () => expect((await detail(slug)).creative.brief.locales).toEqual({ primary: 'it', extra: ['de'] }));
    // The translation job started on the saved version (its own turn).
    await vi.waitFor(async () => expect((await jobs()).some((j) => j.kind === 'localize')).toBe(true));
  });

  it('what waits for the turn is dropped, and said, when the turn saves no version', async () => {
    const slug = await create();
    const run = await runOf(slug);
    expect((await bridge(run, 'duplicate_format', { format: 'youtube-16x9' })).statusCode).toBe(200);
    run.finish({ write: false, ok: false, error: 'boom' });
    await waitIdle();
    await vi.waitFor(async () => expect((await actionLines(slug)).some((l) => l.startsWith(t().agentActions.dropped({ list: '' }).trimEnd()))).toBe(true));
    expect((await detail(slug)).versions).toHaveLength(0);
  });
});

describe('render and ★', () => {
  it('render_version of a saved version answers as the app (no renderer here); "current" waits for the turn', async () => {
    const slug = await create();
    const first = await runOf(slug);
    writeCompositions(first, 6);
    first.finish({ write: false });
    await waitIdle();
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Più luce' } })).statusCode).toBe(202);
    const run = await runOf(slug, 1);
    const now = await bridge(run, 'render_version', { version: 1 });
    expect(now.statusCode).toBe(503);
    expect(now.json().error).toBe(t().render.noRenderer);
    expect((await bridge(run, 'render_version', { version: 'current' })).statusCode).toBe(200);
    expect((await bridge(run, 'set_pick', { format: 'youtube-16x9', version: 1 })).statusCode).toBe(200);
    expect((await bridge(run, 'set_pick', { format: 'youtube-16x9', version: 1, variant: 'b' })).statusCode).toBe(409);
    expect((await bridge(run, 'set_pick', { format: 'youtube-16x9', version: 'current' })).statusCode).toBe(200);
    // Another composition (decision 1060: the same one would make no version).
    writeCompositions(run, 6.5);
    run.finish({ write: false });
    await waitIdle();
    // The deferred render ran and got the same refusal, said in the chat.
    await vi.waitFor(async () => expect((await actionLines(slug)).some((l) => l.includes(t().render.noRenderer))).toBe(true));
    const name = formatDisplayName(DEFAULT_FORMATS, 'youtube-16x9', currentLocale());
    await vi.waitFor(async () => expect(await actionLines(slug)).toContain(t().agentActions.pickSet({ format: name, version: 'v2' })));
  });
});

describe('variants', () => {
  it('add_variant makes a group and starts the new variant; no cap (decision 978); the own working variant cannot be discarded', async () => {
    const slug = await create();
    const run = await runOf(slug);
    const res = await bridge(run, 'add_variant', { direction: 'Più ironico' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, variant: 'b', started: true });
    const b = await runOf(`${slug}~b`);
    expect(b.req.prompt).toContain('Più ironico');
    expect((await bridge(run, 'discard_variant', { variant: 'a' })).statusCode).toBe(409);
    expect((await bridge(run, 'discard_variant', { variant: 'b' })).statusCode).toBe(409);
    for (const d of ['C', 'D', 'E', 'F']) expect((await bridge(run, 'add_variant', { direction: `Direzione ${d}` })).statusCode).toBe(200);
    const g = (await detail(slug)).variants;
    expect(g && !g.orphan ? g.group.members.map((m) => m.letter) : []).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // Decision 1153: a first generation started by add_variant never adds a variant itself (no chain of turns).
    const chained = await bridge(b, 'add_variant', { direction: 'Ancora una' });
    expect(chained.statusCode).toBe(409);
    expect(chained.json().error).toBe(t().errors.variantAddFirstGeneration);
    expect(await actionLines(slug)).toContain(t().agentActions.variantAdded({ letter: 'B', direction: 'Più ironico' }));
    writeCompositions(b, 6);
    b.finish({ write: false });
    await vi.waitFor(async () => expect((await jobs()).find((j) => j.key.endsWith(`:${slug}~b`) && j.kind === 'creative')?.state).toBe('succeeded'));
    expect((await bridge(run, 'discard_variant', { variant: 'b' })).statusCode).toBe(200);
    expect((await bridge(run, 'restore_variant', { variant: 'b' })).statusCode).toBe(200);
    expect((await bridge(run, 'discard_variant', { variant: 'zz' })).statusCode).toBe(404);
  });

  it('decision 1153: a message sent to several variants adds a variant once (the first target only), not once per variant (report 32)', async () => {
    const slug = await create(false);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 3, directions: ['Uno', 'Due', 'Tre'] } })).statusCode).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: 'all-active', request: { text: 'Crea una nuova variante' } } });
    expect(sent.statusCode, sent.body).toBe(202);
    const [a, b] = [await runOf(slug), await runOf(`${slug}~b`)];
    const refused = await bridge(b, 'add_variant', { direction: 'Doppione' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(t().errors.variantAddFanout({ letter: 'A' }));
    expect((await bridge(a, 'add_variant', { direction: 'Nuova' })).statusCode).toBe(200);
    const g = (await detail(slug)).variants;
    expect(g && !g.orphan ? g.group.members.map((m) => m.letter) : []).toEqual(['a', 'b', 'c', 'd']);
    // C was waiting for a slot (two at a time): its turn is a follower too once it starts.
    writeCompositions(b, 6);
    b.finish({ write: false });
    const c = await runOf(`${slug}~c`);
    expect((await bridge(c, 'add_variant', { direction: 'Doppione' })).statusCode).toBe(409);
  });
});

describe('decision 1153 kept across a restart (review minor 10)', () => {
  it('a working variant\'s queued share of a fan-out keeps its lead and request id on disk; when it starts it does not add variants', async () => {
    const slug = await create(false);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2, directions: ['Uno', 'Due'] } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}~b/turns`, payload: { text: 'Prima' } })).statusCode).toBe(202);
    const b1 = await runOf(`${slug}~b`);
    const sent = await app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: 'all-active', request: { text: 'Crea una variante' } } });
    expect(sent.json().queued).toEqual(['b']);
    const queued = (await detail(`${slug}~b`)).creative.queued!;
    expect(queued[0]).toMatchObject({ text: 'Crea una variante', fanout: { lead: 'a' } });
    const a = await runOf(slug);
    expect((await bridge(a, 'add_variant', { direction: 'Nuova' })).statusCode).toBe(200);
    writeCompositions(b1, 6);
    b1.finish({ write: false });
    // The new variant C took the other slot (two at a time): A ends to let B's queued share start.
    writeCompositions(a, 6);
    a.finish({ write: false });
    const b2 = await runOf(`${slug}~b`, 1);
    expect((await bridge(b2, 'add_variant', { direction: 'Doppione' })).statusCode).toBe(409);
    // Both shares of the request carry its one id (decision 1166: one bubble in the chat).
    const users = (await conversation(slug)).filter((e) => e.type === 'user' && e.text === 'Crea una variante');
    expect(users.map((e) => e.variant).sort()).toEqual(['a', 'b']);
    expect(new Set(users.map((e) => e.type === 'user' ? e.fanout : null)).size).toBe(1);
    expect(users[0]!.type === 'user' && users[0]!.fanout).toBe(queued[0]!.fanout!.id);
  });
});

describe('scope and limits', () => {
  it('strict inputs: an unknown key (a project, a path) is refused', async () => {
    const slug = await create();
    const run = await runOf(slug);
    expect((await bridge(run, 'update_brief', { durationSec: 10, projectSlug: 'other' })).statusCode).toBe(400);
    expect((await bridge(run, 'update_brief', {})).statusCode).toBe(400);
    expect((await bridge(run, 'duplicate_format', { format: '../../etc' })).statusCode).toBe(400);
    expect((await detail(slug)).creative.brief.durationSec).toBe(6);
  });

  it(`at most ${APP_ACTIONS_PER_TURN} calls per turn`, async () => {
    const slug = await create();
    const run = await runOf(slug);
    for (let i = 0; i < APP_ACTIONS_PER_TURN; i++) expect((await bridge(run, 'update_brief', {})).statusCode).toBe(400);
    expect((await bridge(run, 'update_brief', { notes: 'x' })).statusCode).toBe(429);
  });

  it('refused outside a creative turn, whatever the tool', async () => {
    const turns = { onTurnSettled: () => {} } as unknown as CreativeTurnService;
    const svc = new AgentActionService({ turns, edits: null as never, renders: null as never, localize: null as never, variantRuns: null as never, presets: async () => [] });
    const ctx = { jobId: 'j', kind: 'brand-analysis', projectSlug: 'acme', projectDir: '/x', creativeSlug: null, sandboxed: false, autoApproveAtStart: false, emit: () => {}, signal: new AbortController().signal } as BridgeContext;
    for (const [name, handler] of Object.entries(svc.tools())) await expect(handler(ctx, {}), name).rejects.toMatchObject({ status: 403 });
    // A creative job without the turn's scope (it never gets one from anything the agent sends) is refused too.
    await expect(svc.tools().update_brief!({ ...ctx, kind: 'creative' }, { notes: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('a brand analysis job never reaches the tools (MCP_TOOLS)', async () => {
    const { MCP_TOOLS, APP_ACTION_TOOLS } = await import('../src/agent/launcher.ts');
    for (const kind of ['brand-analysis', 'describe', 'console', 'localize', 'variant-directions'] as const) {
      for (const tool of APP_ACTION_TOOLS) expect(MCP_TOOLS[kind]).not.toContain(tool);
    }
    for (const tool of APP_ACTION_TOOLS) expect(MCP_TOOLS.creative).toContain(tool);
  });
});

// Keeps the creative file type in use for readers of the assertions above.
export type { CreativeFile };
