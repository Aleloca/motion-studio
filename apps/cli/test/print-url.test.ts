import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateUiToken } from '@motion-studio/core';
import { NOT_RUNNING, runningUrl } from '../src/print-url.ts';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function configWith(server: object | null) {
  const dir = await mkdtemp(join(tmpdir(), 'ms-cli-url-'));
  dirs.push(dir);
  const token = await loadOrCreateUiToken(dir);
  if (server) {
    await mkdir(join(dir, 'run'), { mode: 0o700 });
    await writeFile(join(dir, 'run', 'server.json'), JSON.stringify(server), { mode: 0o600 });
  }
  return { dir, token };
}

describe('motion-studio --print-url', () => {
  it('prints the running server address with the UI token, without starting anything', async () => {
    const { dir, token } = await configWith({ port: 4318, pid: process.pid, startedAt: new Date().toISOString() });
    expect(await runningUrl(dir)).toBe(`http://127.0.0.1:4318/#t=${token}`);
  });
  it('says the app is not running when there is no server file or its process is gone', async () => {
    expect(await runningUrl((await configWith(null)).dir)).toBeNull();
    const { dir } = await configWith({ port: 4318, pid: 999_999, startedAt: new Date().toISOString() });
    expect(await runningUrl(dir, () => false)).toBeNull();
    expect(NOT_RUNNING).toBe('Motion Studio non è in esecuzione: avvialo con motion-studio');
  });
});
