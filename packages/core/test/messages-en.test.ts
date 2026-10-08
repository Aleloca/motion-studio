import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_KIT_LIMITS, brandColorSchema, DEFAULT_FORMATS, EMPTY_BRAND_KIT, type ApprovalRequest, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { parseProposedKit } from '../src/brand/proposed-kit.ts';
import { exportVersion } from '../src/creatives/export.ts';
import { validateOutputs } from '../src/creatives/output-contract.ts';
import { runDoctor } from '../src/doctor.ts';
import type { CommandExec } from '../src/exec.ts';
import { FormatCatalog } from '../src/formats/format-catalog.ts';
import { Git } from '../src/git.ts';
import { setLocale } from '../src/i18n.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { requestJson } from '../src/providers/http.ts';
import { stockSearch } from '../src/providers/stock.ts';
import { buildServer } from '../src/server/app.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

// The setup file starts every test in Italian; these tests check what the core says in English.
beforeEach(() => setLocale('en'));
afterEach(() => setLocale('it'));

describe('English messages', () => {
  it('words a missing project in English, and in Italian after switching', async () => {
    const ws = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'ms-en-')), 'ws'), new Git());
    await expect(ws.getProject('nope')).rejects.toMatchObject({ status: 404, message: 'Project nope not found' });
    setLocale('it');
    await expect(ws.getProject('nope')).rejects.toMatchObject({ status: 404, message: 'Progetto nope non trovato' });
  });
  it('words Doctor checks and their fixes in English', async () => {
    const exec: CommandExec = async () => ({ code: -1, stdout: '', stderr: 'ENOENT', notFound: true });
    const checks = await runDoctor({ exec, claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.git).toMatchObject({ message: 'Git not found', fix: 'Install Git from https://git-scm.com' });
    expect(byId['claude-auth']).toMatchObject({ label: 'Claude sign-in', message: 'Install Claude Code first' });
  });
  it('titles an approval for a file outside the project in English, keeping the stable kind', async () => {
    const shown: ApprovalRequest[] = [];
    const broker = new ApprovalBroker({ broadcast: (m) => { if (m.type === 'approval') shown.push(m.approval); } });
    void broker.request({ jobId: 'j', projectSlug: 'acme', projectDir: '/w/acme', creativeSlug: null, kind: 'tool', toolName: 'Write', input: { file_path: '/tmp/out.txt' } });
    expect(shown[0]).toMatchObject({ kind: 'tool', toolName: 'Write', title: 'Edit a file outside the project', detail: '/tmp/out.txt' });
    await broker.decide(shown[0]!.id, 'once');
  });
  it('words validation problems in English', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'ms-en-')), 'v1');
    await mkdir(dir);
    expect((await validateOutputs({ dir, requested: ['sq'], presets: [], durationSec: null, media: NoMediaTools })).problems).toEqual(['manifest.json is missing in v1']);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [], tools: [] }));
    const r = await validateOutputs({ dir, requested: ['ghost'], presets: [], durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['Unknown preset: ghost (not in the format catalog)']);
    expect(r.unknownPresets).toEqual(['ghost']);
  });
  it('words export refusals in English', async () => {
    const version: VersionEntry = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: 'x', request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null };
    await expect(exportVersion({ creativeDir: '/nowhere', version, destination: 'relative/dir', slug: 'c' })).rejects.toMatchObject({ status: 400, message: 'Choose a destination folder (absolute path)' });
  });
  it('labels a started turn in English and tags it with a stable kind', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-en-'));
    const app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))], { killGraceMs: 200 }) });
    try {
      await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
      await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
      const res = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'hello' } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ kind: 'console', label: 'Turn · Acme' });
    } finally {
      await app.close();
    }
  });
  it('names a missing format with its English preset name', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'ms-en-')), 'v1');
    await mkdir(dir);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [], tools: [] }));
    const r = await validateOutputs({ dir, requested: ['instagram-image-1x1'], presets: DEFAULT_FORMATS, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['Missing format Instagram · Image 1:1 (instagram-image-1x1)']);
    setLocale('it');
    expect((await validateOutputs({ dir, requested: ['instagram-image-1x1'], presets: DEFAULT_FORMATS, durationSec: null, media: NoMediaTools })).problems)
      .toEqual(['Manca il formato Instagram · Immagine 1:1 (instagram-image-1x1)']);
  });
  it('words the 401 pairing answer in English, keeping the stable code', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-en-'));
    const app = await buildServer({ uiToken: 'a'.repeat(64), sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))], { killGraceMs: 200 }) });
    try {
      const res = await app.inject('/api/workspace');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'ui-token', error: 'Open Motion Studio from the link shown in the terminal' });
      const missing = await app.inject({ url: '/api/nope', headers: { 'x-motion-studio-ui': 'a'.repeat(64) } });
      expect(missing.json()).toEqual({ error: 'Not found' });
    } finally {
      await app.close();
    }
  });
  it('words provider errors in English', async () => {
    await expect(stockSearch({ fetch: globalThis.fetch, apiKey: 'k' }, { provider: 'unsplash', query: 'sea', kind: 'video', limit: 3 }))
      .rejects.toMatchObject({ status: 400, message: 'Unsplash does not offer video: use Pexels' });
    const denied = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(requestJson({ fetch: denied }, 'https://api.example/x', {}, { provider: 'OpenAI', secrets: ['sk-x'] }))
      .rejects.toMatchObject({ status: 401, message: 'The OpenAI key is invalid or lacks permission' });
    setLocale('it');
    await expect(requestJson({ fetch: denied }, 'https://api.example/x', {}, { provider: 'OpenAI', secrets: ['sk-x'] }))
      .rejects.toMatchObject({ message: 'Chiave OpenAI non valida o senza permessi' });
  });
  it('words brand issues and dropped lines in English, with the same data in Italian', async () => {
    const SRC = { kind: 'website' as const, ref: 'https://acme.example' };
    const color = (id: string, over = {}) => ({ id, name: id, hex: '#112233', role: 'primary', source: SRC, ...over });
    // a hex issue and a duplicate id, as dropped lines
    const proposal = { colors: [color('a'), color('a', { name: 'Other' }), color('b', { hex: 'blu' }), color('c', { name: undefined })] };
    expect(parseProposedKit(proposal, EMPTY_BRAND_KIT, SRC).dropped).toEqual([
      'color «Other»: duplicate id', 'color «b»: invalid hex (use #RRGGBB)', 'color «c»: name is required',
    ]);
    const tooMany = Array.from({ length: BRAND_KIT_LIMITS.colors + 1 }, (_, i) => color(`c-${i}`));
    expect(parseProposedKit({ colors: tooMany }, EMPTY_BRAND_KIT, SRC).dropped).toEqual([`color «c-${BRAND_KIT_LIMITS.colors}»: too many entries (maximum ${BRAND_KIT_LIMITS.colors})`]);
    expect(parseProposedKit({ colors: 'x' }, EMPTY_BRAND_KIT, SRC).dropped).toEqual(['color: invalid list']);
    setLocale('it');
    expect(parseProposedKit(proposal, EMPTY_BRAND_KIT, SRC).dropped).toEqual([
      'colore «Other»: id duplicato', 'colore «b»: hex non valido (usa #RRGGBB)', 'colore «c»: nome obbligatorio',
    ]);
    expect(brandColorSchema.safeParse(color('z', { hex: 'x' })).error!.issues[0]!.message).toBe('issue.hex');
  });
  it('words a duplicate-id refine in English', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ms-en-'));
    const dup = [DEFAULT_FORMATS[0]!, DEFAULT_FORMATS[0]!];
    await expect(new FormatCatalog(root).save(dup)).rejects.toMatchObject({ message: 'Invalid format catalog: presets: duplicate preset ids' });
    setLocale('it');
    await expect(new FormatCatalog(root).save(dup)).rejects.toMatchObject({ message: 'Catalogo formati non valido: presets: id dei preset duplicati' });
  });
});
