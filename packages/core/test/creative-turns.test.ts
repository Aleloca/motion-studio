import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, type Brief, type ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AGENT_ALLOWED_TOOLS } from '../src/agent/runner.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';
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

describe('CreativeTurnService', { timeout: 20_000 }, () => {
  it('generates v1 from the brief: outputs, version, commit, conversation, status', async () => {
    const job = await service.start(ref);
    expect(job.key).toBe(`creative:${ref.root}:${ref.projectSlug}:${ref.creativeSlug}`);
    expect(await finalState(job.id)).toBe('succeeded');
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1).toMatchObject({ n: 1, status: 'complete', problems: [], sessionId: 'fake-session-1', request: 'Generazione dal brief', basedOn: null, tools: ['fake'] });
    expect(v1!.outputs.map((o) => o.file)).toEqual(['instagram-post-1x1.mp4', 'web-banner-300x250.png']);
    expect(v1!.commit).toMatch(/^[0-9a-f]{40}$/);
    const log = await execCommand('git', ['log', '-1', '--format=%s', 'HEAD~1'], { cwd: ref.projectDir });
    expect(log.stdout.trim()).toBe('Lancio: v1');
    expect((await store.get(ref.creativeSlug)).status).toBe('ready');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'agent')).toBe(true);
    expect(conv.at(-1)).toMatchObject({ type: 'version', n: 1, status: 'complete' });
    expect(messages.some((m) => m.type === 'creative')).toBe(true);
    expect((await prompts())[0]!.prompt).toContain('Realizza la creatività "Lancio" (versione 1)');
  });

  it('lets every creative turn (first, fix, iteration) use the allowed tool rules', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'render_missing_once';
    await finalState((await service.start(ref)).id);
    process.env.FAKE_CLAUDE_SCENARIO = 'render';
    await finalState((await service.start(ref, { text: 'ancora', pins: [] })).id);
    const all = await prompts();
    expect(all).toHaveLength(3);
    for (const { args } of all) expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual([...AGENT_ALLOWED_TOOLS]);
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
    const err = await service.start(ref).catch((e) => e);
    expect(err).toMatchObject({ status: 409, message: 'Una generazione è già in corso per questa creatività' });
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

  it('restores the creative when it is cancelled while still queued', async () => {
    const q1 = new JobQueue({ concurrency: 1 });
    const svc = new CreativeTurnService({
      queue: q1, git: new Git(), media: NoMediaTools,
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    let release!: () => void;
    q1.enqueue({ key: 'blocker', label: 'blocker', run: () => new Promise<void>((r) => { release = r; }) });
    const job = await svc.start(ref);
    expect((await store.get(ref.creativeSlug)).status).toBe('working');
    q1.cancel(job.id);
    await new Promise((r) => setTimeout(r, 200));
    expect((await store.get(ref.creativeSlug)).status).toBe('draft');
    expect((await store.readConversation(ref.creativeSlug)).at(-1)).toMatchObject({ type: 'system', text: 'Generazione annullata.' });
    release();
    await q1.whenIdle();
  });

  it('fails the job when a conversation write fails, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const original = CreativeStore.prototype.appendConversation;
    CreativeStore.prototype.appendConversation = async function (this: CreativeStore, slug, entry) {
      if (entry.type === 'agent') throw new Error('disco pieno');
      return original.call(this, slug, entry);
    };
    try {
      const job = await service.start(ref);
      expect(await finalState(job.id)).toBe('failed');
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      CreativeStore.prototype.appendConversation = original;
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    const c = await store.get(ref.creativeSlug);
    expect(c.status).toBe('error');
    expect(c.error).toContain('disco pieno');
  });

  it('does not fail the turn when extracting a pin frame throws', async () => {
    await finalState((await service.start(ref)).id);
    const throwing: MediaTools = { available: true, probe: async () => null, poster: async () => false, frame: async () => { throw new Error('ffmpeg esploso'); } };
    const svc = new CreativeTurnService({
      queue, git: new Git(), media: throwing,
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    const job = await svc.start(ref, { text: 'ritocca', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 1, note: 'qui' }] });
    expect(await finalState(job.id)).toBe('succeeded');
    expect((await store.readVersions(ref.creativeSlug)).map((v) => v.n)).toEqual([1, 2]);
  });

  it('a start() right after a queued cancel is not clobbered by the stale cleanup', async () => {
    const q1 = new JobQueue({ concurrency: 1 });
    const svc = new CreativeTurnService({
      queue: q1, git: new Git(), media: NoMediaTools,
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    let release!: () => void;
    q1.enqueue({ key: 'blocker', label: 'blocker', run: () => new Promise<void>((r) => { release = r; }) });
    const first = await svc.start(ref);
    q1.cancel(first.id);
    const second = svc.start(ref);
    release();
    await second;
    await q1.whenIdle();
    expect((await store.get(ref.creativeSlug)).status).toBe('ready');
    expect(await store.readVersions(ref.creativeSlug)).toHaveLength(1);
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text === 'Generazione annullata.')).toBe(false);
  });

  it('clears the outputs left by a failed turn before the next attempt', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'render_then_crash';
    expect(await finalState((await service.start(ref)).id)).toBe('failed');
    const v1Dir = store.outputsDir(ref.creativeSlug, 1);
    expect(await readdir(v1Dir)).toContain('manifest.json');
    process.env.FAKE_CLAUDE_SCENARIO = 'ok'; // the retry delivers nothing: stale files must not count
    expect(await finalState((await service.start(ref, { text: 'riprova', pins: [] })).id)).toBe('succeeded');
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1).toMatchObject({ n: 1, status: 'incomplete', problems: ['manifest.json mancante in v1'] });
    expect(await readdir(v1Dir).catch(() => [])).not.toContain('instagram-post-1x1.mp4');
  });

  it('never removes the outputs folder of a saved version', async () => {
    await finalState((await service.start(ref)).id);
    // Out-of-order versions.json: the next number (2) is already a saved version.
    const [v1] = await store.readVersions(ref.creativeSlug);
    await writeFile(join(store.dir(ref.creativeSlug), 'versions.json'), JSON.stringify({ schemaVersion: 1, versions: [{ ...v1, n: 2 }, v1] }));
    await mkdir(store.outputsDir(ref.creativeSlug, 2), { recursive: true });
    await writeFile(join(store.outputsDir(ref.creativeSlug, 2), 'saved.txt'), 'keep');
    await finalState((await service.start(ref, { text: 'ancora', pins: [] })).id);
    expect(await readFile(join(store.outputsDir(ref.creativeSlug, 2), 'saved.txt'), 'utf8')).toBe('keep');
  });

  it('extracts pin frames from the version being resumed from', async () => {
    await finalState((await service.start(ref)).id);
    await finalState((await service.start(ref, { text: 'cambia', pins: [] })).id);
    await service.restore(ref, 1);
    const sources: string[] = [];
    const media: MediaTools = {
      available: true,
      probe: async (p) => (p.endsWith('.png') ? { width: 300, height: 250, durationSec: null } : { width: 1080, height: 1080, durationSec: 10 }),
      poster: async () => false,
      frame: async (input) => { sources.push(input); return false; },
    };
    const svc = new CreativeTurnService({
      queue, git: new Git(), media, runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    await finalState((await svc.start(ref, { text: 'da v1', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 1 }] })).id);
    expect(sources).toEqual([join(store.outputsDir(ref.creativeSlug, 1), 'instagram-post-1x1.mp4')]);
  });

  it('a pins-only message uses a neutral instruction as request and prompt', async () => {
    await finalState((await service.start(ref)).id);
    await finalState((await service.start(ref, { text: '', pins: [{ format: 'instagram-post-1x1', x: 0.1, y: 0.2, timeSec: null, note: 'più luce' }] })).id);
    expect((await store.readVersions(ref.creativeSlug)).at(-1)!.request).toBe('Applica i commenti puntuali.');
    const last = (await prompts()).at(-1)!.prompt;
    expect(last).toContain('## Richiesta\nApplica i commenti puntuali.');
    expect(last).not.toContain('Rigenera tutti i formati');
  });

  describe('late cancel (after the last agent turn)', () => {
    const lateCancelService = (git: Git) => {
      let jobId = '';
      const media: MediaTools = {
        available: true,
        probe: async (p) => {
          queue.cancel(jobId); // the abort arrives while the outputs are being validated
          return p.endsWith('.png') ? { width: 300, height: 250, durationSec: null } : { width: 1080, height: 1080, durationSec: 10 };
        },
        poster: async () => false, frame: async () => false,
      };
      const svc = new CreativeTurnService({
        queue, git, media, runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
        presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
      });
      return { start: async () => { jobId = (await svc.start(ref)).id; return jobId; } };
    };

    it('still saves the version and tells the user', async () => {
      const id = await lateCancelService(new Git()).start();
      expect(await finalState(id)).toBe('succeeded');
      expect((await store.readVersions(ref.creativeSlug)).map((v) => v.n)).toEqual([1]);
      expect((await store.get(ref.creativeSlug)).status).toBe('ready');
      const conv = await store.readConversation(ref.creativeSlug);
      expect(conv.at(-1)).toMatchObject({ type: 'system', level: 'info', text: 'Annullamento arrivato a lavoro quasi concluso: la versione v1 è stata salvata.' });
      expect(conv.some((e) => e.type === 'system' && e.text === 'Generazione annullata.')).toBe(false);
    });

    it('treats a commit error after the late abort as a failure, not a cancel', async () => {
      const git = new Git();
      git.commitAll = async () => { throw new Error('git commit fallito: disco pieno'); };
      const id = await lateCancelService(git).start();
      expect(await finalState(id)).toBe('failed');
      const c = await store.get(ref.creativeSlug);
      expect(c).toMatchObject({ status: 'error', error: 'git commit fallito: disco pieno' });
      expect(await store.readVersions(ref.creativeSlug)).toEqual([]);
      const conv = await store.readConversation(ref.creativeSlug);
      expect(conv.some((e) => e.type === 'system' && e.text === 'Generazione annullata.')).toBe(false);
    });
  });

  it('updateBrief edits title and brief, and refuses while a generation is active', async () => {
    const updated = await service.updateBrief(ref, { title: 'Nuovo', brief: { ...brief, durationSec: 6 } });
    expect(updated).toMatchObject({ title: 'Nuovo', brief: { durationSec: 6 } });
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.start(ref);
    const err = await service.updateBrief(ref, { title: 'Altro' }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, message: 'Attendi la fine della generazione in corso prima di modificare il brief' });
    expect((await store.get(ref.creativeSlug)).title).toBe('Nuovo');
    queue.cancel(job.id);
    await queue.whenIdle();
  });

  it('restore removes unsaved files in work/ (keeping ignored ones) and logs how many', async () => {
    await finalState((await service.start(ref)).id);
    const work = store.workDir(ref.creativeSlug);
    await writeFile(join(work, 'appunti.txt'), 'non salvato');
    await mkdir(join(work, 'tmp'), { recursive: true });
    await writeFile(join(work, 'tmp', 'x.txt'), 'x');
    await mkdir(join(work, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(work, 'node_modules', 'pkg', 'index.js'), '');
    await service.restore(ref, 1);
    const entries = await readdir(work);
    expect(entries).not.toContain('appunti.txt');
    expect(entries).not.toContain('tmp');
    expect(entries).toContain('node_modules');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text === 'Rimossi 2 file non salvati in una versione')).toBe(true);
  });

  it('restore logs nothing about removed files when work/ is clean', async () => {
    await finalState((await service.start(ref)).id);
    await service.restore(ref, 1);
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text.startsWith('Rimossi'))).toBe(false);
  });

  it('leaves the project tree clean after a version, a brief edit and a restore', async () => {
    const clean = async () => (await execCommand('git', ['status', '--porcelain'], { cwd: ref.projectDir })).stdout.trim();
    await finalState((await service.start(ref)).id);
    expect(await clean()).toBe('');
    const log = (await execCommand('git', ['log', '--format=%s'], { cwd: ref.projectDir })).stdout.trim().split('\n');
    expect(log.slice(0, 2)).toEqual(['Lancio: v1 · stato', 'Lancio: v1']);
    const [v1] = await store.readVersions(ref.creativeSlug);
    const workCommit = (await execCommand('git', ['rev-parse', 'HEAD~1'], { cwd: ref.projectDir })).stdout.trim();
    expect(v1!.commit).toBe(workCommit);
    await service.updateBrief(ref, { title: 'Lancio 2' });
    expect(await clean()).toBe('');
    await finalState((await service.start(ref, { text: 'x', pins: [] })).id);
    await service.restore(ref, 1);
    expect(await clean()).toBe('');
  });

  it('a failing "· stato" commit does not fail a saved version', async () => {
    const git = new Git();
    const real = git.commitAll.bind(git);
    git.commitAll = async (dir, msg) => { if (msg.endsWith('· stato')) throw new Error('disco pieno'); return real(dir, msg); };
    const svc = new CreativeTurnService({
      queue, git, media: NoMediaTools,
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    expect(await finalState((await svc.start(ref)).id)).toBe('succeeded');
    expect((await store.get(ref.creativeSlug)).status).toBe('ready');
    expect(await store.readVersions(ref.creativeSlug)).toHaveLength(1);
  });

  it('keeps the original failure when creative.json is unreadable while committing state', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.start(ref);
    await new Promise((r) => setTimeout(r, 500));
    await writeFile(join(ref.projectDir, 'creatives', ref.creativeSlug, 'creative.json'), '{broken');
    queue.cancel(job.id);
    expect(await finalState(job.id)).toBe('cancelled');
  });
});

