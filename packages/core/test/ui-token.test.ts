import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { sweepRunDir } from '../src/agent/launcher.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { startServer } from '../src/server/main.ts';
import { loadOrCreateUiToken, readServerInfo, readUiToken } from '../src/server/ui-token.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async (name: string) => { const d = await mkdtemp(join(tmpdir(), name)); cleanup.push(d); return d; };

describe('UI token file', () => {
  it('is created once (64 hex chars, mode 0600) and then reused', async () => {
    const dir = await tmp('ms-uit-');
    const t = await loadOrCreateUiToken(join(dir, 'cfg'));
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(join(dir, 'cfg', 'ui-token'))).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateUiToken(join(dir, 'cfg'))).toBe(t);
    expect(await readUiToken(join(dir, 'cfg'))).toBe(t);
  });
  it('replaces a symlink, a folder or garbage without following or trusting it', async () => {
    const dir = await tmp('ms-uit-');
    const target = join(dir, 'elsewhere');
    await writeFile(target, 'f'.repeat(64));
    await symlink(target, join(dir, 'ui-token'));
    expect(await readUiToken(dir)).toBeNull();
    const t = await loadOrCreateUiToken(dir);
    expect(t).not.toBe('f'.repeat(64));
    expect((await lstat(join(dir, 'ui-token'))).isSymbolicLink()).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('f'.repeat(64));
    await rm(join(dir, 'ui-token'));
    await mkdir(join(dir, 'ui-token'));
    expect(await loadOrCreateUiToken(dir)).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(join(dir, 'ui-token'), 'not a token');
    const again = await loadOrCreateUiToken(dir);
    expect(again).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(dir, 'ui-token'), 'utf8')).toBe(again);
  });
});

describe('UI token on the API', () => {
  const TOKEN = 'ab'.repeat(32);
  let app: FastifyInstance;
  let base: string;
  beforeEach(async () => {
    base = await tmp('ms-uit-srv-');
    app = await buildServer({
      uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner(['true']), vault: new MemoryVault(),
    });
  });
  afterEach(async () => { await app.close(); });
  const H = (t = TOKEN) => ({ 'x-motion-studio-ui': t });

  it('refuses mutations and sensitive reads without the right token', async () => {
    const calls = [
      { method: 'POST' as const, url: '/api/projects', payload: { name: 'x' } },
      { method: 'PUT' as const, url: '/api/workspace', payload: { path: join(base, 'ws') } },
      { method: 'PUT' as const, url: '/api/settings', payload: {} },
      { method: 'PATCH' as const, url: '/api/projects/acme/assets/item/a.png', payload: {} },
      { method: 'DELETE' as const, url: '/api/secrets/openai' },
      { method: 'GET' as const, url: '/api/approvals' },
      { method: 'GET' as const, url: '/api/secrets' },
      { method: 'GET' as const, url: '/api/workspace' },
      { method: 'GET' as const, url: '/api/nope' },
    ];
    for (const c of calls) {
      for (const headers of [{}, H('cd'.repeat(32)), H('short')]) {
        const r = await app.inject({ ...c, headers });
        expect(r.statusCode, `${c.method} ${c.url}`).toBe(401);
        expect(r.json()).toEqual({ code: 'ui-token', error: 'Apri Motion Studio dal link mostrato nel terminale' });
      }
    }
    expect((await app.inject({ url: '/api/secrets', headers: H() })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/approvals', headers: H() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') }, headers: H() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' }, headers: H() })).statusCode).toBe(201);
  });
  it('needs no token for health, the bridge and the served files', async () => {
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/bridge/report_progress', payload: {} })).json()).toEqual({ error: 'Accesso al bridge non valido' });
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') }, headers: H() });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' }, headers: H() });
    const files = await app.inject('/api/projects/acme/files/assets/x.png');
    expect(files.statusCode).not.toBe(401);
    const creativeFiles = await app.inject('/api/projects/acme/creatives/c1/files/outputs/v1/a.png');
    expect(creativeFiles.statusCode).not.toBe(401);
    // The exceptions are only for their method.
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/acme/files/assets/x.png' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/bridge/report_progress' })).statusCode).toBe(401);
  });
  it('never returns the token', async () => {
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') }, headers: H() });
    for (const url of ['/api/health', '/api/workspace', '/api/secrets', '/api/approvals', '/api/doctor', '/api/jobs', '/api/projects', '/api/formats', '/api/nope']) {
      for (const headers of [{}, H()]) {
        const r = await app.inject({ url, headers });
        expect(r.body, url).not.toContain(TOKEN);
        expect(JSON.stringify(r.headers), url).not.toContain(TOKEN);
      }
    }
  });
  it('requires ?t= on the events WebSocket', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `${address.replace('http', 'ws')}/api/events`;
    for (const bad of [url, `${url}?t=${'cd'.repeat(32)}`]) {
      const status = await new Promise<number | string>((resolve) => {
        const ws = new WebSocket(bad);
        ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
        ws.on('open', () => { resolve('open'); ws.close(); });
        ws.on('error', () => resolve('error'));
      });
      expect(status).toBe(401);
    }
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${url}?t=${TOKEN}`);
      ws.on('message', (d) => { resolve(String(d)); ws.close(); });
      ws.on('error', reject);
    });
    expect(JSON.parse(first).type).toBe('snapshot');
  });
});

describe('startServer and the running-server file', () => {
  it('returns the UI address with the token, writes server.json and removes it on close', { timeout: 20_000 }, async () => {
    const configDir = await tmp('ms-uit-start-');
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'] });
    try {
      const token = await readUiToken(configDir);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const port = Number(new URL(s.url).port);
      expect(s.appUrl).toBe(`http://127.0.0.1:${port}/#t=${token}`);
      expect(await readServerInfo(configDir)).toMatchObject({ port, pid: process.pid });
      expect((await stat(join(configDir, 'run', 'server.json'))).mode & 0o777).toBe(0o600);
      // A boot sweep (another start) keeps it.
      await sweepRunDir(configDir);
      expect(await readServerInfo(configDir)).toMatchObject({ port });
      expect((await fetch(`${s.url}/api/workspace`)).status).toBe(401);
      expect((await fetch(`${s.url}/api/workspace`, { headers: { 'x-motion-studio-ui': token! } })).status).toBe(200);
    } finally {
      await s.close();
    }
    expect(await readServerInfo(configDir)).toBeNull();
  });
});
