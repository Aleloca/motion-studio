// @vitest-environment node
/**
 * Final wave B6: the "record folders moved" warning seen on the phase 9 build at a new creative's very first generation.
 * The first-generation sequence (create with generate, `status: working`, `work/` and `outputs/` made by the core, the
 * agent's run with the tripwire armed around it, the web reading the creative meanwhile, the version saved) is replayed
 * here on 10a for both contracts: no warning. The one way it fires is an entry the agent itself makes at the top of the
 * creative's folder (by design: the folder's identity cannot tell that from a move), which is what the phase 9 agent did
 * (it rendered with its own scripts; nothing was moved).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type JobSummary } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import type { AgentContract } from '../src/creatives/prompt.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'cd'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const PRESETS = [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 }];
const ENV = ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_NO_FFMPEG', 'FAKE_CLAUDE_STRAY_ROOT', 'FAKE_CLAUDE_WAIT_FILE_CREATIVE'];
/** The warning's fixed opening, in both languages. */
const MOVED = ['en', 'it'].map((l) => messages(l as 'en' | 'it').jobs.recordFoldersMoved({ list: '\u0000' }).split('\u0000')[0]!);

let base: string;
let app: FastifyInstance;
let ws: string;
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await app?.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

async function boot(contract: AgentContract) {
  base = mkdtempSync(join(tmpdir(), 'ms-test-tripwire-first-'));
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [], bridge: new AgentBridge(), mcpCommand: null,
    agentContract: contract,
  });
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
}
async function waitJob(id: string): Promise<JobSummary> {
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
/** A new creative with Generate, the web reading it while the agent runs (held until `go` exists), then the version. */
async function firstGeneration(): Promise<{ slug: string; warnings: string[]; job: JobSummary }> {
  const go = join(base, 'go');
  process.env.FAKE_CLAUDE_WAIT_FILE_CREATIVE = go;
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Legacy promo', generate: true, brief: { goal: 'g', message: '', formats: ['test-wide'], durationSec: 4, assets: [], notes: '' } } });
  expect(r.statusCode, r.body).toBe(201);
  const slug = r.json().slug as string;
  // The canvas loads the creative, its conversation and the job list while the turn runs.
  for (let i = 0; i < 3; i++) {
    expect((await app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).statusCode).toBe(200);
    await app.inject({ url: `/api/projects/acme/creatives/${slug}/conversation`, headers: H });
    await new Promise((res) => setTimeout(res, 50));
  }
  writeFileSync(go, '');
  const job = await waitJob((r.json().job as JobSummary).id);
  const store = new CreativeStore(join(ws, 'acme'));
  const warnings = (await store.readConversation(slug)).filter((e) => e.type === 'system').map((e) => (e as { text: string }).text);
  return { slug, warnings, job };
}
const moved = (warnings: string[]) => warnings.filter((w) => MOVED.some((m) => w.startsWith(m)));

describe('the first generation of a new creative never trips the record-folder warning by itself (B6)', { timeout: 120_000 }, () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_NO_FFMPEG = '1'; });

  it('compositions (10a): no warning, the version is saved', async () => {
    await boot('compositions');
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    const { slug, warnings, job } = await firstGeneration();
    expect(job.state, job.error).toBe('succeeded');
    expect(moved(warnings)).toEqual([]);
    expect(existsSync(join(ws, 'acme', 'creatives', slug, 'outputs', 'v1', 'compositions', 'test-wide', 'composition.json'))).toBe(true);
  });

  it('media (the phase 9 contract): no warning either', async () => {
    await boot('media');
    process.env.FAKE_CLAUDE_SCENARIO = 'render';
    const { warnings, job } = await firstGeneration();
    expect(job.state, job.error).toBe('succeeded');
    expect(moved(warnings)).toEqual([]);
  });

  it('the cause seen on phase 9: an entry the agent makes at the top of the creative folder (by design, either contract)', async () => {
    await boot('compositions');
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    process.env.FAKE_CLAUDE_STRAY_ROOT = 'frames';
    const { slug, warnings } = await firstGeneration();
    expect(moved(warnings)).toEqual([expect.stringContaining(`creatives/${slug}`)]);
  });
});
