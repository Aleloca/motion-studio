import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner, AgentTurnRequest } from '../src/agent/runner.ts';
import { BrandService, type ProjectRef } from '../src/brand/brand-analysis.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { setLocale } from '../src/i18n.ts';
import { fixtureCodebase } from './helpers/brand-codebase.ts';
import { testLauncher } from './helpers/launcher.ts';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const cleanup: string[] = [];
let ref: ProjectRef;
let queue: JobQueue;
let brand: BrandStore;
let requests: AgentTurnRequest[];
/** What the fake agent does besides writing its proposal (e.g. touch the codebase). */
let sideEffect: (() => Promise<void>) | null;

/**
 * The fake agent: never a real `claude`. It reads the prompt's block, writes a proposal with one color from the codebase
 * and one from the site, then runs the test's side effect.
 */
const fakeRunner: AgentRunner = {
  start(req) {
    requests.push(req);
    const done = (async () => {
      const raw = /```motion-studio-brand\n(.*)\n```/s.exec(req.prompt)![1]!;
      const block = JSON.parse(raw) as { kitFile: string; summaryFile: string };
      const kit = JSON.parse(await readFile(join(req.cwd, block.kitFile), 'utf8'));
      kit.colors.push({ id: 'accent', name: 'Accent', hex: '#F28C28', role: 'accent', source: { kind: 'codebase', ref: 'src/theme.css' } });
      kit.colors.push({ id: 'navy', name: 'Navy', hex: '#1E3A5F', role: 'primary', source: { kind: 'website', ref: 'https://acme.example' } });
      await writeFile(join(req.cwd, block.kitFile), JSON.stringify(kit));
      await writeFile(join(req.cwd, block.summaryFile), 'Colors from the theme and the site.');
      if (sideEffect) await sideEffect();
      return { status: 'succeeded' as const };
    })();
    return { done, cancel: () => {} };
  },
};

beforeEach(async () => {
  setLocale('en');
  const base = await mkdtemp(join(tmpdir(), 'ms-bac-'));
  cleanup.push(base);
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  ref = { root: ws.root, projectSlug: slug, projectDir: ws.projectDir(slug) };
  queue = new JobQueue({ concurrency: 1 });
  requests = [];
  sideEffect = null;
  brand = new BrandStore(ref.projectDir);
});
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });

const service = () => new BrandService({ queue, git: new Git(), media: NoMediaTools, launcher: testLauncher(fakeRunner), model: async () => null, broadcast: () => {} });
const finished = async (id: string) => { await queue.whenIdle(); return queue.list().find((j) => j.id === id)!; };
const addCodebase = async (git = true) => {
  const cb = await fixtureCodebase({ git });
  cleanup.push(dirname(cb));
  await brand.addSource({ kind: 'codebase', path: cb, real: cb, note: 'web app' });
  return cb;
};

describe('a brand analysis of a site and a codebase', () => {
  it('keeps both source kinds in the prompt, reads the codebase read-only and proposes codebase-sourced items', async () => {
    await brand.addSource({ kind: 'website', url: 'https://acme.example' });
    const cb = await addCodebase();
    const job = await service().analyze(ref);
    const end = await finished(job.id);
    expect(end.state, end.error).toBe('succeeded');
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain('- Website (s-1): https://acme.example');
    expect(prompt).toContain(`- Codebase (s-2): ${cb} (note from the user: web app)`);
    expect(prompt).toContain('## Codebases (read-only)');
    for (const s of ['`.env*`', '`*.pem`', '`.git/**`', '`node_modules`', '`Pods`', '`.next`', 'import_codebase_file', 'tailwind.config.*', 'manifest.json', 'fastlane/metadata', '{"kind":"codebase","ref":']) expect(prompt).toContain(s);
    expect(prompt.indexOf('Tokens and theme')).toBeLessThan(prompt.indexOf('Fonts: `@font-face`'));
    const block = JSON.parse(/```motion-studio-brand\n(.*)\n```/s.exec(prompt)![1]!);
    expect(block.sources).toEqual([
      { id: 's-1', kind: 'website', url: 'https://acme.example', file: null },
      { id: 's-2', kind: 'codebase', url: null, file: null, path: cb, note: 'web app' },
    ]);
    expect(requests[0]!.addDirs).toEqual([cb]);
    expect(requests[0]!.disallowedTools).toContain(`Read(/${cb}/**/.env*)`);
    const [p] = await brand.listProposals();
    expect(p).toMatchObject({ status: 'open', sourceIds: ['s-1', 's-2'] });
    const accent = p!.changes.find((c) => c.itemId === 'accent')!;
    expect(accent.after).toMatchObject({ source: { kind: 'codebase', ref: 'src/theme.css' } });
    // No sandbox in this launcher: the job says the secrets are kept out by tool rules only.
    expect(end.notes).toEqual([expect.stringMatching(/tool rules only/)]);
  });
  it('without codebase sources nothing about codebases reaches the agent', async () => {
    await brand.addSource({ kind: 'website', url: 'https://acme.example' });
    const job = await service().analyze(ref);
    expect((await finished(job.id)).state).toBe('succeeded');
    expect(requests[0]!.prompt).not.toContain('## Codebases');
    expect(requests[0]!.addDirs).toEqual([]);
    expect(requests[0]!.allowedTools).not.toContain('Read');
  });
});

describe('Review Focus 2: the agent writes into the codebase anyway', () => {
  it('discards the proposal, fails the job naming the folder and lists the changed files', async () => {
    const cb = await addCodebase();
    sideEffect = async () => {
      await writeFile(join(cb, 'src', 'injected.ts'), 'export {};\n');
      await writeFile(join(cb, 'src', 'theme.css'), ':root { --color-primary: #000000; }\n');
    };
    const job = await service().analyze(ref);
    const end = await finished(job.id);
    expect(end.state).toBe('failed');
    expect(end.error).toContain(cb);
    expect(end.error).toMatch(/proposal was discarded/);
    const files = end.notes!.find((n) => n.startsWith(`Files changed in ${cb}`))!;
    expect(files).toContain('src/injected.ts');
    expect(files).toContain('src/theme.css');
    expect(await brand.listProposals()).toEqual([]);
    // The proposal folder of the run is gone with it.
    expect(await readdir(join(ref.projectDir, 'brand', 'proposals'))).toEqual([]);
  });
  it('a folder that is not a git repository gets the "not checkable" note and is still analysed', async () => {
    const cb = await addCodebase(false);
    const job = await service().analyze(ref);
    const end = await finished(job.id);
    expect(end.state, end.error).toBe('succeeded');
    expect(end.notes).toContainEqual(`Codebase ${cb} cannot be checked (not a git repository): a change by the analysis would go unnoticed`);
    expect(await brand.listProposals()).toHaveLength(1);
  });
});

describe('codebase sources that no longer pass', () => {
  it('are left out with a note; with nothing left the analysis fails', async () => {
    await brand.addSource({ kind: 'website', url: 'https://acme.example' });
    const cb = await addCodebase();
    await rm(cb, { recursive: true, force: true });
    const job = await service().analyze(ref);
    const end = await finished(job.id);
    expect(end.state, end.error).toBe('succeeded');
    expect(end.notes).toEqual([`Codebase left out of the analysis (${cb}): Folder not found: ${cb}`]);
    expect(requests[0]!.prompt).not.toContain('## Codebases');
    expect((await brand.listProposals())[0]!.sourceIds).toEqual(['s-1']);

    await brand.removeSource('s-1');
    const second = await service().analyze(ref);
    const failed = await finished(second.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/None of the sources can be analyzed/);
  });
});
