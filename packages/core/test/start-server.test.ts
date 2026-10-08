import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryVault } from '../src/secrets/vault.ts';
import { startServer } from '../src/server/main.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('startServer port auto', () => {
  it('uses 4318 when free and a random port when busy', async () => {
    const blocker = createServer();
    // If something else already holds 4318 the bind fails: the assertion below holds either way.
    blocker.on('error', () => {});
    await new Promise<void>((r) => { blocker.once('error', () => r()); blocker.listen(4318, '127.0.0.1', () => r()); });
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 'auto', configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      expect(s.port).not.toBe(4318);
      expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.close();
      blocker.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('takes 4318 when it is free', async () => {
    const probe = createServer();
    probe.on('error', () => {});
    const free = await new Promise<boolean>((r) => { probe.once('error', () => r(false)); probe.listen(4318, '127.0.0.1', () => probe.close(() => r(true))); });
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 'auto', configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      if (free) expect(s.port).toBe(4318);
      expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('passes mcpEnv to the MCP config of a launched agent run', { timeout: 30_000 }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const configDir = join(base, 'cfg');
    const argsFile = join(base, 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const s = await startServer({
      port: 0, configDir, vault: new MemoryVault(), claudeCommand: [process.execPath, FAKE],
      mcpServerPath: FAKE, mcpEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      const token = (await readFile(join(configDir, 'ui-token'), 'utf8')).trim();
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(s.url + path, { method, headers: { 'x-motion-studio-ui': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return res.json() as Promise<any>;
      };
      await call('PUT', '/api/workspace', { path: join(base, 'ws') });
      const project = await call('POST', '/api/projects', { name: 'Acme' });
      await call('POST', `/api/projects/${project.slug}/turns`, { prompt: 'ciao' });
      for (let i = 0; i < 100 && !existsSync(argsFile); i++) await new Promise((r) => setTimeout(r, 100));
      const { mcpConfigFile } = JSON.parse(await readFile(argsFile, 'utf8'));
      const env = JSON.parse(mcpConfigFile.content).mcpServers.studio.env;
      expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(env.MOTION_STUDIO_BRIDGE_TOKEN_FILE).toMatch(/\.token$/);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS_FILE;
      await s.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
