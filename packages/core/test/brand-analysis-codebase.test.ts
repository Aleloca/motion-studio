import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { messages } from '@motion-studio/shared';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner, AgentTurnRequest } from '../src/agent/runner.ts';
import { BrandService, type ProjectRef } from '../src/brand/brand-analysis.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { importCodebaseTool } from '../src/bridge/import-codebase-tool.ts';
import { LibraryStore } from '../src/library/library-store.ts';
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
let sideEffect: ((req: AgentTurnRequest) => Promise<void>) | null;

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
      if (sideEffect) await sideEffect(req);
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

const service = (launcher = testLauncher(fakeRunner)) => new BrandService({ queue, git: new Git(), media: NoMediaTools, launcher, model: async () => null, broadcast: () => {} });
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
    // A website source keeps WebFetch; the codebase gets scoped reads only, and no Bash or Grep (fix round 1).
    expect(requests[0]!.allowedTools).toEqual(expect.arrayContaining(['WebFetch', `Read(/${cb}/**)`, `Glob(/${cb}/**)`]));
    expect(requests[0]!.allowedTools!.filter((r) => /^(Read|Glob|Grep|Bash)(\(|$)/.test(r) && !r.includes(cb) && !r.includes('[')))
      .toEqual([]);
    expect(requests[0]!.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Grep']));
    expect(requests[0]!.disallowedTools).not.toContain('WebFetch');
    expect(prompt).not.toContain('Grep');
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

describe('a codebase-only analysis', () => {
  it('has no WebFetch at all (neither allowed nor reachable)', async () => {
    const cb = await addCodebase();
    const job = await service().analyze(ref);
    expect((await finished(job.id)).state).toBe('succeeded');
    expect(requests[0]!.allowedTools).not.toContain('WebFetch');
    expect(requests[0]!.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'Bash', 'Grep']));
    expect(requests[0]!.allowedTools).toEqual(expect.arrayContaining([`Read(/${cb}/**)`]));
  });
  it('M4: a refused import mid-run is a tool error and the analysis still succeeds; a good one lands in the library', async () => {
    const cb = await addCodebase();
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:9');
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: () => {} });
    const outcomes: string[] = [];
    sideEffect = async (req) => {
      // The fake agent calls the tool through the job's own bridge context, found with the token the launcher wrote.
      const config = JSON.parse(await readFile(req.mcpConfigPath!, 'utf8'));
      const ctx = bridge.resolve((await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8')).trim())!;
      expect(ctx.codebases).toEqual([cb]);
      try { await tool(ctx, { source: 'config/.env.production', dest: 'assets/brand/x.png' }); outcomes.push('copied'); }
      catch (e) { outcomes.push((e as Error).message.split(':')[0]!); }
      outcomes.push(JSON.stringify(await tool(ctx, { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' })));
    };
    const job = await service(testLauncher(fakeRunner, { bridge, mcpCommand: ['node', '/never/started/server.mjs'] })).analyze(ref);
    const end = await finished(job.id);
    expect(end.state, end.error).toBe('succeeded');
    expect(outcomes).toEqual(['secret', JSON.stringify({ file: 'assets/brand/logo.svg' })]);
    expect(requests[0]!.allowedTools).toContain('mcp__studio__import_codebase_file');
    const [p] = await brand.listProposals();
    expect(p!.assetsAdded).toEqual([]); // registered by the tool itself, not by the proposal's list
    expect((await new LibraryStore(ref.projectDir, NoMediaTools).listAssets()).find((a) => a.file === 'brand/logo.svg')).toMatchObject({ origin: 'codebase', tags: ['brand'] });
  });
});

describe('decision 783: an imported logo keeps its brand tag', () => {
  it('the agent\'s list adds its tags to the import\'s instead of replacing them', async () => {
    await addCodebase();
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:9');
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: () => {} });
    sideEffect = async (req) => {
      const config = JSON.parse(await readFile(req.mcpConfigPath!, 'utf8'));
      const ctx = bridge.resolve((await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8')).trim())!;
      await tool(ctx, { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' });
      const block = JSON.parse(/```motion-studio-brand\n(.*)\n```/s.exec(req.prompt)![1]!) as { assetsListFile: string };
      await writeFile(join(req.cwd, block.assetsListFile), JSON.stringify([{ file: 'brand/logo.svg', description: 'Main logo', tags: ['logo'] }]));
    };
    const end = await finished((await service(testLauncher(fakeRunner, { bridge, mcpCommand: ['node', '/never/started/server.mjs'] })).analyze(ref)).id);
    expect(end.state, end.error).toBe('succeeded');
    expect((await new LibraryStore(ref.projectDir, NoMediaTools).listAssets()).find((a) => a.file === 'brand/logo.svg')).toMatchObject({ origin: 'codebase', description: 'Main logo', tags: ['brand', 'logo'] });
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

describe('I3: the read-only check fails closed', () => {
  const discarded = async (jobId: string) => {
    const end = await finished(jobId);
    expect(end.state).toBe('failed');
    expect(await brand.listProposals()).toEqual([]);
    return end;
  };
  it('git broken by the turn: the check after fails and the proposal is discarded', async () => {
    const cb = await addCodebase();
    sideEffect = async () => { await writeFile(join(cb, '.git', 'HEAD'), 'garbage\n'); };
    const end = await discarded((await service().analyze(ref)).id);
    expect(end.error).toContain(`The check of the codebase ${cb} after the analysis failed`);
  });
  it('an edit to an ignored file\'s content is caught', async () => {
    const cb = await addCodebase();
    await writeFile(join(cb, '.gitignore'), 'dist/\n');
    await mkdir(join(cb, 'dist'));
    await writeFile(join(cb, 'dist', 'app.css'), 'a{}\n');
    sideEffect = async () => { await writeFile(join(cb, 'dist', 'app.css'), 'b{}\n'); };
    const end = await discarded((await service().analyze(ref)).id);
    expect(end.error).toContain(cb);
    expect(end.notes!.find((n) => n.startsWith(`Files changed in ${cb}`))).toContain('dist/app.css');
  });
  it('N2: a check that failed before and works after fails closed as a failed check, not a change', async () => {
    const cb = await addCodebase();
    // A corrupt index makes git status fail before the turn; the fake agent removes it, so git works again after.
    await writeFile(join(cb, '.git', 'index'), 'not an index');
    sideEffect = async () => { await rm(join(cb, '.git', 'index')); };
    const end = await discarded((await service().analyze(ref)).id);
    expect(end.error).toContain(`The codebase ${cb} could not be checked before the analysis but can be now`);
    expect(end.error).not.toMatch(/changed the codebase/);
    expect(end.notes).toContainEqual(`Codebase ${cb}: the change check failed, a change by the analysis would go unnoticed`);
  });
  it('a new git hook is caught', async () => {
    const cb = await addCodebase();
    sideEffect = async () => { await writeFile(join(cb, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); };
    const end = await discarded((await service().analyze(ref)).id);
    expect(end.error).toMatch(/proposal was discarded/);
  });
  it('git config changed by the turn is caught', async () => {
    const cb = await addCodebase();
    sideEffect = async () => { await appendFile(join(cb, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil\n'); };
    await discarded((await service().analyze(ref)).id);
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
  it('decision 781: a stored folder with glob characters (or a plain link to one) is left out with a note, never launched', async () => {
    const holder = await mkdtemp(join(tmpdir(), 'ms-glob-'));
    cleanup.push(holder);
    const bad = join(holder, 'cb (x) [y]');
    await mkdir(bad);
    await mkdir(join(holder, 'other {z}'));
    await symlink(join(holder, 'other {z}'), join(holder, 'alias'));
    // Stored before the check existed (the route refuses them now).
    await brand.addSource({ kind: 'codebase', path: bad, real: bad });
    await brand.addSource({ kind: 'codebase', path: join(holder, 'alias'), real: join(holder, 'other {z}') });
    const job = await service().analyze(ref);
    const end = await finished(job.id);
    expect(end.state).toBe('failed');
    expect(end.error).toMatch(/None of the sources can be analyzed/);
    expect(end.notes).toEqual([
      `Codebase left out of the analysis (${bad}): ${messages('en').errors.codebaseGlobChars({ path: bad })}`,
      `Codebase left out of the analysis (${join(holder, 'alias')}): ${messages('en').errors.codebaseGlobChars({ path: join(holder, 'alias') })}`,
    ]);
    expect(requests).toEqual([]);
  });
});

describe('imports of a discarded run (follow-up batch 2, task 3)', () => {
  const lib = () => new LibraryStore(ref.projectDir, NoMediaTools);
  const files = async () => (await lib().listAssets()).map((a) => a.file).sort();
  const onDisk = async () => (await readdir(join(ref.projectDir, 'assets', 'brand')).catch(() => [] as string[])).filter((f) => f.endsWith('.svg')).sort();
  /** Before the run: a registered file, a kit logo and a creative brief that point at files the run will import. */
  const prepare = async () => {
    const cb = await addCodebase();
    await mkdir(join(ref.projectDir, 'assets', 'brand'), { recursive: true });
    await writeFile(join(ref.projectDir, 'assets', 'brand', 'pre.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await lib().registerAssets([{ file: 'brand/pre.svg', origin: 'codebase', sourceUrl: null, description: '', tags: ['brand'] }]);
    await brand.writeKit({ ...(await brand.readKit()), logos: [{ id: 'main', file: 'assets/brand/kit.svg', variant: 'primary', background: 'any', source: { kind: 'codebase', ref: 'public/logo.svg' } }] });
    await new CreativeStore(ref.projectDir).create({ title: 'Lancio', brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: ['assets/brand/ad.svg'], notes: '' } });
    return cb;
  };
  const importer = (after?: () => Promise<void>, status: 'succeeded' | 'cancelled' = 'succeeded') => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:9');
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: () => {} });
    sideEffect = async (req) => {
      const config = JSON.parse(await readFile(req.mcpConfigPath!, 'utf8'));
      const ctx = bridge.resolve((await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8')).trim())!;
      for (const dest of ['kit', 'ad', 'loose']) await tool(ctx, { source: 'public/logo.svg', dest: `assets/brand/${dest}.svg` });
      // A re-import of a file that was already registered lands under a new name; the registered one is untouched.
      await tool(ctx, { source: 'public/logo.svg', dest: 'assets/brand/pre.svg' });
      await after?.();
    };
    const runner: AgentRunner = { start: (req, on) => { const r = fakeRunner.start(req, on); return { cancel: r.cancel, done: r.done.then((o) => ({ ...o, status })) }; } };
    return service(testLauncher(runner, { bridge, mcpCommand: ['node', '/never/started/server.mjs'] }));
  };
  /** The run registers four imports; the kit and the creative use two; the fifth file is the one registered before. */
  const kept = ['brand/ad.svg', 'brand/kit.svg', 'brand/pre.svg'];

  it('snapshot change: the unreferenced imports are unregistered and removed; referenced and earlier files stay', async () => {
    const cb = await prepare();
    const svc = importer(async () => { await writeFile(join(cb, 'src', 'injected.ts'), 'export {};\n'); });
    const end = await finished((await svc.analyze(ref)).id);
    expect(end.state).toBe('failed');
    expect(await files()).toEqual(kept);
    expect(await onDisk()).toEqual(kept.map((f) => f.slice(6)));
  });
  it('a failed job (unusable proposal): same cleanup', async () => {
    await prepare();
    const bad: AgentRunner = { start: (req, on) => { const r = fakeRunner.start(req, on); return { cancel: r.cancel, done: r.done.then(async (o) => { await writeFile(join(req.cwd, JSON.parse(/```motion-studio-brand\n(.*)\n```/s.exec(req.prompt)![1]!).kitFile), 'not json'); return o; }) }; } };
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:9');
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: () => {} });
    let during: string[] = [];
    sideEffect = async (req) => {
      const config = JSON.parse(await readFile(req.mcpConfigPath!, 'utf8'));
      const ctx = bridge.resolve((await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8')).trim())!;
      for (const dest of ['kit', 'ad', 'loose']) await tool(ctx, { source: 'public/logo.svg', dest: `assets/brand/${dest}.svg` });
      during = await onDisk();
    };
    const end = await finished((await service(testLauncher(bad, { bridge, mcpCommand: ['node', '/never/started/server.mjs'] })).analyze(ref)).id);
    expect(end.state).toBe('failed');
    expect(during).toEqual(['ad.svg', 'kit.svg', 'loose.svg', 'pre.svg']); // present during the run, so removed by the cleanup
    expect(await files()).toEqual(kept);
    expect(await onDisk()).toEqual(kept.map((f) => f.slice(6)));
  });
  it('a corrupt brand kit at discard time: nothing can be checked, so the files stay', async () => {
    await prepare();
    const svc = importer();
    const end = await finished((await svc.analyze(ref)).id);
    expect(end.state, end.error).toBe('succeeded');
    const all = await files();
    const [p] = await brand.listProposals();
    await writeFile(join(ref.projectDir, 'brand', 'brand-kit.json'), 'not json');
    await svc.discardProposal(ref, p!.id);
    expect(await files()).toEqual(all);
  });
  it('a proposal superseded by a newer run is cleaned like a discarded one', async () => {
    await prepare();
    const svc = importer();
    expect((await finished((await svc.analyze(ref)).id)).state).toBe('succeeded');
    const first = (await brand.listProposals())[0]!;
    const afterFirst = await files();
    expect(first.importedFiles).toHaveLength(4);
    // The second run imports nothing of its own that matches; it only supersedes the first.
    sideEffect = null;
    expect((await finished((await service().analyze(ref)).id)).state).toBe('succeeded');
    expect((await brand.listProposals()).find((x) => x.id === first.id)!.status).toBe('discarded');
    const after = await files();
    expect(after).toEqual(expect.arrayContaining(kept));
    for (const f of first.importedFiles!) expect(after.includes(f)).toBe(kept.includes(f));
    expect(afterFirst.length).toBeGreaterThan(after.length);
  });
  it('a file another job registers during the run survives the discard', async () => {
    const cb = await prepare();
    const svc = importer(async () => {
      await writeFile(join(ref.projectDir, 'assets', 'brand', 'other.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await lib().registerAssets([{ file: 'brand/other.svg', origin: 'website', sourceUrl: 'https://x.example/o.svg', description: '', tags: ['brand'] }]);
      await writeFile(join(cb, 'src', 'injected.ts'), 'export {};\n');
    });
    const end = await finished((await svc.analyze(ref)).id);
    expect(end.state).toBe('failed');
    expect(await files()).toEqual([...kept, 'brand/other.svg'].sort());
    expect(await onDisk()).toEqual([...kept, 'brand/other.svg'].map((f) => f.slice(6)).sort());
  });
  it('a cancelled job: same cleanup', async () => {
    await prepare();
    const end = await finished((await importer(undefined, 'cancelled').analyze(ref)).id);
    expect(end.state).toBe('cancelled');
    expect(await files()).toEqual(kept);
    expect(await onDisk()).toEqual(kept.map((f) => f.slice(6)));
  });
  it('the user discards the proposal: the same cleanup; accepting keeps every import', async () => {
    await prepare();
    const svc = importer();
    const end = await finished((await svc.analyze(ref)).id);
    expect(end.state, end.error).toBe('succeeded');
    const all = await files();
    expect(all).toEqual(expect.arrayContaining(['brand/ad.svg', 'brand/kit.svg', 'brand/loose.svg', 'brand/pre.svg']));
    expect(all).toHaveLength(5); // + the re-import of pre.svg under its new name
    const [p] = await brand.listProposals();
    expect(p!.importedFiles).toHaveLength(4);
    expect((await svc.applyProposal(ref, p!.id, [], false)).proposal.status).toBe('applied');
    expect(await files()).toEqual(all);

    // A second proposal, discarded by the user.
    const second = await finished((await svc.analyze(ref)).id);
    expect(second.state, second.error).toBe('succeeded');
    const open = (await brand.listProposals()).find((x) => x.status === 'open')!;
    const before = await files();
    expect((await svc.discardProposal(ref, open.id)).status).toBe('discarded');
    const after = await files();
    // Everything the second run added is gone (its names are new, so none is the one the kit or the creative uses).
    expect(after.filter((f) => !before.includes(f))).toEqual([]);
    expect(open.importedFiles).toHaveLength(4);
    for (const f of open.importedFiles ?? []) expect(after).not.toContain(f);
    expect(after).toEqual(expect.arrayContaining(kept));
    expect(await onDisk()).toHaveLength(after.length);
  });
});
