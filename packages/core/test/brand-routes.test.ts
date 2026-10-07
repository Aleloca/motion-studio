import { mkdtemp, writeFile } from 'node:fs/promises';
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
  app = await buildServer({ appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
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
  it('reports a corrupt kit and refuses to overwrite it', async () => {
    await writeFile(join(base, 'ws', 'acme', 'brand', 'brand-kit.json'), '{oops');
    const o = (await app.inject(`${P}/brand`)).json();
    expect(o.kitError).toContain('brand-kit.json');
    expect(o.kit.colors).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `${P}/brand/kit`, payload: { kit: { schemaVersion: 1 } } })).statusCode).toBe(422);
  });
  it('validates sources', async () => {
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'website', url: 'ftp://x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'image', file: 'references/none.jpg' } })).statusCode).toBe(400);
  });
});
