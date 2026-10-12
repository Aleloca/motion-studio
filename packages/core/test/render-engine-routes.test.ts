// @vitest-environment node
/**
 * The render engine routes of the System check (Task 8, carry 12): which Chromium renders, and the on-demand Chrome for
 * Testing download, which never starts without the user's consent to the exact size shown. No network: the installer is
 * a fake (the real download and archive checks are in cft-download.test.ts, on a fake local endpoint).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderEngineStatus } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { Git } from '../src/git.ts';
import { CftError, type CftDownloadInfo } from '../src/render/cft-download.ts';
import type { RenderEngine, RenderEngineInfo } from '../src/render/renderer.ts';
import { buildServer } from '../src/server/app.ts';
import type { ChromeInstaller } from '../src/server/render-engine-routes.ts';

const TOKEN = 'ab'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const OFFER: CftDownloadInfo = { version: '131.0.6778.85', platform: 'mac-arm64', url: 'https://example.invalid/x.zip', sizeBytes: 98_765_432 };

interface FakeInstaller extends ChromeInstaller {
  infoCalls: number;
  installs: Array<{ consent: unknown; info: CftDownloadInfo }>;
  /** Resolves the running install. */
  finish(ok?: boolean): void;
  progress(bytes: number): void;
}
function fakeInstaller(offer = OFFER): FakeInstaller {
  let done: ((ok: boolean) => void) | null = null;
  let onProgress: ((p: { bytes: number; total: number | null }) => void) | null = null;
  const f: FakeInstaller = {
    infoCalls: 0,
    installs: [],
    info: async () => { f.infoCalls += 1; return offer; },
    install: (o) => {
      f.installs.push({ consent: o.consent, info: o.info });
      onProgress = o.onProgress;
      return new Promise((resolve, reject) => { done = (ok) => (ok ? resolve({ exe: '/x', version: o.info.version }) : reject(new Error('the archive has no chrome-headless-shell'))); });
    },
    finish: (ok = true) => done?.(ok),
    progress: (bytes) => onProgress?.({ bytes, total: offer.sizeBytes }),
  };
  return f;
}
const engineOf = (info: RenderEngineInfo): RenderEngine => ({ info: async () => info } as unknown as RenderEngine);

let base: string;
let app: FastifyInstance;
const build = async (o: { engine?: RenderEngine; installer?: ChromeInstaller | null }) => {
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, '-e', ''], { killGraceMs: 200 }), doctor: async () => [],
    ...(o.engine ? { render: o.engine } : {}), chromeInstaller: o.installer ?? null,
  });
};
const status = async () => (await app.inject({ url: '/api/render-engine', headers: H })).json() as RenderEngineStatus;
const until = async (pred: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
};

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-test-engine-')); });
afterEach(async () => { await app?.close(); rmSync(base, { recursive: true, force: true }); });

describe('GET /api/render-engine', () => {
  it('needs the UI token', async () => {
    await build({ engine: engineOf({ kind: 'system', version: '131.0.1.2' }) });
    expect((await app.inject({ url: '/api/render-engine' })).statusCode).toBe(401);
  });
  it('names the engine: Electron, system Chrome with its version, none', async () => {
    await build({ engine: engineOf({ kind: 'electron' }), installer: fakeInstaller() });
    expect(await status()).toEqual({ kind: 'electron', downloadable: false, download: { state: 'idle', bytes: 0, total: null } });
    await app.close();
    await build({ engine: engineOf({ kind: 'system', exe: '/Applications/Google Chrome.app/x', version: '131.0.1.2' }), installer: fakeInstaller() });
    const s = await status();
    expect(s).toMatchObject({ kind: 'system', version: '131.0.1.2', downloadable: false });
    expect(JSON.stringify(s)).not.toContain('/Applications');
    await app.close();
    await build({ engine: engineOf({ kind: null }), installer: fakeInstaller() });
    expect(await status()).toMatchObject({ kind: null, downloadable: true });
  });
  it('without a renderer or an installer nothing can be downloaded', async () => {
    await build({});
    expect(await status()).toMatchObject({ kind: null, downloadable: false });
  });
});

