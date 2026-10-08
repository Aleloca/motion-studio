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
});
