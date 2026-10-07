import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, type Brief, type ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobConflictError, JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { CONTEXT_MD } from '../src/project-template.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief: Brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };

let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let service: CreativeTurnService;
let messages: ServerMessage[];
let promptFile: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-turn è '));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  const projectDir = ws.projectDir(slug);
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief });
  ref = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  messages = [];
  queue = new JobQueue({ concurrency: 2 });
  service = new CreativeTurnService({
    queue, git, media: NoMediaTools,
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    presets: async () => DEFAULT_FORMATS, model: async () => null,
    broadcast: (m) => messages.push(m),
  });
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
});
afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_PROMPT_FILE; });

const prompts = async () => (await readFile(promptFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { prompt: string; args: string[] });
const finalState = async (jobId: string) => { await queue.whenIdle(); return queue.list().find((j) => j.id === jobId)!.state; };

describe('CreativeTurnService', () => {
  it('generates v1 from the brief: outputs, version, commit, conversation, status', async () => {
    const job = await service.start(ref);
    expect(job.key).toBe(`creative:${ref.root}:${ref.projectSlug}:${ref.creativeSlug}`);
    expect(await finalState(job.id)).toBe('succeeded');
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1).toMatchObject({ n: 1, status: 'complete', problems: [], sessionId: 'fake-session-1', request: 'Generazione dal brief', basedOn: null, tools: ['fake'] });
    expect(v1!.outputs.map((o) => o.file)).toEqual(['instagram-post-1x1.mp4', 'web-banner-300x250.png']);
    expect(v1!.commit).toMatch(/^[0-9a-f]{40}$/);
    const log = await execCommand('git', ['log', '-1', '--format=%s'], { cwd: ref.projectDir });
    expect(log.stdout.trim()).toBe('Lancio: v1');
    expect((await store.get(ref.creativeSlug)).status).toBe('ready');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'agent')).toBe(true);
    expect(conv.at(-1)).toMatchObject({ type: 'version', n: 1, status: 'complete' });
    expect(messages.some((m) => m.type === 'creative')).toBe(true);
    expect((await prompts())[0]!.prompt).toContain('Realizza la creatività "Lancio" (versione 1)');
  });

  it('rewrites .studio/context.md before each turn', async () => {
    await writeFile(join(ref.projectDir, '.studio', 'context.md'), 'manomesso');
    await finalState((await service.start(ref)).id);
    expect(await readFile(join(ref.projectDir, '.studio', 'context.md'), 'utf8')).toBe(CONTEXT_MD);
  });

  it('asks the agent to fix missing outputs and then succeeds', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'render_missing_once';
    await finalState((await service.start(ref)).id);
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1!.status).toBe('complete');
    const all = await prompts();
    expect(all).toHaveLength(2);
    expect(all[1]!.prompt).toContain('Manca il formato Web · Banner 300×250 (web-banner-300x250)');
    expect(all[1]!.args).toContain('--resume');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text.includes('tentativo 2 di 3'))).toBe(true);
  });

  it('saves an incomplete version after 3 attempts', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'render_never';
    await finalState((await service.start(ref)).id);
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1).toMatchObject({ status: 'incomplete', problems: ['Manca il formato Web · Banner 300×250 (web-banner-300x250)'] });
    expect(await prompts()).toHaveLength(3);
    expect((await store.get(ref.creativeSlug)).status).toBe('incomplete');
  });

  it('marks the creative as error when the agent crashes, without a version', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    const job = await service.start(ref);
    expect(await finalState(job.id)).toBe('failed');
    const c = await store.get(ref.creativeSlug);
    expect(c.status).toBe('error');
    expect(c.error).toContain('boom');
    expect(await store.readVersions(ref.creativeSlug)).toEqual([]);
    expect((await store.readConversation(ref.creativeSlug)).at(-1)).toMatchObject({ type: 'system', level: 'error' });
  });

  it('restores the previous status when cancelled', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.start(ref);
    await new Promise((r) => setTimeout(r, 400));
    queue.cancel(job.id);
    expect(await finalState(job.id)).toBe('cancelled');
    expect((await store.get(ref.creativeSlug)).status).toBe('draft');
    expect((await store.readConversation(ref.creativeSlug)).at(-1)).toMatchObject({ type: 'system', text: 'Generazione annullata.' });
  });

  it('iterates with a message and pins on the same session', async () => {
    await finalState((await service.start(ref)).id);
    await finalState((await service.start(ref, { text: 'Logo più grande', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.25, timeSec: 2, note: 'qui' }] })).id);
    const versions = await store.readVersions(ref.creativeSlug);
    expect(versions.map((v) => [v.n, v.request, v.basedOn])).toEqual([[1, 'Generazione dal brief', null], [2, 'Logo più grande', 1]]);
    const last = (await prompts()).at(-1)!;
    expect(last.prompt).toContain('instagram-post-1x1 @ 2.0s, punto (50%, 25%): qui');
    expect(last.args.slice(last.args.indexOf('--resume'), last.args.indexOf('--resume') + 2)).toEqual(['--resume', 'fake-session-1']);
    expect((await store.readConversation(ref.creativeSlug)).find((e) => e.type === 'user')).toMatchObject({ text: 'Logo più grande' });
  });

  it('rejects a second job on the same creative', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.start(ref);
    await expect(service.start(ref)).rejects.toBeInstanceOf(JobConflictError);
    queue.cancel(job.id);
    await queue.whenIdle();
  });

  it('restores work/ to a past version and forks its session for the next turn', async () => {
    await finalState((await service.start(ref)).id);
    const v1Scene = await readFile(join(store.workDir(ref.creativeSlug), 'scene.txt'), 'utf8');
    await finalState((await service.start(ref, { text: 'cambia', pins: [] })).id);
    const restored = await service.restore(ref, 1);
    expect(restored.resumeFrom).toEqual({ version: 1, sessionId: 'fake-session-1' });
    expect(await readFile(join(store.workDir(ref.creativeSlug), 'scene.txt'), 'utf8')).toBe(v1Scene);
    await finalState((await service.start(ref, { text: 'da v1', pins: [] })).id);
    const last = (await prompts()).at(-1)!;
    expect(last.args).toContain('--fork-session');
    const v3 = (await store.readVersions(ref.creativeSlug)).at(-1)!;
    expect(v3).toMatchObject({ n: 3, basedOn: 1, sessionId: 'fake-session-1-fork' });
    expect((await store.get(ref.creativeSlug)).resumeFrom).toBeNull();
  });

  it('refuses to restore an unknown version with 404', async () => {
    const err = await service.restore(ref, 7).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it('stops retrying when the only problems are unknown presets', async () => {
    await store.update(ref.creativeSlug, { brief: { ...brief, formats: [...brief.formats, 'ghost'] } });
    await finalState((await service.start(ref)).id);
    expect(await prompts()).toHaveLength(1);
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1!.status).toBe('incomplete');
    expect(v1!.problems.some((p) => p.startsWith('Preset sconosciuto: ghost'))).toBe(true);
    expect((await store.get(ref.creativeSlug)).status).toBe('incomplete');
  });
});
