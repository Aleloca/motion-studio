// @vitest-environment node
/**
 * The editor's core routes (Phase 10b, Task 3) through the real app and the fake agent: the composition view (a primary, a
 * follower answered with its primary's, 404 for a legacy version) and the staging route (body checks, the UI token, a
 * live session of the same creative, a file served under the session token). No agent runs for any of them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type EditorCompositionView, type FormatPreset, type JobSummary, type StagedAsset } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { stagingDirOf } from '../src/creatives/editor-staging.ts';
import { Git } from '../src/git.ts';
import { currentLocale } from '../src/i18n.ts';
import { buildServer } from '../src/server/app.ts';
import { FONT } from './helpers/render-env.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'ad'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const UI_ORIGIN = 'http://127.0.0.1:5996';
const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
  { id: 'test-wide-b', channel: 'Test', name: 'Wide B', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>';

let base: string;
let ws: string;
let app: FastifyInstance;
let calls: string;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-editor-routes-'));
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    uiOrigins: () => [UI_ORIGIN], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''],
  });
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
  calls = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = calls;
  process.env.FAKE_CLAUDE_SCENARIO = 'composition';
  process.env.FAKE_CLAUDE_FONT = FONT;
});
afterEach(async () => {
  for (const k of ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_FONT']) delete process.env[k];
  await app?.close();
  rmSync(base, { recursive: true, force: true });
});

const projectDir = () => join(ws, 'acme');
const agentRuns = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0);
async function create(formats: string[], links?: Record<string, string>): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: true, brief: { goal: 'g', message: '', formats, durationSec: 4, assets: [], notes: '', ...(links ? { links } : {}) },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const id = (r.json().job as JobSummary).id;
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') { expect(j.state, j.error).toBe('succeeded'); break; }
    await new Promise((res) => setTimeout(res, 20));
  }
  return r.json().slug as string;
}
const view = (slug: string, n: number | string, format: string, headers: Record<string, string> = H) =>
  app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/${n}/compositions/${format}`, headers });
const mint = async (slug: string) => (await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H,
  payload: { format: 'test-wide', parentOrigin: UI_ORIGIN } })).json() as { url: string; token: string };
const stage = (slug: string, payload: unknown, headers: Record<string, string> = H) =>
  app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/editor/stage`, headers, payload: payload as object });

describe('the editor composition view', { timeout: 120_000 }, () => {
  it('answers the primary\'s composition, its files and fonts; a follower gets its primary\'s; legacy and unknown are 404', async () => {
    mkdirSync(join(projectDir(), 'brand'), { recursive: true });
    writeFileSync(join(projectDir(), 'brand', 'brand-kit.json'), JSON.stringify({ schemaVersion: 1, colors: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null,
      fonts: [{ id: 'mono', family: 'mono', role: 'body', weights: [400], file: null, source: { kind: 'manual', ref: null } },
        { id: 'lora', family: 'Lora', role: 'heading', weights: [700, 400], file: 'assets/Lora.woff2', source: { kind: 'manual', ref: null } }] }));
    const slug = await create(['test-wide', 'test-wide-b'], { 'test-wide-b': 'test-wide' });
    const runs = agentRuns();
    const r = await view(slug, 1, 'test-wide');
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json() as EditorCompositionView;
    const version = (await new CreativeStore(projectDir()).readVersions(slug)).find((x) => x.n === 1)!;
    const entry = version.compositions!.find((c) => c.format === 'test-wide')!;
    expect(v).toMatchObject({ n: 1, format: 'test-wide', primaryFormat: 'test-wide', hash: entry.hash });
    expect(v.composition).toMatchObject({ width: 320, height: 180, fps: 30, fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 700 }] });
    expect(v.files.map((f) => f.path).sort()).toEqual(['assets/Mono.woff2', 'composition.json']);
    expect(v.files.find((f) => f.path === 'assets/Mono.woff2')!.size).toBe(readFileSync(FONT).length);
    // The composition's fonts first; a brand font with the same family (any case) is not offered twice.
    expect(v.fonts).toEqual([
      { family: 'Mono', weights: [700], source: 'composition', staged: false },
      { family: 'Lora', weights: [400, 700], source: 'brand', brandFontId: 'lora', staged: false },
    ]);
    // A follower: its primary's composition, named as such.
    const f = await view(slug, 1, 'test-wide-b');
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json()).toMatchObject({ n: 1, format: 'test-wide-b', primaryFormat: 'test-wide', hash: entry.hash, composition: v.composition });
    // Unknown format, version, malformed number, no UI token.
    expect((await view(slug, 1, 'nope')).statusCode).toBe(404);
    expect((await view(slug, 1, 'nope')).json().code).toBe('composition-not-found');
    expect((await view(slug, 9, 'test-wide')).statusCode).toBe(404);
    expect((await view(slug, '1x', 'test-wide')).statusCode).toBe(404);
    expect((await view(slug, 1, 'test-wide', {})).statusCode).toBe(401);
    // A legacy version (media, no compositions): 404.
    await new CreativeStore(projectDir()).appendVersion(slug, { n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [],
      tools: ['remotion'], renderCommand: 'npx remotion render', basedOn: 1, outputs: [] });
    const legacy = await view(slug, 2, 'test-wide');
    expect(legacy.statusCode, legacy.body).toBe(404);
    expect(legacy.json().code).toBe('composition-not-found');
    // A composition changed after it was saved is not offered for editing.
    writeFileSync(join(new CreativeStore(projectDir()).dir(slug), 'outputs', 'v1', 'compositions', 'test-wide', 'assets', 'extra.png'), 'x');
    const changed = await view(slug, 1, 'test-wide');
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('composition-unusable');
    expect(agentRuns()).toBe(runs); // no agent
  });
});

describe('the staging route', { timeout: 120_000 }, () => {
  it('checks the body and the UI token, needs a live session of this creative, and serves the staged file under its token', async () => {
    const slug = await create(['test-wide']);
    const other = await create(['test-wide']);
    writeFileSync(join(projectDir(), 'assets', 'logo.svg'), SVG);
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', headers: H, payload: { files: ['logo.svg'] } })).statusCode).toBe(200);
    const runs = agentRuns();
    const s = await mint(slug);
    const ok = { token: s.token, from: { kind: 'library', file: 'logo.svg' } };
    expect((await stage(slug, ok, {})).statusCode).toBe(401);
    for (const bad of [{}, { token: s.token }, { ...ok, extra: 1 }, { ...ok, token: 'short' }, { ...ok, from: { kind: 'path', file: '/etc/hosts' } },
      { ...ok, from: { kind: 'library', file: 'logo.svg', abs: '/etc/hosts' } }, { ...ok, from: { kind: 'brandFont' } }, { ...ok, from: { kind: 'library', file: 'x'.repeat(301) } }]) {
      expect((await stage(slug, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // Another creative's token: no such live session here, and nothing is written for it.
    const foreign = await stage(other, ok);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: messages(currentLocale()).editor.stageNoSession, code: 'editor-no-session' });
    expect(existsSync(stagingDirOf(projectDir(), other, s.token))).toBe(false);
    // Path traversal in `file`.
    const trav = await stage(slug, { ...ok, from: { kind: 'library', file: '../creatives/x.svg' } });
    expect(trav.statusCode).toBe(400);
    expect(trav.json().code).toBe('editor-not-registered');
    const r = await stage(slug, ok);
    expect(r.statusCode, r.body).toBe(200);
    const asset = r.json() as StagedAsset;
    expect(asset).toEqual({ path: `assets/lib/${createHash('sha256').update(SVG).digest('hex').slice(0, 8)}-logo.svg`, size: SVG.length, kind: 'svg', width: 40, height: 20 });
    const file = await fetch(`${s.url.split('/runtime/')[0]}/outputs/v1/compositions/test-wide/${asset.path}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(SVG);
    expect(file.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    // Revoked: the file is no longer served and staging is refused; the folder waits a while for a late renewal (decisions log 264).
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session/${s.token}`, headers: H })).statusCode).toBe(200);
    expect((await fetch(`${s.url.split('/runtime/')[0]}/outputs/v1/compositions/test-wide/${asset.path}`)).status).not.toBe(200);
    expect((await stage(slug, ok)).json().code).toBe('editor-no-session');
    expect(existsSync(stagingDirOf(projectDir(), slug, s.token))).toBe(true);
    expect(agentRuns()).toBe(runs); // no agent
  });
});
