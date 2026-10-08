import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

let app: FastifyInstance;
let broker: ApprovalBroker;
let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-ar-'));
  broker = new ApprovalBroker({ broadcast: () => {} });
  app = await buildServer({ sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'c')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']), approvals: broker });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(() => app.close());

describe('approvals API', () => {
  it('lists, decides and manages project permissions', async () => {
    const pending = broker.request({ jobId: 'j', projectSlug: 'acme', projectDir: join(base, 'ws', 'acme'), creativeSlug: null, kind: 'tool', toolName: 'Bash', input: { command: 'brew install x' } });
    const [req] = (await app.inject('/api/approvals')).json();
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, payload: { decision: 'maybe' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, payload: { decision: 'always' } })).statusCode).toBe(200);
    expect(await pending).toEqual({ decision: 'always' });
    expect((await app.inject('/api/projects/acme/permissions')).json()).toEqual([expect.objectContaining({ rule: 'Bash(brew install:*)' })]);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/acme/permissions', payload: { rule: 'Bash(brew install:*)' } })).json()).toEqual({ ok: true });
  });
  it('reports 404 / 400 for unknown ids, unknown projects and missing rules', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/approvals/nope', payload: { decision: 'once' } })).statusCode).toBe(404);
    expect((await app.inject('/api/projects/ghost/permissions')).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/acme/permissions', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/acme/permissions', payload: { rule: 'Bash(x:*)' } })).statusCode).toBe(404);
  });
  it('resolves pending approvals as cancelled on close and sends them in the WS snapshot', async () => {
    const pending = broker.request({ jobId: 'j', projectSlug: 'acme', projectDir: join(base, 'ws', 'acme'), creativeSlug: null, kind: 'tool', toolName: 'Bash', input: { command: 'ls' } });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`);
    const first = await new Promise<{ type: string; approvals?: unknown[] }>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
    expect(first.type).toBe('snapshot');
    expect(first.approvals).toHaveLength(1);
    ws.close();
    await app.close();
    expect(await pending).toEqual({ decision: 'cancelled' });
    app = await buildServer({ sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'c2')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']) });
  });
});
