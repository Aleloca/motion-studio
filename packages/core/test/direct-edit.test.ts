// @vitest-environment node
/**
 * Direct edits (Phase 10b, Task 4): `POST …/creatives/:c/edits` saves an editor draft as a new version with no agent (the
 * fake claude is never spawned) and no usage-ledger line, under the creative's lock: the edited composition, the base's
 * files copied and verified, the staged files the draft uses, the other formats carried, renders carried only where the
 * composition is unchanged, followers re-checked (Review Focus 2), refusals while a turn or a render runs and when the base
 * moved on (Review Focus 1), invalid and non-editable drafts refused with nothing left behind, and a crash half-way.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { COMPOSITION_LIMITS, draftJsonBytes, draftSizeProblem, formatLabel, messages, starOf, type Composition, type EditorCompositionView, type FormatPreset, type JobSummary, type ManifestV2, type ServerMessage, type StagedAsset, type VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { compositionFileText, editorRefusals } from '../src/creatives/direct-edit.ts';
import { storyboardDir } from '../src/creatives/previews.ts';
import { noteCoreTemp } from '../src/core-temps.ts';
import { Git } from '../src/git.ts';
import { currentLocale } from '../src/i18n.ts';
import { frameTime, type RenderFramesOptions, type RenderFramesResult } from '../src/render/frames.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../src/render/renderer.ts';
import { buildServer } from '../src/server/app.ts';
import { usageLedgerFile } from '../src/usage/usage-ledger.ts';
import { FONT } from './helpers/render-env.ts';
import { findFfmpeg } from '../src/render/encode.ts';
import { stagingIdOf } from '../src/creatives/editor-staging.ts';
const ffmpegInfo = await findFfmpeg();

// A crash between the copy and the manifest: `assembleCompositions` throws while `crash.on` is set.
const crash = vi.hoisted(() => ({ on: false }));
vi.mock('../src/creatives/composition-turn.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/creatives/composition-turn.ts')>();
  return {
    ...mod,
    assembleCompositions: async (...args: Parameters<typeof mod.assembleCompositions>) => {
      if (crash.on) throw new Error('injected crash before the manifest');
      return mod.assembleCompositions(...args);
    },
  };
});

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'de'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const UI_ORIGIN = 'http://127.0.0.1:5995';
const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
  { id: 'test-wide-b', channel: 'Test', name: 'Wide B', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
  { id: 'test-short', channel: 'Test', name: 'Short', width: 320, height: 180, kind: 'video', extensions: ['mp4'], maxDurationSec: 5.5 },
  { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4'] },
];
const SVG2 = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0f0"/></svg>';
const SVG3 = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00f"/></svg>';

/** A minimal PNG header (what `imageSize` reads): enough for a fake frame. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
interface Fake { engine: RenderEngine; renders: RenderCompositionOptions[]; frames: Array<Omit<RenderFramesOptions, 'provider'>>; gate: Promise<void> | null }
function fakeEngine(): Fake {
  const f: Fake = { renders: [], frames: [], gate: null, engine: null as unknown as RenderEngine };
  f.engine = {
    info: async () => ({ kind: 'injected' }),
    provider: async () => { throw new Error('not used'); },
    frames: async (o: Omit<RenderFramesOptions, 'provider'>): Promise<RenderFramesResult> => {
      f.frames.push(o);
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

let base: string;
let ws: string;
let app: FastifyInstance;
let fake: Fake;
let prompts: string;
const ENV = ['FAKE_CLAUDE_DURATION', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_FONT', 'FAKE_CLAUDE_TEXT', 'FAKE_CLAUDE_IMAGE', 'FAKE_CLAUDE_COMP_TAG'];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-direct-edit-'));
  fake = fakeEngine();
  crash.on = false;
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    render: fake.engine, uiOrigins: () => [UI_ORIGIN], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''],
  });
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
  prompts = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = prompts;
  process.env.FAKE_CLAUDE_SCENARIO = 'composition';
  process.env.FAKE_CLAUDE_FONT = FONT;
  process.env.FAKE_CLAUDE_TEXT = '1';
  process.env.FAKE_CLAUDE_IMAGE = '1';
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  crash.on = false;
  await app?.close();
  rmSync(base, { recursive: true, force: true });
});

const projectDir = () => join(ws, 'acme');
const store = () => new CreativeStore(projectDir());
/** How many times the fake claude ran (each run appends its prompt). */
const agentRuns = () => (existsSync(prompts) ? readFileSync(prompts, 'utf8').trim().split('\n').length : 0);
const ledgerLines = () => (existsSync(usageLedgerFile(projectDir())) ? readFileSync(usageLedgerFile(projectDir()), 'utf8').trim().split('\n').filter(Boolean).length : 0);
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const compDir = (slug: string, n: number, format: string) => join(store().dir(slug), 'outputs', `v${n}`, 'compositions', format);
const versionOf = async (slug: string, n: number): Promise<VersionEntry | undefined> => (await store().readVersions(slug)).find((v) => v.n === n);
const systemTexts = async (slug: string) => (await store().readConversation(slug)).filter((e) => e.type === 'system').map((e) => (e as { text: string }).text);
const ed = () => messages(currentLocale()).editor;
const label = (id: string) => formatLabel(PRESETS.find((p) => p.id === id)!, currentLocale());