describe('brand and codebases in creative turns', { timeout: 20_000 }, () => {
  const sys = async () => (await store.readConversation(ref.creativeSlug)).flatMap((e) => (e.type === 'system' ? [e] : []));
  it('passes existing codebases read-only, warns about missing ones and adds the brand to the prompt', async () => {
    const cbBase = await mkdtemp(join(tmpdir(), 'ms-cb è '));
    const appDir = join(cbBase, 'app ios');
    await mkdir(appDir);
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: appDir, note: 'iOS' }, { path: join(cbBase, 'missing') }] });
    await new BrandStore(ref.projectDir).writeKit({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: { kind: 'manual', ref: null } }], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null });
    await finalState((await service.start(ref)).id);
    const { prompt, args } = (await prompts())[0]!;
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', appDir]);
    expect(args).toContain(`Edit(/${appDir}/**)`);
    expect(prompt).toContain('- Colore Blu (primary): #1E3A5F');
    expect(prompt).toContain(`- ${appDir}: iOS`);
    const entries = await sys();
    expect(entries.some((e) => e.text === `Codebase non trovata, ignorata in questo turno: ${join(cbBase, 'missing')}`)).toBe(true);
    const unchecked = entries.filter((e) => e.text.includes('non controllabile'));
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toMatchObject({ level: 'info', text: `Codebase ${appDir} non controllabile (non è un repository git): eventuali modifiche non verrebbero rilevate` });
  });
  it('warns when a linked git codebase changed during the turn', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await execCommand('git', ['init', '-q'], { cwd: repo });
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: repo }] });
    process.env.FAKE_CLAUDE_SCENARIO = 'render_touch';
    process.env.FAKE_CLAUDE_TOUCH = join(repo, 'touched.txt');
    await finalState((await service.start(ref)).id);
    delete process.env.FAKE_CLAUDE_TOUCH;
    const entries = await sys();
    expect(entries.some((e) => e.level === 'error' && e.text.includes(`la codebase ${repo} risulta modificata`))).toBe(true);
    expect(entries.some((e) => e.text.includes('non controllabile'))).toBe(false);
  });
  it('warns when an already modified tracked file is modified again', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    const git = (...a: string[]) => execCommand('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
    await git('init', '-q');
    await writeFile(join(repo, 'tracked.txt'), 'v1');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');
    await writeFile(join(repo, 'tracked.txt'), 'dirty');
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: repo }] });
    process.env.FAKE_CLAUDE_SCENARIO = 'render_touch';
    process.env.FAKE_CLAUDE_TOUCH = join(repo, 'tracked.txt');
    await finalState((await service.start(ref)).id);
    delete process.env.FAKE_CLAUDE_TOUCH;
    expect((await sys()).some((e) => e.level === 'error' && e.text.includes(`la codebase ${repo} risulta modificata`))).toBe(true);
  });
  it('uses creative-level codebases and passes a path linked twice once', async () => {
    const cb = await mkdtemp(join(tmpdir(), 'ms-cb-dup-'));
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: cb }] });
    await store.update(ref.creativeSlug, { linkedCodebases: [{ path: `${cb}/`, note: 'dup' }] });
    await finalState((await service.start(ref)).id);
    const { args } = (await prompts())[0]!;
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(args).toContain(cb);
  });
  it('warns when a non-repo codebase becomes a repo during the turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cb-plain-'));
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: dir }] });
    process.env.FAKE_CLAUDE_SCENARIO = 'render_touch';
    process.env.FAKE_CLAUDE_TOUCH = join(dir, 'x.txt');
    process.env.FAKE_CLAUDE_GIT_INIT = dir;
    await finalState((await service.start(ref)).id);
    delete process.env.FAKE_CLAUDE_GIT_INIT;
    delete process.env.FAKE_CLAUDE_TOUCH;
    expect((await sys()).some((e) => e.level === 'error' && e.text.includes(`la codebase ${dir} risulta modificata`))).toBe(true);
  });
  it('skips linked folders that overlap the project or the workspace, with a note', async () => {
    const cb = await mkdtemp(join(tmpdir(), 'ms-cb-ok-'));
    // Written behind the API's back (hand-edited project.json): the turn must not hand the project to --add-dir.
    const pj = JSON.parse(await readFile(join(ref.projectDir, 'project.json'), 'utf8'));
    pj.linkedCodebases = [{ path: ref.root }, { path: join(ref.projectDir, 'assets') }, { path: cb }];
    await writeFile(join(ref.projectDir, 'project.json'), JSON.stringify(pj));
    expect(await finalState((await service.start(ref)).id)).toBe('succeeded');
    const { args } = (await prompts())[0]!;
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1);
    expect(args[args.indexOf('--add-dir') + 1]).toBe(cb);
    const texts = (await sys()).map((e) => e.text);
    expect(texts).toContain(`Codebase ignorata (${ref.root}): La cartella collegata non può contenere il progetto né trovarsi al suo interno`);
    expect(texts).toContain(`Codebase ignorata (${join(ref.projectDir, 'assets')}): La cartella collegata non può contenere il progetto né trovarsi al suo interno`);
  });
  it('keeps working with a corrupt brand kit', async () => {
    await mkdir(join(ref.projectDir, 'brand'), { recursive: true });
    await writeFile(join(ref.projectDir, 'brand', 'brand-kit.json'), '{oops');
    const job = await service.start(ref);
    expect(await finalState(job.id)).toBe('succeeded');
    expect((await sys()).some((e) => e.text.startsWith('Brand kit non leggibile'))).toBe(true);
  });
});
