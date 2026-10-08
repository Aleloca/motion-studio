import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateUiToken } from '@motion-studio/core';
import { alreadyRunningMessage, answersHealth, notRunningMessage, runningUrl } from '../src/print-url.ts';

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
    const server = createServer((req, res) => {
      if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, pid: process.pid })); } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const { dir, token } = await configWith({ port, pid: process.pid, startedAt: new Date().toISOString() });
      expect(await runningUrl(dir)).toBe(`http://127.0.0.1:${port}/#t=${token}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
  it('says the app is not running when the pid is alive but nothing answers on the port', async () => {
    const server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => server.close(r)); // the port is now dead
    const { dir } = await configWith({ port, pid: process.pid, startedAt: new Date().toISOString() });
    expect(await runningUrl(dir)).toBeNull();
    expect(await answersHealth(port)).toBe(false);
  });
  it('gives up on a server that never answers within the timeout', async () => {
    const hanging = createServer(() => { /* never responds */ });
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r));
    const port = (hanging.address() as AddressInfo).port;
    try {
      const t0 = Date.now();
      expect(await answersHealth(port, 300)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      hanging.closeAllConnections();
      await new Promise((r) => hanging.close(r));
    }
  });
  it('says the app is not running when there is no server file or its process is gone', async () => {
    expect(await runningUrl((await configWith(null)).dir)).toBeNull();
    const { dir } = await configWith({ port: 4318, pid: 999_999, startedAt: new Date().toISOString() });
    expect(await runningUrl(dir, () => false, async () => true)).toBeNull();
    expect(notRunningMessage()).toBe('Motion Studio non è in esecuzione: avvialo con motion-studio');
  });
  it('says the app is not running when the port answers for another pid (pid reused)', async () => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, pid: process.pid + 1 })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const { dir } = await configWith({ port, pid: process.pid, startedAt: new Date().toISOString() });
      expect(await runningUrl(dir)).toBeNull();
      expect(await answersHealth(port, 1500, process.pid)).toBe(false);
      expect(await answersHealth(port, 1500)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
  it('tells where the already running instance is, with the same address --print-url prints', () => {
    expect(alreadyRunningMessage('http://127.0.0.1:4318/#t=abc')).toBe('Motion Studio è già avviato: http://127.0.0.1:4318/#t=abc');
  });
});