async function waitJob(id: string): Promise<JobSummary> {
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
async function waitRunning(id: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j?.state === 'running') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job to run');
}
async function create(formats: string[], o: { links?: Record<string, string>; durationSec?: number } = {}): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: true, brief: { goal: 'g', message: '', formats, durationSec: o.durationSec ?? 4, assets: [], notes: '', ...(o.links ? { links: o.links } : {}) },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const done = await waitJob((r.json().job as JobSummary).id);
  expect(done.state, done.error).toBe('succeeded');
  return r.json().slug as string;
}
async function turn(slug: string, payload: object): Promise<void> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload });
  expect(r.statusCode, r.body).toBe(202);
  const done = await waitJob((r.json() as JobSummary).id);
  expect(done.state, done.error).toBe('succeeded');
}
async function render(slug: string, n: number): Promise<void> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/${n}/render`, headers: H, payload: {} });
  expect(r.statusCode, r.body).toBe(202);
  expect((await waitJob((r.json() as JobSummary).id)).state).toBe('succeeded');
}
async function view(slug: string, n: number, format: string): Promise<EditorCompositionView> {
  const r = await app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/${n}/compositions/${format}`, headers: H });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as EditorCompositionView;
}
async function mint(slug: string, n = 1, format = 'test-wide'): Promise<{ url: string; token: string }> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/${n}/preview-session`, headers: H, payload: { format, parentOrigin: UI_ORIGIN } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { url: string; token: string };
}
async function stage(slug: string, token: string, file: string): Promise<StagedAsset> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/editor/stage`, headers: H, payload: { token, from: { kind: 'library', file } } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as StagedAsset;
}
function registerLibrary(files: Record<string, string>): Promise<unknown> {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(projectDir(), 'assets', name), text);
  return app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', headers: H, payload: { files: Object.keys(files) } });
}
const NO_TOKEN = 'A'.repeat(43);
type Body = { baseVersion: number; format: string; baseHash: string; composition: unknown; staged: string[]; ops: unknown[]; token: string };
/** A draft of `format` from version `n`'s editor view, changed by `change`. */
async function draft(slug: string, n: number, format: string, change: (c: Composition) => void, ops: unknown[] = []): Promise<Body> {
  const v = await view(slug, n, format);
  const c = structuredClone(v.composition);
  change(c);
  return { baseVersion: n, format, baseHash: v.hash, composition: c, staged: [], ops, token: NO_TOKEN };
}
const save = (slug: string, body: Body | Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/edits`, headers: H, payload: body });
const clip = (c: Composition, id: string) => c.tracks.flatMap((t) => t.clips).find((k) => k.id === id)! as unknown as { src?: string; props: Record<string, unknown>; duration: number; start: number; params?: Record<string, unknown> };

describe('saving a draft as a new version', { timeout: 120_000 }, () => {
  it('a text edit makes v2: the edited composition, the same assets (verified copies), the other format carried, renders carried only where unchanged, no agent, no tokens', async () => {
    const slug = await create(['test-wide', 'test-tall']);
    await render(slug, 1);
    const v1 = (await versionOf(slug, 1))!;
    expect(v1.outputs.map((o) => o.format).sort()).toEqual(['test-tall', 'test-wide']);
    const runs = agentRuns();
    const ledger = ledgerLines();
    // Clients see one `creative` event for the save (and one more when its storyboards are there).
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const sock = new WebSocket(`${address.replace('http', 'ws')}/api/events?t=${TOKEN}`, { headers: { origin: address } });
    const events: ServerMessage[] = [];
    sock.on('message', (d) => events.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => sock.once('open', r));
    const framesBefore = fake.frames.length;

    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Goodbye'; }, [{ kind: 'clipProps', clipId: 'title', props: { text: 'Goodbye' } }]);
    const r = await save(slug, body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ version: 2 });
    const v2 = (await versionOf(slug, 2))!;
    expect(v2).toMatchObject({ n: 2, status: 'complete', problems: [], origin: 'editor', basedOn: 1, request: messages(currentLocale()).editor.summary({ items: messages(currentLocale()).editor.itemText({ name: 'Title' }), more: 0 }), tools: [], renderCommand: null });
    expect(v2.usage).toBeUndefined();
    // The edited composition, normalised on disk; the font asset is a verified copy (same bytes, its own file).
    const saved = JSON.parse(readFileSync(join(compDir(slug, 2, 'test-wide'), 'composition.json'), 'utf8')) as Composition;
    expect(clip(saved, 'title').props.text).toBe('Goodbye');
    const wide2 = v2.compositions!.find((c) => c.format === 'test-wide')!;
    expect(wide2.hash).toBe((await readCompositionFolder(compDir(slug, 2, 'test-wide'))).hash);
    expect(wide2.hash).not.toBe(v1.compositions!.find((c) => c.format === 'test-wide')!.hash);
    for (const asset of ['assets/Mono.woff2', 'assets/logo.svg']) {
      const a = join(compDir(slug, 1, 'test-wide'), asset);
      const b = join(compDir(slug, 2, 'test-wide'), asset);
      expect(sha(b)).toBe(sha(a));
      expect(lstatSync(b).nlink).toBe(1);
      expect(lstatSync(b).ino).not.toBe(lstatSync(a).ino);
    }
    // The other format: carried (same hash), with its render; the edited one's render is not carried.
    expect(v2.compositions!.find((c) => c.format === 'test-tall')).toEqual(v1.compositions!.find((c) => c.format === 'test-tall'));
    expect(v2.outputs.map((o) => o.format)).toEqual(['test-tall']);
    const manifest = JSON.parse(readFileSync(join(store().dir(slug), 'outputs', 'v2', 'manifest.json'), 'utf8')) as ManifestV2;
    expect(manifest.compositions).toEqual(v2.compositions);
    expect(manifest.renders.map((x) => x.format)).toEqual(['test-tall']);
    expect(existsSync(join(store().dir(slug), 'outputs', 'v2', v1.outputs.find((o) => o.format === 'test-tall')!.file))).toBe(true);
    expect(existsSync(join(store().dir(slug), 'outputs', 'v2', v1.outputs.find((o) => o.format === 'test-wide')!.file))).toBe(false);
    // Committed; a version entry in the chat; the creative is ready.
    expect(v2.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: projectDir(), encoding: 'utf8' })).toContain('Launch: v2');
    const conv = await store().readConversation(slug);
    expect(conv.at(-1)).toMatchObject({ type: 'version', n: 2, status: 'complete' });
    expect((await store().get(slug)).status).toBe('ready');
    // Storyboards of v2 regenerated.
    const sb = join(storyboardDir(projectDir(), slug, 2, 'test-wide'), 'storyboard.json');
    for (let i = 0; i < 500 && !existsSync(sb); i++) await new Promise((res) => setTimeout(res, 20));
    expect(JSON.parse(readFileSync(sb, 'utf8')).hash).toBe(wide2.hash);
    expect(fake.frames.length).toBeGreaterThan(framesBefore);
    await new Promise((res) => setTimeout(res, 200));
    sock.close();
    const creativeEvents = events.filter((m) => m.type === 'creative' && m.creative === slug);
    expect(creativeEvents).toHaveLength(2); // the save, then its storyboards
    // No agent, no tokens.
    expect(agentRuns()).toBe(runs);
    expect(ledgerLines()).toBe(ledger);
  });

  it('a staged image replacement is copied into the version; staged files the draft does not use are not', async () => {
    const slug = await create(['test-wide']);
    await registerLibrary({ 'green.svg': SVG2, 'blue.svg': SVG3 });
    const s = await mint(slug);
    const green = await stage(slug, s.token, 'green.svg');
    const blue = await stage(slug, s.token, 'blue.svg');
    const runs = agentRuns();
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'logo').src = green.path; }, [{ kind: 'clipMedia', clipId: 'logo', src: green.path }]);
    body.staged = [green.path, blue.path];
    body.token = s.token;
    const r = await save(slug, body);
    expect(r.statusCode, r.body).toBe(200);
    const dir = compDir(slug, 2, 'test-wide');
    expect(readFileSync(join(dir, green.path), 'utf8')).toBe(SVG2);
    expect(existsSync(join(dir, blue.path))).toBe(false);
    expect(readdirSync(join(dir, 'assets', 'lib'))).toEqual([basename(green.path)]);
    // The base's files are all there too (the replaced logo stays a file of the folder).
    expect(sha(join(dir, 'assets', 'logo.svg'))).toBe(sha(join(compDir(slug, 1, 'test-wide'), 'assets', 'logo.svg')));
    expect((await versionOf(slug, 2))!.compositions![0]!.hash).toBe((await readCompositionFolder(dir)).hash);
    expect(agentRuns()).toBe(runs);
  });

  it('a renewal that arrives after the old session ended still carries the staged files, and the save with the new token works (decisions log 264)', async () => {
    const slug = await create(['test-wide']);
    await registerLibrary({ 'green.svg': SVG2 });
    const a = await mint(slug);
    const green = await stage(slug, a.token, 'green.svg');
    // The old session ends first (a revoke, an eviction, an expiry): its token is gone.
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session/${a.token}`, headers: H })).statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: UI_ORIGIN, renewFrom: a.token } });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json() as { token: string; staged?: StagedAsset[] };
    expect(b.staged).toEqual([green]);
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'logo').src = green.path; }, [{ kind: 'clipMedia', clipId: 'logo', src: green.path }]);
    body.staged = [green.path];
    // With the old token: refused (its staging moved); with the new one: saved.
    body.token = a.token;
    expect((await save(slug, body)).statusCode).toBe(422);
    body.token = b.token;
    const saved = await save(slug, body);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(readFileSync(join(compDir(slug, 2, 'test-wide'), green.path), 'utf8')).toBe(SVG2);
  });

  it('a renewal racing a save: the save either uses the old session\'s staging or is refused and works with the new token; never a half version', async () => {
    const slug = await create(['test-wide']);
    await registerLibrary({ 'green.svg': SVG2 });
    const a = await mint(slug);
    const green = await stage(slug, a.token, 'green.svg');
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'logo').src = green.path; }, [{ kind: 'clipMedia', clipId: 'logo', src: green.path }]);
    body.staged = [green.path];
    body.token = a.token;
    const [first, renewed] = await Promise.all([
      save(slug, body),
      app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: UI_ORIGIN, renewFrom: a.token } }),
    ]);
    expect(renewed.statusCode).toBe(200);
    if (first.statusCode !== 200) {
      expect(first.statusCode).toBe(422);
      expect(await versionOf(slug, 2)).toBeUndefined();
      expect(existsSync(join(store().dir(slug), 'outputs', 'v2'))).toBe(false);
      const again = await save(slug, { ...body, token: (renewed.json() as { token: string }).token });
      expect(again.statusCode, again.body).toBe(200);
    }
    expect(readFileSync(join(compDir(slug, 2, 'test-wide'), green.path), 'utf8')).toBe(SVG2);
    expect(await versionOf(slug, 3)).toBeUndefined();
  });

  it('409 editor-staged-collision when a staged file has other content than the base\'s file of that name', async () => {
    const slug = await create(['test-wide']);
    await registerLibrary({ 'green.svg': SVG2 });
    const a = await mint(slug);
    const green = await stage(slug, a.token, 'green.svg');
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'logo').src = green.path; }, [{ kind: 'clipMedia', clipId: 'logo', src: green.path }]);
    expect((await save(slug, { ...body, staged: [green.path], token: a.token })).statusCode).toBe(200);
    // v2 has the file; a session on v2 stages the same name and its copy then differs (the base's name, other content).
    const b = await mint(slug, 2);
    const again = await stage(slug, b.token, 'green.svg');
    expect(again.path).toBe(green.path);
    writeFileSync(join(projectDir(), '.studio', 'cache', 'editor-staging', slug, stagingIdOf(b.token), ...green.path.split('/')), SVG3);
    const body2 = await draft(slug, 2, 'test-wide', (c) => { clip(c, 'title').props.text = 'x'; }, [{ kind: 'clipProps', clipId: 'title', props: { text: 'x' } }]);
    const r = await save(slug, { ...body2, staged: [green.path], token: b.token });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().code).toBe('editor-staged-collision');
    expect(await versionOf(slug, 3)).toBeUndefined();
    expect(existsSync(join(store().dir(slug), 'outputs', 'v3'))).toBe(false);
  });

  (ffmpegInfo?.encoders.has('libx264') ? it : it.skip)('a staged video is copied into the version as staged (normalised at staging, the save only copies)', async () => {
    const slug = await create(['test-wide']);
    execFileSync(ffmpegInfo!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', join(projectDir(), 'assets', 'clip.mp4')]);
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', headers: H, payload: { files: ['clip.mp4'] } })).statusCode).toBeLessThan(300);
    const s = await mint(slug);
    const v = await stage(slug, s.token, 'clip.mp4');
    expect(v.kind).toBe('video');
    const body = await draft(slug, 1, 'test-wide', (c) => {
      c.tracks.unshift({ id: 'bgv', kind: 'video', clips: [{ id: 'bgvideo', type: 'video', src: v.path, start: 0, duration: 1, props: { x: 0, y: 0, width: c.width, height: c.height } }] } as never);
    });
    const t0 = Date.now();
    const r = await save(slug, { ...body, staged: [v.path], token: s.token });
    expect(r.statusCode, r.body).toBe(200);
    expect(Date.now() - t0).toBeLessThan(20_000);
    const dir = compDir(slug, 2, 'test-wide');
    expect(sha(join(dir, v.path))).toBe(sha(join(projectDir(), 'assets', 'clip.mp4')));
  }, 60_000);

  it('every src must be a file of the base or staged in the SAME session: not declared, another session\'s, or not staged at all is refused', async () => {
    const slug = await create(['test-wide']);
    const other = await create(['test-wide']);
    await registerLibrary({ 'green.svg': SVG2 });
    const s = await mint(slug);
    const green = await stage(slug, s.token, 'green.svg');
    const elsewhere = await mint(other);
    const otherGreen = await stage(other, elsewhere.token, 'green.svg');
    const versions = (await store().readVersions(slug)).length;
    const attempt = async (o: { staged: string[]; token: string; src: string }) => {
      const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'logo').src = o.src; });
      body.staged = o.staged;
      body.token = o.token;
      return save(slug, body);
    };
    // Not declared as staged; declared but from another creative's session; a path nobody staged.
    for (const o of [{ staged: [], token: s.token, src: green.path }, { staged: [otherGreen.path], token: elsewhere.token, src: otherGreen.path }, { staged: ['assets/lib/nope.svg'], token: s.token, src: 'assets/lib/nope.svg' }]) {
      const r = await attempt(o);
      expect(r.statusCode, JSON.stringify(o)).toBe(422);
      expect(r.json()).toMatchObject({ code: 'editor-invalid', problems: [ed().srcUnavailable({ clip: 'logo', path: o.src })] });
    }
    // A session of another version of the same creative does not lend its staging either.
    await turn(slug, { text: 'again' });
    const s2 = await mint(slug, 2);
    const green2 = await stage(slug, s2.token, 'green.svg');
    const body = await draft(slug, 2, 'test-wide', (c) => { clip(c, 'logo').src = green2.path; });
    const r = await save(slug, { ...body, baseVersion: 2, staged: [green2.path], token: s.token });
    expect(r.statusCode).toBe(422);
    expect((await store().readVersions(slug)).length).toBe(versions + 1);
    expect(existsSync(join(store().dir(slug), 'outputs', `v${versions + 2}`))).toBe(false);
  });

  it('a duration off the brief is the user\'s choice: the version is complete and its format has no problem (decisions log 262)', async () => {
    const slug = await create(['test-wide']);
    // The brief says 4 s; 5.8 s is far off it (the agent's turns would be told to fix it).
    const body = await draft(slug, 1, 'test-wide', (c) => {
      c.duration = 5.8;
      c.scenes[1]!.duration = Math.round((5.8 - c.scenes[1]!.start) * 10) / 10;
    }, [{ kind: 'sceneDuration', sceneId: 'two', duration: 3.3 }]);
    const r = await save(slug, body);
    expect(r.statusCode, r.body).toBe(200);
    const v2 = (await versionOf(slug, 2))!;
    expect(v2).toMatchObject({ status: 'complete', problems: [], origin: 'editor' });
    expect(v2.compositions!.find((c) => c.format === 'test-wide')!.problems).toEqual([]);
    expect((await store().get(slug)).status).toBe('ready');
    // The default ★ is the edited version.
    expect(starOf(await store().readVersions(slug), 'test-wide', undefined, undefined).version).toBe(2);
  });

  describe('a duration chosen in the editor, against the next agent turns (decisions log 270)', () => {
    const lastPrompt = () => (JSON.parse(readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!) as { prompt: string }).prompt;
    const setBrief = async (slug: string, durationSec: number) => {
      const c = await store().get(slug);
      expect((await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...c.brief, durationSec } } })).statusCode).toBe(200);
    };
    const offBrief = (v: VersionEntry | undefined) => (v?.problems ?? []).some((p) => /5\.8/.test(p) || /requested|richiest/.test(p));
    const extend = (slug: string) => draft(slug, 1, 'test-wide', (c) => { c.duration = 5.8; c.scenes[1]!.duration = Math.round((5.8 - c.scenes[1]!.start) * 10) / 10; }, [{ kind: 'sceneDuration', sceneId: 'two', duration: 3.3 }]);

    it('an agent version far from a brief changed since is still flagged (nothing recorded, nothing accepted)', async () => {
      process.env.FAKE_CLAUDE_DURATION = '4';
      const slug = await create(['test-wide']); // brief 4 s, the agent made 4 s
      await setBrief(slug, 6);
      await turn(slug, { text: 'again' }); // the agent keeps 4 s
      expect(lastPrompt()).not.toContain('Keep the current duration');
      const v2 = (await versionOf(slug, 2))!;
      expect(v2.status).toBe('incomplete');
      expect(v2.compositions![0]!.userDuration).toBeUndefined();
    });

    it('an editor version under an unchanged brief: recorded, accepted, kept by the agent and carried', async () => {
      const slug = await create(['test-wide']);
      expect((await save(slug, await extend(slug))).statusCode).toBe(200);
      expect((await versionOf(slug, 2))!.compositions![0]!.userDuration).toEqual({ durationSec: 5.8, briefDurationSec: 4 });
      process.env.FAKE_CLAUDE_DURATION = '5.8';
      await turn(slug, { text: 'louder' });
      expect(lastPrompt()).toContain('Keep the current duration (test-wide: 5.8s) unless the user explicitly asks for another one');
      const v3 = (await versionOf(slug, 3))!;
      expect(v3.status).toBe('complete');
      expect(v3.compositions![0]!.userDuration).toEqual({ durationSec: 5.8, briefDurationSec: 4 });
      // Still held at the next turn (the agent's own version carries the user's choice).
      await turn(slug, { text: 'again' });
      expect((await versionOf(slug, 4))!.status).toBe('complete');
    });

    it('an agent version off the brief, then a text-only editor save: nothing recorded, the next agent turn is still flagged (Q8)', async () => {
      process.env.FAKE_CLAUDE_DURATION = '5.8';
      const slug = await create(['test-wide']); // brief 4 s, the agent made 5.8 s
      expect((await versionOf(slug, 1))!.status).toBe('incomplete');
      const text = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Goodbye'; }, [{ kind: 'clipProps', clipId: 'title', props: { text: 'Goodbye' } }]);
      expect((await save(slug, text)).statusCode, 'save').toBe(200);
      expect((await versionOf(slug, 2))!.compositions![0]!.userDuration).toBeUndefined();
      await turn(slug, { text: 'louder' });
      expect(lastPrompt()).not.toContain('Keep the current duration');
      expect(offBrief((await versionOf(slug, 3))!)).toBe(true);
    });

    it('an editor version, then a brief change: flagged again', async () => {
      const slug = await create(['test-wide']);
      expect((await save(slug, await extend(slug))).statusCode).toBe(200);
      await setBrief(slug, 7);
      process.env.FAKE_CLAUDE_DURATION = '5.8';
      await turn(slug, { text: 'louder' });
      expect(lastPrompt()).not.toContain('Keep the current duration');
      const v3 = (await versionOf(slug, 3))!;
      expect(v3.status).toBe('incomplete');
      expect(offBrief(v3)).toBe(true);
    });
  });

  it('the next agent turn starts from the edited version: work/editor/ is its exact copy, the prompt names it with the summary, the session is resumed (decisions log 263)', async () => {
    const slug = await create(['test-wide', 'test-tall']);
    const v1 = (await versionOf(slug, 1))!;
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Goodbye'; }, [{ kind: 'clipProps', clipId: 'title', props: { text: 'Goodbye' } }]);
    expect((await save(slug, body)).statusCode).toBe(200);
    const v2 = (await versionOf(slug, 2))!;
    const work = join(store().dir(slug), 'work', 'editor');
    const filesOf = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
    // Every own composition of v2 is copied byte for byte (the edited one and the carried one).
    for (const f of ['test-wide', 'test-tall']) {
      const from = compDir(slug, 2, f);
      expect(filesOf(join(work, f))).toEqual(filesOf(from));
      for (const rel of filesOf(from)) expect(readFileSync(join(work, f, rel)).equals(readFileSync(join(from, rel)))).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(work, 'test-wide', 'composition.json'), 'utf8')).tracks.flatMap((t: { clips: Array<{ id: string; props?: { text?: string } }> }) => t.clips).find((k: { id: string }) => k.id === 'title').props.text).toBe('Goodbye');
    // The copy is in the version's commit: a restart from v2 finds it too.
    const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', v2.commit!], { cwd: projectDir(), encoding: 'utf8' });
    expect(tree).toContain(`creatives/${slug}/work/editor/test-wide/composition.json`);
    const runs = agentRuns();
    await turn(slug, { text: 'Make the music louder' });
    expect(agentRuns()).toBe(runs + 1);
    const last = JSON.parse(readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!) as { prompt: string; args: string[] };
    expect(last.prompt).toContain(`v2 contains direct edits by the user: ${v2.request}. Build on v2; keep those edits unless the user asks to change them.`);
    // The folder the turn starts from is named as the current source (the byte-for-byte check above is on that folder).
    expect(last.prompt).toContain(`creatives/${slug}/work/editor/<format-id>/\` is the current source of those formats (test-wide, test-tall)`);
    expect(last.prompt).toContain(`creatives/${slug}/outputs/v2/compositions/<format-id>/`);
    expect(last.prompt).toContain('assets/lib/');
    // Resumed: the session of the agent's last version, now told explicitly what changed.
    expect(last.args).toContain(`--resume=${v1.sessionId}`);
    // v3 is the agent's: the next turn finds no stale copy.
    expect((await versionOf(slug, 3))!.origin).toBeUndefined();
    await turn(slug, { text: 'again' });
    expect(existsSync(work)).toBe(false);
    expect(JSON.parse(readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!).prompt).not.toContain('direct edits by the user');
  });

  it('two editor saves in a row: the prompt lists both summaries, oldest first', async () => {
    const slug = await create(['test-wide']);
    expect((await save(slug, await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'One'; }, [{ kind: 'clipProps', clipId: 'title', props: { text: 'One' } }]))).statusCode).toBe(200);
    expect((await save(slug, await draft(slug, 2, 'test-wide', (c) => { clip(c, 'title').props.color = '#ff0000'; }, [{ kind: 'clipProps', clipId: 'title', props: { color: '#ff0000' } }]))).statusCode).toBe(200);
    const [v2, v3] = [(await versionOf(slug, 2))!, (await versionOf(slug, 3))!];
    await turn(slug, { text: 'x' });
    const prompt = (JSON.parse(readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!) as { prompt: string }).prompt;
    expect(prompt).toContain(`v3 contains direct edits by the user: ${v2.request}; ${v3.request}. Build on v3;`);
  });

  it('a follower that still fits follows the new composition; one that no longer fits is unlinked with a chat warning and keeps its previous version', async () => {
    const slug = await create(['test-wide', 'test-wide-b', 'test-short'], { links: { 'test-wide-b': 'test-wide', 'test-short': 'test-wide' }, durationSec: 5 });
    const v1 = (await versionOf(slug, 1))!;
    expect(v1.compositions!.find((c) => c.format === 'test-short')).toMatchObject({ followsFormat: 'test-wide' });
    const runs = agentRuns();
    // Longer than test-short allows (5.5 s): the last scene grows by 0.8 s.
    const body = await draft(slug, 1, 'test-wide', (c) => {
      c.duration = 5.8;
      c.scenes[1]!.duration = Math.round((5.8 - c.scenes[1]!.start) * 10) / 10;
    }, [{ kind: 'sceneDuration', sceneId: 'two', duration: 3.3 }]);
    const r = await save(slug, body);
    expect(r.statusCode, r.body).toBe(200);
    const v2 = (await versionOf(slug, 2))!;
    const wide = v2.compositions!.find((c) => c.format === 'test-wide')!;
    expect(v2.compositions!.find((c) => c.format === 'test-wide-b')).toEqual({ ...wide, format: 'test-wide-b', followsFormat: 'test-wide' });
    expect(v2.compositions!.find((c) => c.format === 'test-short')).toBeUndefined();
    const m = messages(currentLocale());
    const text = m.jobs.followerNotDelivered({ follower: label('test-short'), primary: label('test-wide'), reason: m.errors.followReason.duration });
    expect(await systemTexts(slug)).toContain(text);
    expect(v2.status).toBe('incomplete');
    expect(v2.problems).toContain(text);
    // Unlinked: from now on it is its own primary, and its latest composition is still v1's.
    const creative = await store().get(slug);
    expect(creative.brief.links?.['test-short']).toBeUndefined();
    expect(creative.brief.links?.['test-wide-b']).toBe('test-wide');
    expect(v1.compositions!.find((c) => c.format === 'test-short')!.hash).toBe(v1.compositions!.find((c) => c.format === 'test-wide')!.hash);
    expect(agentRuns()).toBe(runs);
  });
});

