import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { BrandService, type ProjectRef } from '../src/brand/brand-analysis.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const T = { timeout: 20_000 };
let ref: ProjectRef;
let queue: JobQueue;
let service: BrandService;
let brand: BrandStore;
let messages: ServerMessage[];
let promptFile: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-ba è '));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  ref = { root: ws.root, projectSlug: slug, projectDir: ws.projectDir(slug) };
  queue = new JobQueue({ concurrency: 2 });
  messages = [];
  service = new BrandService({ queue, git, media: NoMediaTools, runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), model: async () => null, broadcast: (m) => messages.push(m) });
  brand = new BrandStore(ref.projectDir);
  await brand.writeKit({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: { kind: 'manual', ref: null } }] });
  await brand.addSource({ kind: 'website', url: 'https://acme.example' });
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_SCENARIO = 'brand';
});
afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_PROMPT_FILE; });
const done = async (id: string) => { await queue.whenIdle(); return queue.list().find((j) => j.id === id)!; };

describe('analyze', () => {
  it('produces an open proposal, registers downloaded assets and never touches the kit', T, async () => {
    const job = await service.analyze(ref);
    expect((await done(job.id)).state).toBe('succeeded');
    const [p] = await brand.listProposals();
    expect(p).toMatchObject({ status: 'open', sourceIds: ['s-1'], assetsAdded: ['brand/logo.svg', 'brand/unlisted.png'] });
    expect(p!.changes.map((c) => c.id)).toEqual(['colors:add:arancio', 'logos:add:logo']);
    expect(p!.summary).toContain('Palette arancio/blu');
    expect(p!.summary).toContain('ghost');
    expect(p!.guidelines).toEqual({ current: '', proposed: '# Linee guida\nTono energico.' });
    expect((await brand.readKit()).colors.map((c) => c.id)).toEqual(['blu']);
    const assets = await new LibraryStore(ref.projectDir, NoMediaTools).listAssets();
    expect(assets.find((a) => a.file === 'brand/logo.svg')).toMatchObject({ origin: 'website', description: 'Logo principale', sourceUrl: 'https://acme.example/logo.svg' });
    expect(assets.find((a) => a.file === 'brand/unlisted.png')).toMatchObject({ origin: 'website', sourceUrl: null });
    expect((await brand.readSources())[0]!.lastAnalyzedAt).not.toBeNull();
    const { prompt, args } = JSON.parse((await readFile(promptFile, 'utf8')).trim().split('\n')[0]!);
    expect(prompt).toContain('https://acme.example');
    expect(args).toContain('WebFetch');
    expect(messages.some((m) => m.type === 'brand')).toBe(true);
    const log = await execCommand('git', ['log', '-1', '--format=%s'], { cwd: ref.projectDir });
    expect(log.stdout.trim()).toBe(`Analisi brand ${p!.id}`);
  });
  it('fails cleanly on an invalid proposed kit and leaves no proposal', T, async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'brand_invalid';
    const job = await done((await service.analyze(ref)).id);
    expect(job.state).toBe('failed');
    expect(job.error).toContain('Proposta non valida');
    expect(await brand.listProposals()).toEqual([]);
  });
  it('refuses to start without sources and while another brand job runs', T, async () => {
    await brand.removeSource('s-1');
    expect((await service.analyze(ref).catch((e) => e)).status).toBe(400);
    await brand.addSource({ kind: 'website', url: 'https://acme.example' });
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.analyze(ref);
    const conflict = await service.analyze(ref).catch((e) => e);
    expect(conflict.status).toBe(409);
    expect(conflict.message).not.toContain(ref.projectDir);
    expect((await service.describeAssets(ref).catch((e) => e)).status).toBe(409);
    queue.cancel(job.id);
    await queue.whenIdle();
    expect(await brand.listProposals()).toEqual([]);
  });
});

describe('apply / discard', () => {
  it('applies only accepted changes and the guidelines when asked', T, async () => {
    await done((await service.analyze(ref)).id);
    const [p] = await brand.listProposals();
    const { kit, proposal } = await service.applyProposal(ref, p!.id, ['colors:add:arancio'], true);
    expect(kit.colors.map((c) => c.id)).toEqual(['blu', 'arancio']);
    expect(kit.logos).toEqual([]);
    expect(proposal.status).toBe('applied');
    expect(await brand.readGuidelines()).toBe('# Linee guida\nTono energico.');
    expect((await service.applyProposal(ref, p!.id, [], false).catch((e) => e)).status).toBe(409);
  });
  it('discards without touching the kit', T, async () => {
    await done((await service.analyze(ref)).id);
    const [p] = await brand.listProposals();
    expect((await service.discardProposal(ref, p!.id)).status).toBe('discarded');
    expect((await brand.readKit()).colors).toHaveLength(1);
  });
});

describe('describeAssets', () => {
  it('fills descriptions of assets without one', T, async () => {
    const lib = new LibraryStore(ref.projectDir, NoMediaTools);
    await writeFile(join(ref.projectDir, 'assets', 'foto.jpg'), 'x');
    await lib.registerAssets([{ file: 'foto.jpg', origin: 'upload' }]);
    const job = await done((await service.describeAssets(ref)).id);
    expect(job.state).toBe('succeeded');
    expect((await lib.listAssets())[0]).toMatchObject({ description: 'Descrizione di assets/foto.jpg', tags: ['auto'] });
    await expect(stat(join(ref.projectDir, 'assets', '.describe'))).resolves.toBeTruthy();
    expect((await service.describeAssets(ref).catch((e) => e)).status).toBe(400);
  });
});
