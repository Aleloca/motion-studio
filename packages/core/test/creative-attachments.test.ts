/**
 * Report 79: files of the project library attached to a creative message (the composer's "+"). The route takes their
 * project paths, refuses anything outside the library, writes them on the user's entry and the agent's prompt lists them.
 */
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { keptAttachments } from '../src/creatives/attachments.ts';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
let app: FastifyInstance;
let base: string;
let promptFile: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-attach-'));
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  app = await buildServer({ agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [], openPath: async () => {} });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_PROMPT_FILE; });

const waitJobs = async () => {
  for (let i = 0; i < 750; i++) {
    const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string }>;
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};
const prompts = async () => (await readFile(promptFile, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as { prompt: string }).prompt);
const projectDir = () => join(base, 'ws', 'acme');

async function generated(): Promise<string> {
  const { slug } = (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief, generate: true } })).json() as { slug: string };
  await waitJobs();
  return slug;
}

describe('attachments on a creative message (report 79)', () => {
  it('the agent gets each attached library file, with its kind, and the message keeps them', async () => {
    const slug = await generated();
    await mkdir(join(projectDir(), 'assets'), { recursive: true });
    await writeFile(join(projectDir(), 'assets', 'logo.png'), 'png');
    await writeFile(join(projectDir(), 'assets', 'notes.txt'), 'hello');
    const res = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, payload: { text: 'Usa il logo', attachments: ['assets/logo.png', 'assets/notes.txt'] } });
    expect(res.statusCode).toBe(202);
    await waitJobs();
    const prompt = (await prompts()).at(-1)!;
    expect(prompt).toContain('## Attached files');
    expect(prompt).toContain('- "assets/logo.png" (image)');
    expect(prompt).toContain('- "assets/notes.txt" (other)');
    const conv = (await app.inject(`/api/projects/acme/creatives/${slug}/conversation`)).json() as Array<{ type: string; text?: string; attachments?: string[] }>;
    expect(conv.filter((e) => e.type === 'user').at(-1)).toMatchObject({ text: 'Usa il logo', attachments: ['assets/logo.png', 'assets/notes.txt'] });
  });

  it('a message with only attachments is a request', async () => {
    const slug = await generated();
    await mkdir(join(projectDir(), 'assets'), { recursive: true });
    await writeFile(join(projectDir(), 'assets', 'photo.jpg'), 'jpg');
    const res = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, payload: { attachments: ['assets/photo.jpg'] } });
    expect(res.statusCode).toBe(202);
    await waitJobs();
    const prompt = (await prompts()).at(-1)!;
    expect(prompt).toContain('New request for the creative');
    expect(prompt).toContain('- "assets/photo.jpg"');
    const versions = (await app.inject(`/api/projects/acme/creatives/${slug}`)).json().versions as unknown[];
    expect(versions).toHaveLength(2);
  });

  it('refuses a path outside the project library with attachment-invalid, and starts nothing', async () => {
    const slug = await generated();
    const before = (await prompts()).length;
    const assets = join(projectDir(), 'assets');
    await mkdir(join(base, 'outside'), { recursive: true });
    await writeFile(join(base, 'secret.txt'), 'nope');
    await writeFile(join(base, 'outside', 'x.png'), 'nope');
    await writeFile(join(assets, '.hidden.png'), 'h');
    await writeFile(join(assets, 'real.png'), 'r');
    await writeFile(join(assets, 'ok.png'), 'o');
    await symlink(join(base, 'secret.txt'), join(assets, 'link.txt'));
    await symlink(join(base, 'outside'), join(assets, 'sub'));
    await symlink(join(projectDir(), 'creatives'), join(assets, 'inside'));
    await link(join(assets, 'real.png'), join(assets, 'hard.png'));
    const url = `/api/projects/acme/creatives/${slug}/turns`;
    for (const path of ['../secret.txt', 'assets/../../secret.txt', 'brief.md', `creatives/${slug}/creative.json`, 'assets/missing.png', 'assets/link.txt', '/etc/hosts',
      'assets/./x', 'assets/.hidden.png', 'assets/assets.json', 'assets/sub/x.png', `assets/inside/${slug}/creative.json`, 'assets/hard.png', 'assets/%2e%2e/secret.txt']) {
      const r = await app.inject({ method: 'POST', url, payload: { text: 'x', attachments: [path] } });
      expect(r.statusCode, path).toBe(400);
      expect(r.json().code, path).toBe('attachment-invalid');
      // The refused paths come back, so the composer can drop exactly those chips.
      expect(r.json().problems, path).toEqual([path]);
    }
    // A control character never passes the request's schema.
    expect((await app.inject({ method: 'POST', url, payload: { text: 'x', attachments: ['assets\nx'] } })).statusCode).toBe(400);
    // Every refused path is named, not only the first.
    const two = await app.inject({ method: 'POST', url, payload: { text: 'x', attachments: ['assets/missing.png', 'assets/ok.png', 'assets/gone.png'] } });
    expect(two.json()).toMatchObject({ code: 'attachment-invalid', problems: ['assets/missing.png', 'assets/gone.png'] });
    // At most 20 files.
    const many = Array.from({ length: 21 }, (_, i) => `assets/f${i}.png`);
    expect((await app.inject({ method: 'POST', url, payload: { text: 'x', attachments: many } })).statusCode).toBe(400);
    await waitJobs();
    expect((await prompts()).length).toBe(before);
  });

  it('a requeued request keeps only the files still in the library (round 1)', async () => {
    await mkdir(join(projectDir(), 'assets'), { recursive: true });
    await writeFile(join(projectDir(), 'assets', 'logo.png'), 'png');
    expect(await keptAttachments(projectDir(), ['assets/logo.png', 'assets/gone.png', '../x', 'assets/logo.png'])).toEqual(['assets/logo.png']);
  });
});