describe('Chrome for Testing download (consent first)', () => {
  it('offers the exact size from the metadata, downloading nothing', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: null }), installer: inst });
    const r = await app.inject({ url: '/api/render-engine/download-info', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version: OFFER.version, sizeBytes: OFFER.sizeBytes });
    expect(inst.installs).toEqual([]);
  });
  it('refuses a download without consent: true (nothing is fetched)', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: null }), installer: inst });
    for (const payload of [{}, { sizeBytes: OFFER.sizeBytes }, { consent: 'yes', sizeBytes: OFFER.sizeBytes }, { consent: 1, sizeBytes: OFFER.sizeBytes }, { consent: false, sizeBytes: OFFER.sizeBytes }]) {
      const r = await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().code).toBe('consent-required');
    }
    expect(inst.installs).toEqual([]);
    expect(inst.infoCalls).toBe(0);
  });
  it('refuses when the size agreed to is not the size offered now', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: null }), installer: inst });
    const r = await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes - 1 } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('download-size-changed');
    expect(inst.installs).toEqual([]);
  });
  it('refuses when a Chromium is already there (desktop: Electron)', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: 'electron' }), installer: inst });
    const r = await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('engine-available');
    expect(inst.installs).toEqual([]);
  });
  it('downloads with consent, reports progress, once at a time', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: null }), installer: inst });
    const r = await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ download: { state: 'running', bytes: 0, total: OFFER.sizeBytes } });
    expect(inst.installs).toEqual([{ consent: true, info: OFFER }]);
    inst.progress(1234);
    expect((await status()).download).toEqual({ state: 'running', bytes: 1234, total: OFFER.sizeBytes });
    // A second request while it runs starts nothing.
    expect((await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } })).statusCode).toBe(202);
    expect(inst.installs).toHaveLength(1);
    inst.finish();
    await until(async () => (await status()).download.state === 'done');
  });
  it('a failed download says why and can be tried again', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: null }), installer: inst });
    await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } });
    inst.finish(false);
    await until(async () => (await status()).download.state === 'failed');
    // A code and a pointer to the log, never the raw message (it may hold local paths).
    const error = (await status()).download.error!;
    expect(error).toContain('(error)');
    expect(error).not.toContain('chrome-headless-shell');
    await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } });
    expect(inst.installs).toHaveLength(2);
  });
  it('the metadata failing is a clear 503 with a code only, not a download', async () => {
    const inst = fakeInstaller();
    inst.info = async () => { throw new CftError('download', 'manifest: ENOENT /Users/someone/secret/path'); };
    await build({ engine: engineOf({ kind: null }), installer: inst });
    const r = await app.inject({ url: '/api/render-engine/download-info', headers: H });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('chrome-info-failed');
    expect(r.json().error).toContain('(download)');
    expect(r.json().error).not.toContain('/Users/');
  });
  it('two requests at once start exactly one download; the loser answers 202 "running" while the winner is still inside the route (C12)', async () => {
    const inst = fakeInstaller();
    // The metadata read is held open: the winner is inside the route until the loser has been answered, so the two
    // requests provably overlap (a sequential run could not pass).
    const info = inst.info;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    inst.info = async () => { await gate; return info(); };
    await build({ engine: engineOf({ kind: null }), installer: inst });
    const post = () => app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } });
    let winnerDone = false;
    const winner = post().then((r) => { winnerDone = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    const loser = await post();
    expect(winnerDone).toBe(false);
    expect(loser.statusCode).toBe(202);
    expect(loser.json().download).toEqual({ state: 'running', bytes: 0, total: null });
    release();
    expect((await winner).statusCode).toBe(202);
    expect(inst.installs).toHaveLength(1);
    expect(inst.infoCalls).toBe(1);
    inst.finish();
    await until(async () => (await status()).download.state === 'done');
  });
  it('a refused request releases the slot', async () => {
    const inst = fakeInstaller();
    await build({ engine: engineOf({ kind: null }), installer: inst });
    expect((await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/render-engine/download', headers: H, payload: { consent: true, sizeBytes: OFFER.sizeBytes } })).statusCode).toBe(202);
    expect(inst.installs).toHaveLength(1);
  });
});
