// @vitest-environment node
/**
 * Storyboards, the agent's preview_frames and live preview sessions in real Chrome (Task 5b): a composition turn of the fake
 * agent on a 1080×1920 format gets its storyboard (JPEG frames 270 px wide, shrunk by the browser), the agent's
 * preview_frames returns PNGs 540 px wide, a preview session serves the runtime page with the UI origin as its only frame
 * ancestor, and no browser is left running. Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormatPreset, JobSummary } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { storyboardDir } from '../src/creatives/previews.ts';
import { Git } from '../src/git.ts';
import { imageSize } from '../src/render/capture.ts';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { createRenderEngine } from '../src/render/renderer.ts';
import { liveGroupCount } from '../src/render/watchdog.ts';
import { buildServer } from '../src/server/app.ts';
import { buildRuntime, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('preview tests');
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'cb'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const UI_ORIGIN = 'http://127.0.0.1:5998';
const PRESET: FormatPreset = { id: 'test-reel', channel: 'Test', name: 'Reel', width: 1080, height: 1920, kind: 'video', extensions: ['mp4'] };

describe.skipIf(!tools.ok)('previews in real Chrome', () => {
  let work: string;
  let app: FastifyInstance;
  const bridge = new AgentBridge();

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-previews-chrome-'));
    const dist = join(work, 'dist');
    mkdirSync(join(work, 'render-tmp'));
    await buildRuntime(dist);
    app = await buildServer({
      uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(work, 'config')), git: new Git(),
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
      render: createRenderEngine({ provider: async () => new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 10 * 60_000 } }) }),
      renderOptions: { distDir: dist, tempDir: join(work, 'render-tmp') },
      uiOrigins: () => [UI_ORIGIN], bridge, mcpCommand: [process.execPath, '-e', ''],
    });
    bridge.setOrigin(await app.listen({ port: 0, host: '127.0.0.1' }));
    await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: join(work, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
    await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [PRESET] } });
  }, 600_000);
  afterAll(async () => {
    for (const k of ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_BRIDGE_CALLS', 'FAKE_CLAUDE_BRIDGE_LOG']) delete process.env[k];
    await app?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('storyboard frames, the agent\'s frames and a preview session', { timeout: 900_000 }, async () => {
    const log = join(work, 'bridge.jsonl');
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
    process.env.FAKE_CLAUDE_BRIDGE_CALLS = JSON.stringify([['preview_frames', { format: 'test-reel', times: [0, 2.5] }]]);
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Reel', generate: true, brief: { goal: 'g', message: '', formats: ['test-reel'], durationSec: 4, assets: [], notes: '' },
    } });
    expect(r.statusCode, r.body).toBe(201);
    const slug = r.json().slug as string;
    const id = (r.json().job as JobSummary).id;
    for (let i = 0; i < 6000; i++) {
      const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id)!;
      if (j.state !== 'queued' && j.state !== 'running') { expect(j.state, j.error).toBe('succeeded'); break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    // The agent's frames: PNG, 540 px wide (shrunk in the browser).
    const call = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as { status: number; body: { images: Array<{ mimeType: string; data: string }>; runtimeErrors?: unknown } };
    expect(call.status, JSON.stringify(call.body).slice(0, 500)).toBe(200);
    expect(call.body.runtimeErrors).toBeUndefined();
    for (const img of call.body.images) {
      const buf = Buffer.from(img.data, 'base64');
      expect(img.mimeType).toBe('image/png');
      expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect(imageSize(buf)).toEqual({ width: 540, height: 960 });
    }
    // The storyboard: JPEG frames 270 px wide.
    const dir = storyboardDir(join(work, 'ws', 'acme'), slug, 1, 'test-reel');
    const sb = JSON.parse(readFileSync(join(dir, 'storyboard.json'), 'utf8')) as { frames: Array<{ file: string; width: number; height: number }> };
    expect(sb.frames).toHaveLength(3);
    for (const f of sb.frames) {
      const buf = readFileSync(join(dir, f.file));
      expect(buf[0]).toBe(0xff);
      expect(imageSize(buf)).toEqual({ width: 270, height: 480 });
      expect([f.width, f.height]).toEqual([270, 480]);
    }
    // A live preview session: the runtime page, framed only by the UI origin.
    const s = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H, payload: { format: 'test-reel', parentOrigin: UI_ORIGIN } });
    expect(s.statusCode, s.body).toBe(200);
    const page = await fetch((s.json() as { url: string }).url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(`frame-ancestors ${UI_ORIGIN}`);
    await page.text();
    expect(liveGroupCount()).toBe(0);
  });
});
