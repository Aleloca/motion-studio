import { mkdtemp, writeFile } from 'node:fs/promises';
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
  it('reads the transcription settings with their defaults and saves them without touching the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cfg-'));
    // An older config.json, written before the transcription settings existed.
    await writeFile(join(dir, 'config.json'), JSON.stringify({ schemaVersion: 1, workspacePath: '/tmp/ws', language: 'it' }));
    const store = new AppConfigStore(dir);
    expect(await store.readTranscription()).toEqual({ method: 'ask', model: 'small', custom: null });
    expect(await store.setTranscription({ method: 'never' })).toEqual({ method: 'never', model: 'small', custom: null });
    expect(await new AppConfigStore(dir).read()).toMatchObject({ workspacePath: '/tmp/ws', language: 'it', transcription: { method: 'never', model: 'small', custom: null } });
    await store.setTranscription({ model: 'large-v3-turbo' });
    expect(await store.readTranscription()).toEqual({ method: 'never', model: 'large-v3-turbo', custom: null });
  });
  it('refuses a relative custom program', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cfg-'));
    await expect(new AppConfigStore(dir).setTranscription({ custom: { program: 'whisper-cli', engine: 'whisper.cpp' } })).rejects.toThrow();
    expect(await new AppConfigStore(dir).readTranscription()).toEqual({ method: 'ask', model: 'small', custom: null });
  });
});
