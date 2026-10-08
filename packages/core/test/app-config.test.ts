import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfigStore } from '../src/app-config.ts';

describe('AppConfigStore', () => {
  it('returns defaults when no config exists, then persists the workspace path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cfg-'));
    const store = new AppConfigStore(join(dir, 'nested'));
    expect(await store.read()).toEqual({ schemaVersion: 1, workspacePath: null, language: 'system' });
    await store.setWorkspacePath('/tmp/ws');
    expect(await new AppConfigStore(join(dir, 'nested')).read()).toEqual({ schemaVersion: 1, workspacePath: '/tmp/ws', language: 'system' });
  });
  it('keeps both values when the language and the workspace are saved at the same time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cfg-'));
    for (let i = 0; i < 10; i++) {
      // Two stores on the same folder, as the server and a launcher would have.
      await Promise.all([new AppConfigStore(dir).setLanguage(i % 2 ? 'en' : 'it'), new AppConfigStore(dir).setWorkspacePath(`/tmp/ws-${i}`)]);
      expect(await new AppConfigStore(dir).read()).toEqual({ schemaVersion: 1, workspacePath: `/tmp/ws-${i}`, language: i % 2 ? 'en' : 'it' });
    }
  });
});
