import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../src/secrets/vault.ts';
import { sweepRunDir } from '../src/agent/launcher.ts';
import { AlreadyRunningError, startServer, uiOriginsOf } from '../src/server/main.ts';
import { loadOrCreateUiToken, readServerInfo } from '../src/server/ui-token.ts';

// Final wave Q5: every boot here takes seconds on a loaded machine (the doctor, the ledger, the sweeps). Per-file timeouts only.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('the UI origins allowed to embed live previews (C2)', () => {
  it('uiOriginsOf: the listening origin plus the other loopback names of the port; nothing extra on a non-loopback host', () => {
    expect(uiOriginsOf('http://127.0.0.1:4317', '127.0.0.1')).toEqual(['http://127.0.0.1:4317', 'http://localhost:4317', 'http://[::1]:4317']);
    expect(uiOriginsOf('http://10.0.0.5:4317', '10.0.0.5')).toEqual(['http://10.0.0.5:4317']);
  });
  it('a running core lists localhost:<port> too', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 'auto', configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      const token = await loadOrCreateUiToken(configDir);
      const r = await fetch(`${s.url}/api/preview/origin`, { headers: { 'x-motion-studio-ui': token } });
      expect(((await r.json()) as { uiOrigins: string[] }).uiOrigins).toContain(`http://localhost:${s.port}`);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('startServer with the desktop updater state (decision 802)', () => {
  it('serves /api/updates and the Doctor row from the state the desktop passes, read per request', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    let state: 'active' | 'off' | 'unknown' = 'unknown';
    const s = await startServer({ port: 'auto', configDir, claudeCommand: ['true'], vault: new MemoryVault(), updatesState: () => state });
    try {
      const token = await loadOrCreateUiToken(configDir);
      const get = async (path: string) => (await fetch(`${s.url}${path}`, { headers: { 'x-motion-studio-ui': token } })).json() as Promise<any>;
      const rowOf = async () => ((await get('/api/doctor')) as Array<{ id: string; ok: boolean; required: boolean; message: string }>).find((c) => c.id === 'updates');
      expect((await fetch(`${s.url}/api/updates`)).status).toBe(401);
      expect((await get('/api/updates')).state).toBe('unknown');
      expect(await rowOf()).toBeUndefined();
      state = 'off';
      expect((await get('/api/updates')).state).toBe('off');
      expect(await rowOf()).toMatchObject({ required: false, ok: true });
      state = 'active';
      expect((await get('/api/updates')).state).toBe('active');
      expect(await rowOf()).toBeUndefined();
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

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
      // The fake writes the args file on every start, `claude --version` included. Since decision 804 the launcher asks
      // for the version before a console run (live input defaults on), so wait for the agent run's own record: the one
      // with an MCP config.
      const agentRun = async () => (existsSync(argsFile) ? JSON.parse(await readFile(argsFile, 'utf8')) : null);
      let record = await agentRun().catch(() => null);
      for (let i = 0; i < 100 && !record?.mcpConfigFile; i++) {
        await new Promise((r) => setTimeout(r, 100));
        record = await agentRun().catch(() => null);
      }
      const { mcpConfigFile } = record;
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

describe('startServer doctor', () => {
  it('adds the shell-path check only when the caller says where PATH came from', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault(), shellPath: { source: 'fallback', error: 'codice 1' }, systemLocales: ['it-IT'] });
    try {
      const token = (await readFile(join(configDir, 'ui-token'), 'utf8')).trim();
      const checks = await (await fetch(`${s.url}/api/doctor`, { headers: { 'x-motion-studio-ui': token } })).json() as { id: string; ok: boolean; message: string }[];
      expect(checks.find((c) => c.id === 'shell-path')).toMatchObject({ ok: false, message: 'PATH di riserva: codice 1' });
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('startServer single instance per config dir', () => {
  const listen = async (srv: Server | ReturnType<typeof createHttpServer>) => {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return (srv.address() as AddressInfo).port;
  };
  /** A config dir whose run/ holds another instance's server.json and a leftover agent config. */
  const configWith = async (info: { port: number; pid: number }) => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const token = await loadOrCreateUiToken(configDir);
    await mkdir(join(configDir, 'run'), { mode: 0o700 });
    await writeFile(join(configDir, 'run', 'server.json'), JSON.stringify({ ...info, startedAt: new Date().toISOString() }), { mode: 0o600 });
    await writeFile(join(configDir, 'run', 'old.mcp.json'), '{}', { mode: 0o600 });
    return { configDir, token };
  };
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
  const healthServer = (pid: number) => createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/health' ? JSON.stringify({ ok: true, pid }) : '{}');
  });

  it('starts when the recorded pid is alive but its port answers for another process (pid reused)', async () => {
    const other = healthServer(process.ppid + 100_000);
    const port = await listen(other);
    const { configDir } = await configWith({ port, pid: process.ppid });
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      expect((await readServerInfo(configDir))?.pid).toBe(process.pid);
    } finally {
      await s.close();
      other.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('does not start when another live instance answers: returns its address and leaves run/ alone', async () => {
    const other = healthServer(process.ppid);
    const port = await listen(other);
    const { configDir, token } = await configWith({ port, pid: process.ppid });
    try {
      const err = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault() }).then(async (s) => { await s.close(); return null; }, (e) => e);
      expect(err).toBeInstanceOf(AlreadyRunningError);
      expect(err.alreadyRunning).toEqual({ port, pid: process.ppid, appUrl: `http://127.0.0.1:${port}/#t=${token}` });
      expect(existsSync(join(configDir, 'run', 'old.mcp.json'))).toBe(true);
      expect((await readServerInfo(configDir))?.pid).toBe(process.ppid);
    } finally {
      other.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('starts and sweeps run/ when the recorded pid is dead', async () => {
    const { configDir } = await configWith({ port: 1, pid: deadPid() });
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      expect(existsSync(join(configDir, 'run', 'old.mcp.json'))).toBe(false);
      expect((await readServerInfo(configDir))?.pid).toBe(process.pid);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('treats a live pid whose port stays silent as dead (bounded wait)', async () => {
    const silent = createServer(() => { /* accepts, never answers */ });
    const port = await listen(silent);
    const { configDir } = await configWith({ port, pid: process.ppid });
    // The wait is checked on the logic, not on the wall clock (a loaded machine stretches any time limit): one health request to
    // the silent port, carrying a timeout signal, which is what ended the wait. An unbounded wait would hang until the test's timeout.
    const seen: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`:${port}/`)) seen.push({ url, signal: init?.signal ?? undefined });
      return realFetch(input, init);
    }) as typeof fetch);
    let s: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault(), healthTimeoutMs: 200 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`http://127.0.0.1:${port}/api/health`);
      expect(seen[0]!.signal).toBeDefined();
      expect(seen[0]!.signal!.aborted).toBe(true);
      expect((seen[0]!.signal!.reason as Error).name).toBe('TimeoutError');
      expect(existsSync(join(configDir, 'run', 'old.mcp.json'))).toBe(false);
      expect((await readServerInfo(configDir))?.pid).toBe(process.pid);
    } finally {
      spy.mockRestore();
      await s?.close();
      silent.close();
      await rm(configDir, { recursive: true, force: true });
    }
  }, 60_000);
  it('close() leaves another instance\'s server.json in place', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      await writeFile(join(configDir, 'run', 'server.json'), JSON.stringify({ port: 1, pid: process.ppid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    } finally {
      await s.close();
    }
    expect((await readServerInfo(configDir))?.pid).toBe(process.ppid);
    await rm(configDir, { recursive: true, force: true });
  });
});

describe('startServer boot lock', () => {
  const lockOf = (configDir: string) => join(configDir, 'run', 'boot.lock');
  const withLock = async (pid: number) => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    await mkdir(join(configDir, 'run'), { mode: 0o700 });
    await writeFile(lockOf(configDir), String(pid), { mode: 0o600 });
    return configDir;
  };
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

  it('holds the lock while booting and releases it once started', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault() });
    try {
      expect(existsSync(lockOf(configDir))).toBe(false);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('releases the lock when the boot fails', async () => {
    const blocker = createServer();
    const port = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as AddressInfo).port)));
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    try {
      const err = await startServer({ port, configDir, claudeCommand: ['true'], vault: new MemoryVault() }).catch((e) => e);
      expect(err.code).toBe('EADDRINUSE');
      expect(existsSync(lockOf(configDir))).toBe(false);
    } finally {
      blocker.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('removes a stale lock (dead pid) and starts', async () => {
    const configDir = await withLock(deadPid());
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault(), bootLockWaitMs: 300 });
    try {
      expect((await readServerInfo(configDir))?.pid).toBe(process.pid);
      expect(existsSync(lockOf(configDir))).toBe(false);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('waits for a live lock to go away, then starts', async () => {
    const configDir = await withLock(process.ppid);
    setTimeout(() => void rm(lockOf(configDir), { force: true }), 200);
    const s = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault(), bootLockWaitMs: 3000 });
    try {
      expect((await readServerInfo(configDir))?.pid).toBe(process.pid);
    } finally {
      await s.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('after waiting, reports the instance the lock holder started', async () => {
    const configDir = await withLock(process.ppid);
    const other = createHttpServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, pid: process.ppid })); });
    const port = await new Promise<number>((r) => other.listen(0, '127.0.0.1', () => r((other.address() as AddressInfo).port)));
    // The other boot finishes while we wait: it writes server.json and releases its lock.
    setTimeout(() => {
      void writeFile(join(configDir, 'run', 'server.json'), JSON.stringify({ port, pid: process.ppid, startedAt: new Date().toISOString() }), { mode: 0o600 })
        .then(() => rm(lockOf(configDir), { force: true }));
    }, 200);
    try {
      const err = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault(), bootLockWaitMs: 3000 }).then(async (s) => { await s.close(); return null; }, (e) => e);
      expect(err).toBeInstanceOf(AlreadyRunningError);
      expect(err.alreadyRunning.port).toBe(port);
    } finally {
      other.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('gives up with a clear error when a live lock is never released, and leaves it alone', async () => {
    const configDir = await withLock(process.ppid);
    try {
      const t0 = Date.now();
      const err = await startServer({ port: 0, configDir, claudeCommand: ['true'], vault: new MemoryVault(), bootLockWaitMs: 300 }).then(async (s) => { await s.close(); return null; }, (e) => e);
      expect(err?.message).toBe('Un altro Motion Studio si sta avviando con la stessa configurazione: riprova tra poco');
      // Bounded (the wait is 300 ms; an unbounded wait would run to the test timeout), with room for a loaded machine.
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await readFile(lockOf(configDir), 'utf8')).toBe(String(process.ppid));
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
  it('is never removed by the run/ sweep', async () => {
    const configDir = await withLock(process.ppid);
    try {
      await sweepRunDir(configDir);
      expect(existsSync(lockOf(configDir))).toBe(true);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