describe('a long editing session', { timeout: 120_000 }, () => {
  it('2000 ops (not compacted) never fail a save, and the summary lists the distinct items with the true "and N more"', async () => {
    const slug = await create(['test-wide']);
    const ops: unknown[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const k = i % 4;
      ops.push(k === 0 ? { kind: 'clipProps', clipId: 'title', props: { x: i } }
        : k === 1 ? { kind: 'clipProps', clipId: 'title', props: { fontSize: 20 + (i % 50) } }
        : k === 2 ? { kind: 'clipProps', clipId: 'title', props: { text: `t${i}` } }
        : { kind: 'clipFlags', clipId: 'title', hidden: i % 8 === 3 });
    }
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 't1998'; }, ops);
    const r = await save(slug, body);
    expect(r.statusCode, r.body).toBe(200);
    const e = messages(currentLocale()).editor;
    const v2 = (await versionOf(slug, 2))!;
    // Four distinct items on one clip: three named, one more.
    expect(v2.request).toBe(e.summary({ items: [e.itemLayout({ name: 'Title' }), e.itemStyle({ name: 'Title' }), e.itemText({ name: 'Title' })].join(', '), more: 1 }));
  });
  it('the body\'s identifiers are bounded: a malformed token, hash, an overlong format or staged path is a plain 400 (final review M4)', async () => {
    const slug = await create(['test-wide']);
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'x'; });
    for (const bad of [{ token: 'short' }, { token: 'A'.repeat(42) + '!' }, { baseHash: 'z'.repeat(64) }, { baseHash: 'a'.repeat(65) }, { format: 'f'.repeat(201) }, { format: '' }, { staged: ['p'.repeat(513)] }]) {
      const r = await save(slug, { ...body, ...bad });
      expect(r.statusCode, JSON.stringify(Object.keys(bad))).toBe(400);
    }
    expect(await versionOf(slug, 2)).toBeFalsy();
    expect((await save(slug, body)).statusCode).toBe(200);
  });

  it('more ops than the bound is a plain 400, never a half-written version', async () => {
    const slug = await create(['test-wide']);
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'x'; }, Array.from({ length: 20_001 }, () => ({ kind: 'clipProps', clipId: 'title', props: { x: 1 } })));
    const r = await save(slug, body);
    expect(r.statusCode).toBe(400);
    expect(await versionOf(slug, 2)).toBeFalsy();
  });
});

