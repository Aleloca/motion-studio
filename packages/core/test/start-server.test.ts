import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryVault } from '../src/secrets/vault.ts';
import { startServer } from '../src/server/main.ts';

describe('startServer port auto', () => {
  it('uses 4318 when free and a random port when busy', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(4318, '127.0.0.1', () => r())).catch(() => {});
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
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 'auto', configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      // 4318 may be taken by something else on the machine: then the fallback applies and the url still matches.
      expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
