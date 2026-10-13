/**
 * A core server for the format-instance suites (Phase 12, Task 1): the fake claude (composition scenario), an injected render
 * engine that writes a small file per render, and a catalog of small test presets. Everything lives under the OS temp folder.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { FormatPreset, JobSummary, VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../../src/app-config.ts';
import { ClaudeCodeRunner } from '../../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../../src/bridge/bridge.ts';
import { CreativeStore } from '../../src/creatives/creative-store.ts';
import { noteCoreTemp } from '../../src/core-temps.ts';
import { Git } from '../../src/git.ts';
import { frameTime, type RenderFramesOptions, type RenderFramesResult } from '../../src/render/frames.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../../src/render/renderer.ts';
import { buildServer } from '../../src/server/app.ts';
import { FONT } from './render-env.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
export const TOKEN = 'f1'.repeat(32);
export const H = { 'x-motion-studio-ui': TOKEN };
export const UI_ORIGIN = 'http://127.0.0.1:5995';
export const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
  { id: 'test-wide-b', channel: 'Test', name: 'Wide B', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
  { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4'] },
  // `foo-2` (a user preset) and `foo@2` (an instance of `foo`) slug to the same export token (Phase 12 Ruling C).
  { id: 'foo', channel: 'Test', name: 'Foo', width: 200, height: 200, kind: 'video', extensions: ['mp4'] },
  { id: 'foo-2', channel: 'Test', name: 'Foo two', width: 200, height: 200, kind: 'video', extensions: ['mp4'] },
];
const ENV = ['FAKE_CLAUDE_DURATION', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_FONT', 'FAKE_CLAUDE_TEXT', 'FAKE_CLAUDE_IMAGE', 'FAKE_CLAUDE_COMP_TAG'];

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** `gate`: while set, every render waits for it (a render that is running). */
export interface FakeEngine { engine: RenderEngine; renders: RenderCompositionOptions[]; gate: Promise<void> | null }
function fakeEngine(): FakeEngine {
  const f: FakeEngine = { renders: [], gate: null, engine: null as unknown as RenderEngine };
  f.engine = {
    info: async () => ({ kind: 'injected' }),
    provider: async () => { throw new Error('not used'); },
    frames: async (o: Omit<RenderFramesOptions, 'provider'>): Promise<RenderFramesResult> => {
      const c = o.composition;
      const height = Math.round((o.width * c.height) / c.width);
      return { frames: o.times.map((t) => ({ t: frameTime(c, t), data: png(o.width, height), width: o.width, height })), errors: [] };
    },
    render: async (o: Omit<RenderCompositionOptions, 'provider'>): Promise<RenderResult> => {
      f.renders.push(o as RenderCompositionOptions);
      if (f.gate) await f.gate;
      const temp = join(dirname(o.out), `.${basename(o.out)}.render-${randomBytes(6).toString('hex')}.tmp`);
      noteCoreTemp(temp);
      const body = `render of ${o.format.id} ${randomBytes(4).toString('hex')}`;
      await writeFile(temp, body);
      await o.beforeRename?.(temp);
      await rename(temp, o.out);
      return { file: o.out, sha256: createHash('sha256').update(body).digest('hex'), width: o.composition.width, height: o.composition.height,
        durationSec: o.composition.duration, frames: 1, encoder: 'libx264', audio: false, warnings: [] };
    },
  } as unknown as RenderEngine;
  return f;
}

export interface InstanceEnv {
  base: string; ws: string; app: FastifyInstance; fake: FakeEngine; prompts: string;
  projectDir(): string; store(): CreativeStore;
  /** The prompts the fake claude received, in order. */
  promptTexts(): string[];
  agentRuns(): number;
  versionOf(slug: string, n: number): Promise<VersionEntry | undefined>;
  waitJob(id: string): Promise<JobSummary>;
  waitRunning(id: string): Promise<void>;
  create(formats: string[], o?: { links?: Record<string, string>; formatLabels?: Record<string, string>; locales?: { primary: string; extra: string[] } }): Promise<string>;
  turn(slug: string, payload: object): Promise<void>;
  render(slug: string, n: number): Promise<void>;
  close(): Promise<void>;
}

/** `extra`: more server dependencies (e.g. a fake Google Fonts network, Phase 12 Task 3). */
export async function startInstanceEnv(prefix: string, extra: Partial<Parameters<typeof buildServer>[0]> = {}): Promise<InstanceEnv> {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const fake = fakeEngine();
  const app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    render: fake.engine, uiOrigins: () => [UI_ORIGIN], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''], ...extra,
  });
  const ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
  const prompts = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = prompts;
  process.env.FAKE_CLAUDE_SCENARIO = 'composition';
  process.env.FAKE_CLAUDE_FONT = FONT;
  process.env.FAKE_CLAUDE_TEXT = '1';
  const projectDir = () => join(ws, 'acme');
  const store = () => new CreativeStore(projectDir());
  const promptTexts = () => (existsSync(prompts) ? readFileSync(prompts, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { prompt: string }).prompt) : []);
  const waitJob = async (id: string): Promise<JobSummary> => {
    for (let i = 0; i < 3000; i++) {
      const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
      if (j && j.state !== 'queued' && j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout waiting for the job');
  };
  return {
    base, ws, app, fake, prompts, projectDir, store, promptTexts,
    agentRuns: () => promptTexts().length,
    versionOf: async (slug, n) => (await store().readVersions(slug)).find((v) => v.n === n),
    waitJob,
    async waitRunning(id) {
      for (let i = 0; i < 3000; i++) {
        const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
        if (j?.state === 'running') return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('timeout waiting for the job to run');
    },
    async create(formats, o = {}) {
      const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
        title: 'Launch', generate: true, brief: { goal: 'g', message: '', formats, durationSec: 4, assets: [], notes: '', ...(o.links ? { links: o.links } : {}), ...(o.formatLabels ? { formatLabels: o.formatLabels } : {}), ...(o.locales ? { locales: o.locales } : {}) },
      } });
      expect(r.statusCode, r.body).toBe(201);
      const done = await waitJob((r.json().job as JobSummary).id);
      expect(done.state, done.error).toBe('succeeded');
      return r.json().slug as string;
    },
    async turn(slug, payload) {
      const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload });
      expect(r.statusCode, r.body).toBe(202);
      const done = await waitJob((r.json() as JobSummary).id);
      expect(done.state, done.error).toBe('succeeded');
    },
    async render(slug, n) {
      const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/${n}/render`, headers: H, payload: {} });
      expect(r.statusCode, r.body).toBe(202);
      const done = await waitJob((r.json() as JobSummary).id);
      expect(done.state, done.error).toBe('succeeded');
    },
    async close() {
      for (const k of ENV) delete process.env[k];
      await app.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
