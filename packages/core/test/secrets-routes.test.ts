import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { KeyCheckCache } from '../src/providers/key-check.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';

let app: FastifyInstance;
let keyChecks: KeyCheckCache;
// Fake fetch only: the key checks that PUT and POST run never leave the process.
let probes: Array<{ url: string; auth: string | null }>;
let answer: (url: string) => Response;
const fakeFetch = (async (url: string, init: RequestInit = {}) => {
  const h = new Headers(init.headers);
  probes.push({ url, auth: h.get('authorization') ?? h.get('xi-api-key') });
  return answer(url);
}) as unknown as typeof fetch;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-sec-'));
  probes = [];
  answer = () => new Response('{}', { status: 200 });
  keyChecks = new KeyCheckCache();
  app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'c')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']),
    vault: new MemoryVault({ UNSPLASH_ACCESS_KEY: 'env-key-0123456789' }), keyChecks, keyCheckHttp: { fetch: fakeFetch } });
});
afterEach(() => app.close());

describe('secrets API', () => {
  it('sets, reports and deletes keys without ever returning them', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: 'sk-secret-123' } });
    expect(put.json()).toMatchObject({ provider: 'openai', configured: true, source: 'keychain' });
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

  it('PUT tests the saved key and returns the check (core memory only)', async () => {
    const KEY = 'xi-saved-secret-0123456789';
    answer = (u) => (u.includes('/v1/user') ? new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'missing the permission user_read' } }), { status: 401 }) : new Response('{}', { status: 200 }));
    const put = await app.inject({ method: 'PUT', url: '/api/secrets/elevenlabs', payload: { value: KEY } });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body).toMatchObject({ provider: 'elevenlabs', configured: true, source: 'keychain', check: { provider: 'elevenlabs' } });
    const st = Object.fromEntries(body.check.capabilities.map((c: { capability: string; status: string }) => [c.capability, c.status]));
    expect(st).toEqual({ key: 'ok', account: 'missing', voices: 'ok', tts: 'unverified', sfx: 'unverified', music: 'unverified' });
    expect(probes.every((p) => p.auth === KEY)).toBe(true);
    expect(put.body).not.toContain(KEY);
    // Remembered in memory and readable without probing again.
    const n = probes.length;
    const all = await app.inject('/api/secrets/checks');
    expect(all.json().elevenlabs).toEqual(body.check);
    expect(all.json().openai).toBeNull();
    expect(probes).toHaveLength(n);
    // Removing the key forgets what was known about it.
    await app.inject({ method: 'DELETE', url: '/api/secrets/elevenlabs' });
    expect((await app.inject('/api/secrets/checks')).json().elevenlabs).toBeNull();
  });
  it('PUT with check: false only saves; a replaced key forgets the old results', async () => {
    keyChecks.record('openai', 'images', 'missing', 'model.request');
    const put = await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: 'sk-other-0123456789', check: false } });
    expect(put.json()).toEqual({ provider: 'openai', configured: true, source: 'keychain', check: null });
    expect(probes).toEqual([]);
    expect(keyChecks.get('openai')).toBeNull();
  });
  it('POST /check tests a key, also one from the environment; without a key it is 409', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/secrets/unsplash/check' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ provider: 'unsplash', capabilities: [{ capability: 'key', status: 'ok' }, { capability: 'search', status: 'ok' }] });
    expect(probes).toEqual([{ url: 'https://api.unsplash.com/search/photos?query=test&per_page=1', auth: 'Client-ID env-key-0123456789' }]);
    expect(r.body).not.toContain('env-key-0123456789');
    expect((await app.inject({ method: 'POST', url: '/api/secrets/pexels/check' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/secrets/nope/check' })).statusCode).toBe(400);
  });
  it('a check keeps what a real call learned, a network error is error, and no key reaches the logs', async () => {
    const KEY = 'sk-log-secret-0123456789';
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { logged.push(String(c)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { logged.push(String(c)); return true; });
    try {
      await app.inject({ method: 'PUT', url: '/api/secrets/elevenlabs', payload: { value: KEY } });
      keyChecks.record('elevenlabs', 'music', 'missing', 'music_generation');
      answer = () => { throw new TypeError(`connect ECONNREFUSED ${KEY}`); };
      const r = await app.inject({ method: 'POST', url: '/api/secrets/elevenlabs/check' });
      const st = Object.fromEntries(r.json().capabilities.map((c: { capability: string; status: string }) => [c.capability, c.status]));
      expect(st).toEqual({ key: 'error', account: 'error', voices: 'error', tts: 'unverified', sfx: 'unverified', music: 'missing' });
      expect(r.body).not.toContain(KEY);
      expect(JSON.stringify(keyChecks.get('elevenlabs'))).not.toContain(KEY);
    } finally { out.mockRestore(); err.mockRestore(); }
    expect(logged.join('\n')).not.toContain(KEY);
  });
});
