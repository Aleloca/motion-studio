import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-srv-'));
  app = await buildServer({
    appConfig: new AppConfigStore(join(base, 'config')),
    git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    doctor: async () => [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }],
  });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });

const setWorkspace = (path = join(base, 'Spazio di lavoro')) =>
  app.inject({ method: 'PUT', url: '/api/workspace', payload: { path } });

describe('workspace', () => {
  it('starts unconfigured and returns 409 for projects', async () => {
    expect((await app.inject('/api/workspace')).json()).toEqual({ path: null, settings: null });
    const res = await app.inject('/api/projects');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('workspace');
  });
  it('configures a workspace (creating it) and returns settings', async () => {
    const res = await setWorkspace();
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ maxConcurrentJobs: 2 });
  });
  it('rejects relative paths and files', async () => {
    expect((await setWorkspace('relative/path')).statusCode).toBe(400);
    const file = join(base, 'f.txt');
    await writeFile(file, 'x');
    expect((await setWorkspace(file)).statusCode).toBe(400);
  });
  it('validates settings updates', async () => {
    await setWorkspace();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 4 } })).json()).toMatchObject({ maxConcurrentJobs: 4 });
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 0 } })).statusCode).toBe(400);
  });
});

describe('projects', () => {
  it('creates, lists and reads projects', async () => {
    await setWorkspace();
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Lumen Caffè' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().slug).toBe('lumen-caffe');
    expect((await app.inject('/api/projects')).json()).toHaveLength(1);
    expect((await app.inject('/api/projects/lumen-caffe')).json().project.name).toBe('Lumen Caffè');
    expect((await app.inject('/api/projects/nope')).statusCode).toBe(404);
  });
  it('returns 400 for an empty name', async () => {
    await setWorkspace();
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '' } })).statusCode).toBe(400);
  });
});

describe('doctor', () => {
  it('returns the checks', async () => {
    expect((await app.inject('/api/doctor')).json()[0]).toMatchObject({ id: 'git', ok: true });
  });
});

describe('turns over WebSocket', () => {
  async function connect(): Promise<{ messages: ServerMessage[]; ws: WebSocket }> {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    return { messages, ws };
  }
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('runs a turn and streams job + agent events', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const res = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'ciao' } });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === jobId && m.job.state === 'succeeded'));
    expect(messages[0]).toMatchObject({ type: 'snapshot' });
    const agentKinds = messages.filter((m) => m.type === 'agent' && m.jobId === jobId).map((m) => (m as any).event.kind);
    expect(agentKinds).toEqual(['session', 'text', 'result']);
    ws.close();
  });
  it('rejects a second concurrent turn on the same project, and cancels a hanging one', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const first = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } });
    const second = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'b' } });
    expect(second.statusCode).toBe(409);
    const id = first.json().id;
    await waitFor(() => messages.some((m) => m.type === 'agent' && m.jobId === id));
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel` })).json()).toEqual({ cancelled: true });
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'cancelled'));
    ws.close();
  });
  it('cancels running jobs when the server closes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages } = await connect();
    const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } })).json().id;
    await waitFor(() => messages.some((m) => m.type === 'agent' && m.jobId === id));
    const start = Date.now();
    await app.close();
    expect(Date.now() - start).toBeLessThan(3000);
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'cancelled'));
  });
  it('marks the job failed with a readable error when claude crashes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } })).json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'failed'));
    const failed = messages.find((m) => m.type === 'job' && m.job.id === id && m.job.state === 'failed');
    expect(failed && failed.type === 'job' && failed.job.error).toContain('boom');
    ws.close();
  });
  it('rejects an empty prompt with 400', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: '  ' } })).statusCode).toBe(400);
  });
});
