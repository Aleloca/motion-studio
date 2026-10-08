import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';

let app: FastifyInstance;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-sec-'));
  app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'c')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']),
    vault: new MemoryVault({ UNSPLASH_ACCESS_KEY: 'env-key' }) });
});
afterEach(() => app.close());

describe('secrets API', () => {
  it('sets, reports and deletes keys without ever returning them', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: 'sk-secret-123' } });
    expect(put.json()).toEqual({ provider: 'openai', configured: true, source: 'keychain' });
    const list = await app.inject('/api/secrets');
    expect(list.body).not.toContain('sk-secret-123');
    expect(list.json()[0]).toEqual({ provider: 'openai', configured: true, source: 'keychain' });
    expect((await app.inject({ method: 'DELETE', url: '/api/secrets/openai' })).json()).toEqual({ provider: 'openai', configured: false, source: null });
  });
  it('rejects unknown providers, invalid values and env-managed keys', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/nope', payload: { value: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/unsplash', payload: { value: 'x' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/secrets/unsplash' })).statusCode).toBe(409);
  });
});