describe('links changed between the base and the save', { timeout: 120_000 }, () => {
  it('followers are recomputed from the CURRENT links: an unlinked follower keeps the base composition as its own, a newly linked format follows the edit', async () => {
    PRESETS.push({ id: 'test-wide-c', channel: 'Test', name: 'Wide C', width: 320, height: 180, kind: 'video', extensions: ['mp4'] });
    try {
      expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
      // v1: test-wide-b follows test-wide; test-wide-c is its own primary.
      const slug = await create(['test-wide', 'test-wide-b', 'test-wide-c'], { links: { 'test-wide-b': 'test-wide' } });
      const v1 = (await versionOf(slug, 1))!;
      const wide1 = v1.compositions!.find((c) => c.format === 'test-wide')!;
      expect(v1.compositions!.find((c) => c.format === 'test-wide-b')).toMatchObject({ followsFormat: 'test-wide', hash: wide1.hash });
      expect(v1.compositions!.find((c) => c.format === 'test-wide-c')!.followsFormat).toBeUndefined();
      // The draft is taken now, from v1.
      const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Linked'; }, [{ kind: 'clipProps', clipId: 'title', props: { text: 'Linked' } }]);
      // Then the links change: test-wide-b is unlinked, test-wide-c now follows test-wide.
      const link = (follower: string, primary: string | null) => app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/links`, headers: H, payload: { follower, primary } });
      expect((await link('test-wide-b', null)).statusCode).toBe(200);
      expect((await link('test-wide-c', 'test-wide')).statusCode).toBe(200);
      const runs = agentRuns();
      const r = await save(slug, body);
      expect(r.statusCode, r.body).toBe(200);
      const v2 = (await versionOf(slug, 2))!;
      const wide2 = v2.compositions!.find((c) => c.format === 'test-wide')!;
      expect(wide2.hash).not.toBe(wide1.hash);
      // test-wide-c follows the edited composition (current link).
      expect(v2.compositions!.find((c) => c.format === 'test-wide-c')).toEqual({ ...wide2, format: 'test-wide-c', followsFormat: 'test-wide' });
      // test-wide-b is no longer a follower: it keeps the composition it had (v1's, before the edit) as its own folder.
      const b2 = v2.compositions!.find((c) => c.format === 'test-wide-b')!;
      expect(b2).toEqual({ format: 'test-wide-b', dir: 'compositions/test-wide-b', hash: wide1.hash, problems: [] });
      expect((await readCompositionFolder(compDir(slug, 2, 'test-wide-b'))).hash).toBe(wide1.hash);
      expect(v2.status).toBe('complete');
      expect(agentRuns()).toBe(runs);
    } finally {
      PRESETS.pop();
    }
  });
});

describe('refusals', { timeout: 120_000 }, () => {
  it('409 editor-busy while a turn runs and while a render runs; nothing is written', async () => {
    const slug = await create(['test-wide']);
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Busy'; });
    // A turn that hangs.
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const t = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload: { text: 'go' } });
    expect(t.statusCode).toBe(202);
    const job = t.json() as JobSummary;
    await waitRunning(job.id);
    const runs = agentRuns();
    const r = await save(slug, body);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: ed().busy, code: 'editor-busy' });
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
    await waitJob(job.id);
    expect(agentRuns()).toBe(runs);
    // A render that waits.
    let release!: () => void;
    fake.gate = new Promise((res) => { release = res; });
    const rr = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    const rjob = rr.json() as JobSummary;
    await waitRunning(rjob.id);
    const r2 = await save(slug, body);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe('editor-busy');
    release();
    await waitJob(rjob.id);
    expect((await store().readVersions(slug)).map((v) => v.n)).toEqual([1]);
    expect(existsSync(join(store().dir(slug), 'outputs', 'v2'))).toBe(false);
    // Once both are over, the same draft saves.
    expect((await save(slug, body)).statusCode).toBe(200);
  });

  it('409 editor-base-changed when another version changed the format; a version that changed only another format is no conflict', async () => {
    const slug = await create(['test-wide', 'test-tall']);
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Mine'; });
    // v2 changes only the tall format: the wide draft still saves, on top of v2 (the tall one carried from v2).
    process.env.FAKE_CLAUDE_COMP_TAG = 'tall-changed';
    await turn(slug, { text: 'tall', formats: ['test-tall'] });
    const v2 = (await versionOf(slug, 2))!;
    const ok = await save(slug, body);
    expect(ok.statusCode, ok.body).toBe(200);
    const v3 = (await versionOf(slug, 3))!;
    expect(v3.basedOn).toBe(1);
    expect(v3.compositions!.find((c) => c.format === 'test-tall')).toEqual(v2.compositions!.find((c) => c.format === 'test-tall'));
    // v4 changes the wide format: a draft based on v3 is refused, translated, and nothing is written.
    const stale = await draft(slug, 3, 'test-wide', (c) => { clip(c, 'title').props.text = 'Stale'; });
    process.env.FAKE_CLAUDE_COMP_TAG = 'wide-changed';
    await turn(slug, { text: 'wide', formats: ['test-wide'] });
    const r = await save(slug, stale);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: ed().baseChanged({ format: label('test-wide'), n: 4 }), code: 'editor-base-changed' });
    expect(existsSync(join(store().dir(slug), 'outputs', 'v5'))).toBe(false);
    // A hash that matches nothing, a follower or a format outside the brief: the same refusal.
    for (const b of [{ ...stale, baseHash: 'f'.repeat(64) }, { ...stale, format: 'nope' }, { ...stale, format: '../../x' }]) expect((await save(slug, b)).statusCode).toBe(409);
  });

  it('422 for an invalid composition, with the translated problems, and no outputs/v<n> left behind', async () => {
    const slug = await create(['test-wide']);
    const body = await draft(slug, 1, 'test-wide', (c) => { (c as { fps: number }).fps = 7; clip(c, 'title').start = 99; });
    const r = await save(slug, body);
    expect(r.statusCode).toBe(422);
    const j = r.json() as { error: string; code: string; problems: string[] };
    expect(j.code).toBe('editor-invalid');
    expect(j.problems.length).toBeGreaterThan(0);
    expect(j.error).toBe(ed().saveInvalid({ text: j.problems[0]! }));
    expect(existsSync(join(store().dir(slug), 'outputs', 'v2'))).toBe(false);
    expect((await store().readVersions(slug)).length).toBe(1);
    // Malformed bodies: 400 (an op that is not an edit op never reaches anything).
    for (const bad of [{ ...body, ops: [{ kind: 'nope' }] }, { ...body, ops: ['x'] }, { ...body, extra: 1 }, { ...body, baseVersion: 0 }, { ...body, staged: Array(21).fill('a') }]) {
      expect((await save(slug, bad)).statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });

  it('a crash between the copy and the manifest leaves no version entry, and the next save works', async () => {
    const slug = await create(['test-wide']);
    const body = await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'Crash'; });
    crash.on = true;
    const r = await save(slug, body);
    expect(r.statusCode).toBe(500);
    expect((await store().readVersions(slug)).length).toBe(1);
    expect(existsSync(join(store().dir(slug), 'outputs', 'v2'))).toBe(false);
    crash.on = false;
    const again = await save(slug, body);
    expect(again.statusCode, again.body).toBe(200);
    expect((await versionOf(slug, 2))!.origin).toBe('editor');
  });

  it('a leftover outputs/v<n> of a crashed save is cleared by the next one', async () => {
    const slug = await create(['test-wide']);
    const left = join(store().dir(slug), 'outputs', 'v2', 'compositions', 'test-wide');
    (await import('node:fs')).mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'stray.txt'), 'left by a crash');
    const r = await save(slug, await draft(slug, 1, 'test-wide', (c) => { clip(c, 'title').props.text = 'After'; }));
    expect(r.statusCode, r.body).toBe(200);
    expect(existsSync(join(left, 'stray.txt'))).toBe(false);
  });

  it('the editor may not move a src outside assets/, change an html src, or add an html clip; html layer files stay the base\'s bytes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'composition_layer';
    const slug = await create(['test-wide']);
    const e = ed();
    const cases: Array<[(c: Composition) => void, string]> = [
      [(c) => { clip(c, 'logo').src = 'layers/fx.html'; }, e.srcUnavailable({ clip: 'logo', path: 'layers/fx.html' })],
      [(c) => { clip(c, 'logo').src = 'assets/../../x.svg'; }, e.srcUnavailable({ clip: 'logo', path: 'assets/../../x.svg' })],
      [(c) => { clip(c, 'logo').src = 'assets/missing.svg'; }, e.srcUnavailable({ clip: 'logo', path: 'assets/missing.svg' })],
      [(c) => { c.fonts[0]!.src = 'layers/fx.html'; }, e.fontUnavailable({ family: 'Mono', path: 'layers/fx.html' })],
      [(c) => { clip(c, 'fx').src = 'layers/other.html'; }, e.htmlChanged({ clip: 'fx' })],
      [(c) => { c.tracks[0]!.clips.push({ ...(structuredClone(clip(c, 'fx')) as object), id: 'fx2' } as never); }, e.htmlNew({ clip: 'fx2' })],
      [(c) => { const k = clip(c, 'fx') as unknown as Record<string, unknown>; k.type = 'svg'; k.src = 'assets/logo.svg'; delete k.params; }, e.htmlChanged({ clip: 'fx' })],
    ];
    for (const [change, text] of cases) {
      const r = await save(slug, await draft(slug, 1, 'test-wide', change));
      expect(r.statusCode, text).toBe(422);
      expect(r.json().problems, text).toContain(text);
    }
    expect(existsSync(join(store().dir(slug), 'outputs', 'v2'))).toBe(false);
    // An allowed edit: the layer file is a byte-for-byte, verified copy of the base's.
    const ok = await save(slug, await draft(slug, 1, 'test-wide', (c) => { clip(c, 'fx').props.x = 5; }));
    expect(ok.statusCode, ok.body).toBe(200);
    const a = join(compDir(slug, 1, 'test-wide'), 'layers', 'fx.html');
    const b = join(compDir(slug, 2, 'test-wide'), 'layers', 'fx.html');
    expect(sha(b)).toBe(sha(a));
    expect(lstatSync(b).ino).not.toBe(lstatSync(a).ino);
    // A base whose layer file changed on disk after it was saved is no base for a draft: nothing smuggled in.
    writeFileSync(b, '<!doctype html><p>changed behind our back</p>');
    const r = await save(slug, await draft(slug, 1, 'test-wide', () => {}).then(async (d) => ({ ...d, baseVersion: 2, baseHash: (await versionOf(slug, 2))!.compositions![0]!.hash })));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('editor-carry-failed');
    expect(existsSync(join(store().dir(slug), 'outputs', 'v3'))).toBe(false);
  });
});

describe('one size rule (final review M5)', () => {
  it('the compact JSON of the normalised draft is measured; the file is indented when that fits, else compact', () => {
    const small = { a: [1, 2] };
    expect(compositionFileText(small)).toBe(`${JSON.stringify(small, null, 2)}\n`);
    // About 2 MB compact, 9 MB indented: under the limit as measured, written compact.
    const wide = { a: Array.from({ length: 1_000_000 }, () => 1) };
    expect(draftSizeProblem(wide)).toBeNull();
    expect(compositionFileText(wide)).toBe(JSON.stringify(wide));
    expect(Buffer.byteLength(compositionFileText(wide))).toBeLessThanOrEqual(COMPOSITION_LIMITS.jsonBytes);
    // Over the limit even compact: the problem the editor shows too.
    expect(draftSizeProblem({ s: 'x'.repeat(COMPOSITION_LIMITS.jsonBytes) })).toMatchObject({ key: 'composition.jsonTooLarge' });
    expect(draftJsonBytes({ s: 'é' })).toBe(Buffer.byteLength(JSON.stringify({ s: 'é' })));
  });
});

describe('editorRefusals', () => {
  const html = (params: Record<string, unknown>) => ({ tracks: [{ id: 't', clips: [{ id: 'fx', type: 'html', src: 'layers/fx.html', params }] }], fonts: [] });
  const has = new Set(['assets/a.png', 'assets/lib/b.png']);
  const available = (p: string) => has.has(p);
  it('an html clip\'s image parameter is a file reference: unchanged, or a usable file under assets/', () => {
    const base = html({ pic: { type: 'image', value: 'layers/pic.png' } });
    expect(editorRefusals(html({ pic: { type: 'image', value: 'layers/pic.png' } }), base, available, 'en')).toEqual([]);
    expect(editorRefusals(html({ pic: { type: 'image', value: 'assets/lib/b.png' } }), base, available, 'en')).toEqual([]);
    expect(editorRefusals(html({ pic: { type: 'image', value: 'layers/other.png' } }), base, available, 'en')).toEqual([messages('en').editor.srcUnavailable({ clip: 'fx', path: 'layers/other.png' })]);
    expect(editorRefusals(html({ pic: { type: 'image', value: 'assets/c.png' } }), base, available, 'en')).toEqual([messages('en').editor.srcUnavailable({ clip: 'fx', path: 'assets/c.png' })]);
    // Other parameter types are values, not files.
    expect(editorRefusals(html({ t: { type: 'text', value: '../../etc/passwd' } }), html({}), available, 'en')).toEqual([]);
  });
  it('garbage never throws: what is not a clip or a font is left to the validation', () => {
    for (const g of [null, 1, 'x', [], { tracks: 'x' }, { tracks: [null, { clips: [1, null, { id: 3, type: 'image', src: 5 }] }], fonts: [null, { src: 1 }] }]) {
      expect(() => editorRefusals(g, null, available, 'en')).not.toThrow();
    }
  });
});
