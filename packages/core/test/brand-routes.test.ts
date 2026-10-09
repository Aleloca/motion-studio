import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { multipart } from './helpers/multipart.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;
const P = '/api/projects/acme';
const manual = { kind: 'manual', ref: null };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-br-'));
  process.env.FAKE_CLAUDE_SCENARIO = 'brand';
  app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });
const waitJobs = async () => {
  for (let i = 0; i < 250; i++) {
    const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string; error?: string }>;
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};

describe('brand API', () => {
  it('edits kit and guidelines, analyzes a site and applies the proposal', { timeout: 20_000 }, async () => {
    const kit = await app.inject({ method: 'PUT', url: `${P}/brand/kit`, payload: { kit: { schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: manual }] } } });
    expect(kit.json().colors[0].hex).toBe('#1E3A5F');
    expect((await app.inject({ method: 'PUT', url: `${P}/brand/guidelines`, payload: { text: 'Tono diretto' } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'website', url: 'https://acme.example' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${P}/brand/analyze`, payload: {} })).statusCode).toBe(202);
    await waitJobs();
    const overview = (await app.inject(`${P}/brand`)).json();
    expect(overview.proposals[0]).toMatchObject({ status: 'open' });
    const p = overview.proposals[0];
    const applied = await app.inject({ method: 'POST', url: `${P}/brand/proposals/${p.id}/apply`, payload: { acceptedIds: ['colors:add:arancio'], applyGuidelines: false } });
    expect(applied.json().kit.colors.map((c: { id: string }) => c.id)).toEqual(['blu', 'arancio']);
    expect((await app.inject(`${P}/brand`)).json().guidelines).toBe('Tono diretto');
  });
  it('turns references marked for brand into image sources before analyzing', { timeout: 20_000 }, async () => {
    await app.inject({ method: 'POST', url: `${P}/references`, ...multipart([{ name: 'mood.jpg', content: 'x' }]) });
    expect((await app.inject({ method: 'POST', url: `${P}/brand/analyze`, payload: {} })).statusCode).toBe(202);
    await waitJobs();
    expect((await app.inject(`${P}/brand`)).json().sources).toEqual([expect.objectContaining({ kind: 'image', file: 'references/mood.jpg' })]);
  });
  it('syncs image sources with the references before analyzing', { timeout: 20_000 }, async () => {
    await app.inject({ method: 'POST', url: `${P}/references`, ...multipart([{ name: 'a.jpg', content: 'x' }, { name: 'b.jpg', content: 'y' }, { name: 'c.jpg', content: 'z' }]) });
    for (const f of ['a.jpg', 'b.jpg']) await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'image', file: `references/${f}` } });
    await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'website', url: 'https://acme.example' } });
    // Changed behind the routes' back: a.jpg excluded in references.json, b.jpg deleted from disk.
    const refsFile = join(base, 'ws', 'acme', 'references', 'references.json');
    const refs = JSON.parse(await readFile(refsFile, 'utf8'));
    refs.references = refs.references.map((r: { file: string }) => (r.file === 'a.jpg' ? { ...r, useForBrand: false } : r));
    await writeFile(refsFile, JSON.stringify(refs));
    await rm(join(base, 'ws', 'acme', 'references', 'b.jpg'));
    expect((await app.inject({ method: 'POST', url: `${P}/brand/analyze`, payload: {} })).statusCode).toBe(202);
    await waitJobs();
    const files = ((await app.inject(`${P}/brand`)).json().sources as Array<{ kind: string; file: string | null; url: string | null }>).map((s) => s.file ?? s.url);
    expect(files).toEqual(['https://acme.example', 'references/c.jpg']);
  });
  it('reports a corrupt kit and refuses to overwrite it', async () => {
    await writeFile(join(base, 'ws', 'acme', 'brand', 'brand-kit.json'), '{oops');
    const o = (await app.inject(`${P}/brand`)).json();
    expect(o.kitError).toContain('brand-kit.json');
    expect(o.kit.colors).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `${P}/brand/kit`, payload: { kit: { schemaVersion: 1 } } })).statusCode).toBe(422);
  });
  it('refuses image sources that escape references/', async () => {
    await symlink(join(base, 'ws', 'acme', 'project.json'), join(base, 'ws', 'acme', 'references', 'leak.jpg'));
    for (const file of ['references/../project.json', 'references/leak.jpg']) {
      expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'image', file } })).statusCode, file).toBe(400);
    }
  });
  it('surfaces a corrupt references.json on analyze', async () => {
    await writeFile(join(base, 'ws', 'acme', 'references', 'references.json'), '{bad');
    expect((await app.inject({ method: 'POST', url: `${P}/brand/analyze`, payload: {} })).statusCode).toBe(422);
  });
  it('validates sources', async () => {
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'website', url: 'ftp://x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'image', file: 'references/none.jpg' } })).statusCode).toBe(400);
  });
});

describe('GET /brand/proposals/:id/activity (commands that ran automatically)', () => {
  const id = 'p-20261009-120000';
  const dir = () => join(base, 'ws', 'acme', 'brand', 'proposals', id);
  const explanation = { summary: [{ key: 'explain.listFiles', params: {} }], indicators: [], risk: 'low', parsed: true };
  const auto = (command: string) => JSON.stringify({ at: '2026-10-09T12:00:01.000Z', event: { kind: 'auto_approved', toolName: 'Bash', command, explanation } });
  const tool = (name: string, input: unknown) => JSON.stringify({ at: '2026-10-09T12:00:02.000Z', event: { kind: 'tool_use', id: 't', name, input } });
  const get = (pid = id) => app.inject(`${P}/brand/proposals/${pid}/activity`);

  it('returns only auto_approved and Bash tool_use entries, skipping corrupt lines', async () => {
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), 'log.jsonl'), [
      auto('ls -la'), tool('Bash', { command: 'ls -la' }), tool('Read', { file_path: '/x' }), tool('WebFetch', { url: 'https://e.x' }),
      JSON.stringify({ at: 'x', event: { kind: 'text', text: 'hi' } }), '{"broken', '\u0000garbage', 'null', '[]',
      JSON.stringify({ at: 'x', event: { kind: 'auto_approved', toolName: 'Bash' } }), // malformed: no command
      auto('echo ok'),
    ].join('\n') + '\n');
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hasLog: boolean; truncated: boolean; entries: Array<{ at: string; event: { kind: string } }> };
    expect(body.hasLog).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.entries.map((e) => e.event.kind)).toEqual(['auto_approved', 'tool_use', 'auto_approved']);
    expect(body.entries[0]).toEqual({ at: '2026-10-09T12:00:01.000Z', event: { kind: 'auto_approved', toolName: 'Bash', command: 'ls -la', explanation } });
  });

  it('an old proposal without a log: hasLog false, no entries', async () => {
    await mkdir(dir(), { recursive: true });
    expect((await get()).json()).toEqual({ hasLog: false, truncated: false, entries: [] });
  });

  it('caps the entries at 500 and the read at 1 MB', async () => {
    await mkdir(dir(), { recursive: true });
    await writeFile(join(dir(), 'log.jsonl'), Array.from({ length: 700 }, (_, i) => auto(`echo ${i}`)).join('\n') + '\n');
    const many = (await get()).json() as { truncated: boolean; entries: unknown[] };
    expect(many.entries).toHaveLength(500);
    expect(many.truncated).toBe(true);
    await writeFile(join(dir(), 'log.jsonl'), 'x'.repeat(1_200_000) + '\n' + auto('late') + '\n');
    const big = (await get()).json() as { truncated: boolean; entries: unknown[] };
    expect(big).toMatchObject({ truncated: true, entries: [] });
  });

  it('is confined to the proposal folder: bad ids, symlinked logs or folders and hard links are refused', async () => {
    for (const bad of ['..', '..%2F..%2Fetc', 'P-1', '%2Ftmp', 'a'.repeat(100)]) {
      expect((await get(bad)).statusCode, bad).toBeGreaterThanOrEqual(400);
    }
    const outside = await mkdtemp(join(tmpdir(), 'ms-outside-'));
    await writeFile(join(outside, 'log.jsonl'), auto('secret') + '\n');
    await mkdir(dir(), { recursive: true });
    await symlink(join(outside, 'log.jsonl'), join(dir(), 'log.jsonl'));
    expect((await get()).json()).toMatchObject({ entries: [] });
    await rm(join(dir(), 'log.jsonl'));
    await link(join(outside, 'log.jsonl'), join(dir(), 'log.jsonl'));
    expect((await get()).json()).toMatchObject({ entries: [] });
    const other = 'p-20261009-130000';
    await symlink(outside, join(base, 'ws', 'acme', 'brand', 'proposals', other));
    expect((await get(other)).json()).toMatchObject({ entries: [] });
    await rm(outside, { recursive: true, force: true });
  });

  it('requires the UI token', async () => {
    const secured = await buildServer({ uiToken: 'ab'.repeat(32), sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config2')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
    const res = await secured.inject(`${P}/brand/proposals/${id}/activity`);
    expect(res.statusCode).toBe(401);
    await secured.close();
  });
});
