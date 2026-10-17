// @vitest-environment node
/**
 * Output contract v2 (Task 5b) end to end with the fake agent and a fake render engine: a turn delivers compositions
 * (validated, hashed, manifest v2, storyboards), the fix loop on composition problems, the advisory layer checks, phase 9
 * history, carry-over, followers and added formats on composition folders, the agent's `validate_composition` and
 * `preview_frames` (images, rate limit), the live preview session route, the export that renders a missing ★ first, and
 * `starFileMissing` versus `notRendered`. The real frames in Chrome are in previews.chrome.test.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderState, type ApprovalRequest, type CreativeDetail, type FormatPreset, type JobSummary, type ManifestV2, type VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { CompositionFolderError, folderProblem, readCompositionFolder } from '../src/compositions/composition-files.ts';
import { checkComposition, checkTargets, writeNormalized } from '../src/creatives/composition-contract.ts';
import { acceptedDurationsOf } from '../src/creatives/composition-turn.ts';
import { UrlSigner } from '../src/server/signed-urls.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { storyboardDir, storyboardPlan, sweepStoryboardTemps } from '../src/creatives/previews.ts';
import { noteCoreTemp } from '../src/core-temps.ts';
import { Git } from '../src/git.ts';
import { compositionSchemaFile, CONTEXT_MD } from '../src/project-template.ts';
import { frameTime, type RenderFramesOptions, type RenderFramesResult } from '../src/render/frames.ts';
import { PreviewLane, PreviewLaneBusyError } from '../src/render/preview-lane.ts';
import { RenderError } from '../src/render/errors.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../src/render/renderer.ts';
import { buildServer } from '../src/server/app.ts';
import { KeyCheckCache } from '../src/providers/key-check.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'ef'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const UI_ORIGIN = 'http://127.0.0.1:5999';
const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-wide-b', channel: 'Test', name: 'Wide B', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-wide-c', channel: 'Test', name: 'Wide C', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4'] },
  { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png', 'jpg'] },
  // A size limit no render meets (I2: a render with problems).
  { id: 'test-tiny', channel: 'Test', name: 'Tiny', width: 200, height: 200, kind: 'video', extensions: ['mp4'], maxFileMB: 0.00001 },
  { id: 'test-logo', channel: 'Test', name: 'Logo', width: 256, height: 256, kind: 'image', extensions: ['png'], identity: 'logo' },
];

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

interface Fake {
  engine: RenderEngine;
  renders: RenderCompositionOptions[];
  frames: Array<Omit<RenderFramesOptions, 'provider'>>;
  fail: Record<string, string>;
  kind: 'injected' | null;
  /** When set, renders wait for it. */
  gate: Promise<void> | null;
}
function fakeEngine(): Fake {
  const f: Fake = { renders: [], frames: [], fail: {}, kind: 'injected', gate: null, engine: null as unknown as RenderEngine };
  f.engine = {
    info: async () => ({ kind: f.kind }),
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
      if (f.fail[o.format.id]) throw new RenderError('ffmpegFailed', f.fail[o.format.id]!);
      const still = !(o.composition.duration > 0);
      const temp = join(dirname(o.out), `.${basename(o.out)}.render-${randomBytes(6).toString('hex')}.tmp`);
      noteCoreTemp(temp);
      const body = `render of ${o.format.id} ${randomBytes(4).toString('hex')}`;
      await writeFile(temp, body);
      await o.beforeRename?.(temp);
      await rename(temp, o.out);
      return { file: o.out, sha256: createHash('sha256').update(body).digest('hex'), width: o.composition.width, height: o.composition.height,
        durationSec: still ? null : o.composition.duration, frames: 1, encoder: still ? null : 'libx264', audio: false, warnings: [] };
    },
  } as unknown as RenderEngine;
  return f;
}

let base: string;
let app: FastifyInstance;
let fake: Fake;
let ws: string;
let promptFile: string;
let bridge: AgentBridge;

const ENV = ['FAKE_CLAUDE_VECTOR', 'FAKE_CLAUDE_VECTOR_DARK', 'FAKE_CLAUDE_NO_SCENES', 'FAKE_CLAUDE_SYMLINKS', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_COMP_TAG', 'FAKE_CLAUDE_STRAY', 'FAKE_CLAUDE_ALWAYS_INVALID', 'FAKE_CLAUDE_BRIDGE_CALLS', 'FAKE_CLAUDE_BRIDGE_LOG'];

/** The server under test; `extra` adds deps (the final-wave wiring tests). */
async function boot(extra: Partial<Parameters<typeof buildServer>[0]> = {}) {
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    render: fake.engine, uiOrigins: () => [UI_ORIGIN], bridge, mcpCommand: [process.execPath, '-e', ''],
    ...extra,
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-comp-turns-'));
  fake = fakeEngine();
  bridge = new AgentBridge();
  await boot();
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_SCENARIO = 'composition';
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await app?.close();
  rmSync(base, { recursive: true, force: true });
});

const projectDir = () => join(ws, 'acme');
const store = () => new CreativeStore(projectDir());
const prompts = () => (existsSync(promptFile) ? readFileSync(promptFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { prompt: string }) : []);
async function waitJob(id: string): Promise<JobSummary> {
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
async function create(formats: string[], o: { links?: Record<string, string>; durationSec?: number } = {}): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: true, brief: { goal: 'g', message: '', formats, durationSec: o.durationSec ?? 4, assets: [], notes: '', ...(o.links ? { links: o.links } : {}) },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const job = r.json().job as JobSummary;
  const done = await waitJob(job.id);
  expect(done.state, done.error).toBe('succeeded');
  return r.json().slug as string;
}
async function turn(slug: string, payload: object = {}): Promise<JobSummary> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload });
  expect(r.statusCode, r.body).toBe(202);
  const done = await waitJob((r.json() as JobSummary).id);
  expect(done.state, done.error).toBe('succeeded');
  return done;
}
/** Storyboards are made after the turn job, in the preview lane: wait for a file to appear. */
async function waitFile(path: string): Promise<void> {
  for (let i = 0; i < 1500 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(path), path).toBe(true);
}
const versionOf = async (slug: string, n: number): Promise<VersionEntry> => (await store().readVersions(slug)).find((v) => v.n === n)!;
const compDir = (slug: string, n: number, format: string) => join(store().dir(slug), 'outputs', `v${n}`, 'compositions', format);
const detail = async (slug: string) => (await app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
const systemTexts = async (slug: string) => (await store().readConversation(slug)).filter((e) => e.type === 'system').map((e) => (e as { text: string }).text);
async function render(slug: string, n: number, formats?: string[]) {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/${n}/render`, headers: H, payload: formats ? { formats } : {} });
  expect(r.statusCode, r.body).toBe(202);
  return waitJob((r.json() as JobSummary).id);
}

describe('final wave wiring through buildServer', { timeout: 120_000 }, () => {
  it('what the key checks know reaches the creative-turn prompt as "(missing permission: …)" (F5)', async () => {
    await app.close();
    const vault = new MemoryVault();
    await vault.set('elevenlabs', 'el-fake-0123456789');
    const keyChecks = new KeyCheckCache();
    keyChecks.record('elevenlabs', 'tts', 'missing', 'text_to_speech');
    await boot({ vault, keyChecks });
    // The MCP tools are listed only when the bridge has an address (never contacted here: the fake agent makes no call).
    bridge.setOrigin('http://127.0.0.1:1');
    await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
    expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
    await create(['test-wide']);
    const prompt = prompts()[0]!.prompt;
    expect(prompt).toContain('- tts: voice-over with OpenAI or ElevenLabs (missing permission: text_to_speech)');
    expect(prompt).toContain('- sound_effect: sound effects with ElevenLabs (ready)');
  });
  it('the config folder reaches the approve handler: a request for a path inside it is denied without a card (P4)', async () => {
    await app.close();
    const configDir = join(base, 'cfg-under-test');
    mkdirSync(join(configDir, 'run'), { recursive: true });
    writeFileSync(join(configDir, 'run', 'j9-fake.token'), 'fake-token-for-tests\n', { mode: 0o600 });
    await boot({ configDir, appConfig: new AppConfigStore(configDir) });
    const t = bridge.register({ jobId: 'jw', kind: 'creative', projectSlug: 'acme', projectDir: projectDir(), creativeSlug: 'c1', sandboxed: false, autoApproveAtStart: false, emit: () => {}, signal: new AbortController().signal });
    const r = await app.inject({ method: 'POST', url: '/api/bridge/approve', headers: { 'x-motion-studio-bridge': t }, payload: { tool_name: 'Read', input: { file_path: join(configDir, 'run', 'j9-fake.token') } } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ behavior: 'deny' });
    expect(r.json().message).toContain('Motion Studio');
    expect((await app.inject({ url: '/api/approvals', headers: H })).json()).toEqual([]);
  });
});

describe('a composition turn', { timeout: 120_000 }, () => {
  it('delivers a validated, hashed composition per format, the manifest v2 and storyboards; the prompt points to the schema', async () => {
    const slug = await create(['test-wide', 'test-still']);
    const v1 = await versionOf(slug, 1);
    expect(v1).toMatchObject({ n: 1, status: 'complete', problems: [], outputs: [], tools: [], renderCommand: null });
    const wideHash = (await readCompositionFolder(compDir(slug, 1, 'test-wide'))).hash;
    const stillHash = (await readCompositionFolder(compDir(slug, 1, 'test-still'))).hash;
    expect(v1.compositions).toEqual([
      { format: 'test-wide', dir: 'compositions/test-wide', hash: wideHash, problems: [] },
      { format: 'test-still', dir: 'compositions/test-still', hash: stillHash, problems: [] },
    ]);
    const manifest = JSON.parse(readFileSync(join(store().dir(slug), 'outputs', 'v1', 'manifest.json'), 'utf8')) as ManifestV2;
    expect(manifest).toEqual({ schemaVersion: 2, compositions: v1.compositions, renders: [] });
    // The schema and the context, written by the core before the turn.
    expect(readFileSync(join(projectDir(), '.studio', 'composition.schema.json'), 'utf8')).toBe(compositionSchemaFile());
    expect(readFileSync(join(projectDir(), '.studio', 'context.md'), 'utf8')).toBe(CONTEXT_MD);
    const [first] = prompts();
    expect(first!.prompt).toContain('.studio/composition.schema.json');
    expect(first!.prompt).toContain('NEVER render final media');
    expect(first!.prompt).not.toContain('renderCommand');
    // Storyboards: the scene starts and the poster at 1 s, 270 px wide, in the protected cache; a still has one frame.
    const sbDir = storyboardDir(projectDir(), slug, 1, 'test-wide');
    await waitFile(join(sbDir, 'storyboard.json'));
    await waitFile(join(storyboardDir(projectDir(), slug, 1, 'test-still'), 'storyboard.json'));
    const sb = JSON.parse(readFileSync(join(sbDir, 'storyboard.json'), 'utf8'));
    expect(sb).toMatchObject({ schemaVersion: 1, hash: wideHash, width: 270 });
    expect(sb.frames.map((f: { t: number; kind: string; scene?: string }) => [f.t, f.kind, f.scene])).toEqual([[0, 'scene', 'one'], [2, 'scene', 'two'], [1, 'poster', undefined]]);
    for (const f of sb.frames) expect(existsSync(join(sbDir, f.file))).toBe(true);
    const still = JSON.parse(readFileSync(join(storyboardDir(projectDir(), slug, 1, 'test-still'), 'storyboard.json'), 'utf8'));
    expect(still.frames).toHaveLength(1);
    expect(fake.frames.every((x) => x.width === 270 && x.imageFormat === 'jpeg')).toBe(true);
    expect(fake.renders).toEqual([]); // nothing is rendered until asked
    // The storyboard route (token): the index with signed, content-addressed image URLs and their expiry (fix I4).
    const route = await app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/storyboards/test-wide`, headers: H });
    expect(route.statusCode, route.body).toBe(200);
    const body = route.json() as { hash: string; expiresAt: string; frames: Array<{ url: string }> };
    expect(body.hash).toBe(wideHash);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(body.frames[0]!.url).toContain(`/storyboard-files/1/test-wide/${wideHash.slice(0, 16)}/f-0.jpg?s=`);
    expect((await app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/storyboards/test-wide` })).statusCode).toBe(401);
    const img = await app.inject({ url: body.frames[0]!.url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['cross-origin-resource-policy']).toBe('same-origin');
    // Without the signature, with a wrong one, or on another path: refused.
    const bare = body.frames[0]!.url.split('?')[0]!;
    expect((await app.inject({ url: bare })).statusCode).toBe(403);
    expect((await app.inject({ url: `${bare}?s=9999999999999.${'A'.repeat(43)}` })).statusCode).toBe(403);
    expect((await app.inject({ url: body.frames[0]!.url.replace('f-0.jpg', 'f-1.jpg') })).statusCode).toBe(403);
    expect((await app.inject({ url: body.frames[0]!.url.replace('f-0.jpg', 'storyboard.json') })).statusCode).toBe(403);
    // Regenerable: removed, it is made again on request.
    rmSync(sbDir, { recursive: true, force: true });
    expect((await app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/storyboards/test-wide`, headers: H })).statusCode).toBe(200);
    expect(existsSync(join(sbDir, 'storyboard.json'))).toBe(true);
  });

  it('removes what the agent should not write (media, a manifest) and says so', async () => {
    process.env.FAKE_CLAUDE_STRAY = '1';
    const slug = await create(['test-wide']);
    const dir = join(store().dir(slug), 'outputs', 'v1');
    expect(readdirSync(dir).sort()).toEqual(['compositions', 'manifest.json']);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).schemaVersion).toBe(2);
    expect((await systemTexts(slug)).some((x) => x.includes('test-wide.mp4'))).toBe(true);
  });

  it('an invalid composition gets its problems and a fix attempt', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'composition_invalid';
    const slug = await create(['test-wide']);
    const all = prompts();
    expect(all).toHaveLength(2);
    expect(all[1]!.prompt).toContain('do not meet the contract');
    expect(all[1]!.prompt).toMatch(/- compositions\/test-wide: .*fps/);
    expect(await versionOf(slug, 1)).toMatchObject({ status: 'complete', problems: [] });
  });

  it('a logo without its negative "dark" clip gets the problem and a fix attempt (note 9)', async () => {
    process.env.FAKE_CLAUDE_VECTOR = '1';
    process.env.FAKE_CLAUDE_VECTOR_DARK = 'fix';
    const slug = await create(['test-logo']);
    const all = prompts();
    expect(all).toHaveLength(2);
    expect(all[0]!.prompt).toMatch(/"id": "dark"/);
    expect(all[1]!.prompt).toContain('do not meet the contract');
    expect(all[1]!.prompt).toMatch(/- compositions\/test-logo: .*"id": "dark", "hidden": true/);
    expect(await versionOf(slug, 1)).toMatchObject({ status: 'complete', problems: [] });
    expect(existsSync(join(compDir(slug, 1, 'test-logo'), 'assets', 'logo-dark.svg'))).toBe(true);
  });

  it('the repair turn carries the user\'s words verbatim, delimited as theirs, so their constraints reach it (F4)', async () => {
    const slug = await create(['test-wide']);
    process.env.FAKE_CLAUDE_SCENARIO = 'composition_invalid';
    const words = 'Make the title bigger. Do not generate any voice-over.';
    await turn(slug, { text: words });
    const all = prompts();
    const fix = all.at(-1)!.prompt;
    expect(fix).toContain('do not meet the contract');
    expect(fix).toContain(`<user_request>\n${words}\n</user_request>`);
    expect(fix).toContain('Respect every constraint in them');
    expect(fix).toContain("If the user's request did not ask for a new or changed version, reply without creating one and end the turn.");
    // The first attempt of that turn had the request as usual; the brief's own repair (first turn) has no user words.
    expect(all.at(-2)!.prompt).toContain(words);
  });

  it('a composition still invalid after the fix attempts: an incomplete version whose problems the follower shares', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'composition_invalid';
    process.env.FAKE_CLAUDE_ALWAYS_INVALID = '1';
    const slug = await create(['test-wide', 'test-wide-b']);
    expect(prompts()).toHaveLength(3);
    const v1 = await versionOf(slug, 1);
    expect(v1.status).toBe('incomplete');
    const wide = v1.compositions!.find((c) => c.format === 'test-wide')!;
    expect(wide.problems!.length).toBeGreaterThan(0);
    expect(v1.problems).toEqual(wide.problems);
    expect(v1.compositions!.find((c) => c.format === 'test-wide-b')).toEqual({ ...wide, format: 'test-wide-b', followsFormat: 'test-wide' });
    // No storyboard for a composition that does not validate.
    expect(existsSync(storyboardDir(projectDir(), slug, 1, 'test-wide'))).toBe(false);
    expect((await detail(slug)).formats!.find((f) => f.id === 'test-wide')!.starFileMissing).toBe(false);
  });

  it('the static checks of html layers are advisory: a warning in the chat, never a problem', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'composition_layer';
    const slug = await create(['test-wide']);
    expect(prompts()).toHaveLength(1);
    expect(await versionOf(slug, 1)).toMatchObject({ status: 'complete', problems: [] });
    expect((await systemTexts(slug)).some((x) => x.includes('layers/fx.html') && x.includes('fetch'))).toBe(true);
  });
});

describe('phase 9 on composition folders', { timeout: 150_000 }, () => {
  it('the history compares composition hashes; a carried composition is a verified copy of every file', async () => {
    process.env.FAKE_CLAUDE_COMP_TAG = 'same';
    const slug = await create(['test-wide', 'test-tall']);
    const v1 = await versionOf(slug, 1);
    process.env.FAKE_CLAUDE_COMP_TAG = 'changed';
    await turn(slug, { text: 'only the wide one', formats: ['test-wide'] });
    const v2 = await versionOf(slug, 2);
    const tall1 = v1.compositions!.find((c) => c.format === 'test-tall')!;
    expect(v2.compositions!.find((c) => c.format === 'test-tall')).toEqual(tall1);
    expect(v2.compositions!.find((c) => c.format === 'test-wide')!.hash).not.toBe(v1.compositions!.find((c) => c.format === 'test-wide')!.hash);
    // A real copy: same bytes, its own inode, one link.
    const a = lstatSync(join(compDir(slug, 1, 'test-tall'), 'composition.json'));
    const b = lstatSync(join(compDir(slug, 2, 'test-tall'), 'composition.json'));
    expect(b.isFile() && b.nlink === 1 && b.ino !== a.ino).toBe(true);
    expect((await readCompositionFolder(compDir(slug, 2, 'test-tall'))).hash).toBe(tall1.hash);
    // The agent was asked for the wide format only.
    expect(prompts()[1]!.prompt).not.toContain('compositions/test-tall');
    // Regenerating everything with the same content as v2: the wide history does not grow, the tall one does.
    await turn(slug, { text: 'again' });
    const formats = (await detail(slug)).formats!;
    expect(formats.find((f) => f.id === 'test-wide')!.history).toEqual([1, 2]);
    expect(formats.find((f) => f.id === 'test-tall')!.history).toEqual([1, 3]);
  });

  it('a legacy base carries nothing: every primary is a target of the composition turn', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Old', generate: false, brief: { goal: 'g', message: '', formats: ['test-wide', 'test-tall'], durationSec: 4, assets: [], notes: '' } } });
    const slug = r.json().slug as string;
    const legacyOut = (format: string, w: number, h: number) => ({ format, file: `${format}.mp4`, width: w, height: h, durationSec: 4, verified: true, preview: null, sha256: 'b'.repeat(64), problems: [] });
    await store().appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: ['remotion'], renderCommand: 'npx remotion render', basedOn: null,
      outputs: [legacyOut('test-wide', 320, 180), legacyOut('test-tall', 180, 320)] });
    await turn(slug, { text: 'wide only', formats: ['test-wide'] });
    expect(prompts()[0]!.prompt).toContain('compositions/test-tall');
    const v2 = await versionOf(slug, 2);
    expect(v2.compositions!.map((c) => c.format)).toEqual(['test-wide', 'test-tall']);
    expect(v2).toMatchObject({ outputs: [], renderCommand: null, tools: [] });
    // Across the boundary the history counts the composition as new.
    expect((await detail(slug)).formats!.find((f) => f.id === 'test-tall')!.history).toEqual([1, 2]);
  });

  it('a composition changed on disk after its version was saved is not carried: it becomes a target', async () => {
    const slug = await create(['test-wide', 'test-tall']);
    writeFileSync(join(compDir(slug, 1, 'test-tall'), 'extra.txt'), 'x');
    await turn(slug, { text: 'wide', formats: ['test-wide'] });
    expect(prompts()[1]!.prompt).toContain('compositions/test-tall');
  });

  it('a render of an unchanged composition is carried with it (same bytes, still current)', async () => {
    const slug = await create(['test-wide', 'test-tall']);
    expect((await render(slug, 1, ['test-tall'])).state).toBe('succeeded');
    const r1 = (await versionOf(slug, 1)).outputs.find((o) => o.format === 'test-tall')!;
    await turn(slug, { text: 'wide', formats: ['test-wide'] });
    const v2 = await versionOf(slug, 2);
    const r2 = v2.outputs.find((o) => o.format === 'test-tall')!;
    expect(r2).toMatchObject({ file: r1.file, sha256: r1.sha256, fromComposition: r1.fromComposition });
    expect(renderState(v2, 'test-tall')).toBe('rendered');
    expect(statSync(join(store().dir(slug), 'outputs', 'v2', r2.file)).ino).not.toBe(statSync(join(store().dir(slug), 'outputs', 'v1', r1.file)).ino);
    const manifest = JSON.parse(readFileSync(join(store().dir(slug), 'outputs', 'v2', 'manifest.json'), 'utf8')) as ManifestV2;
    expect(manifest.renders.map((r) => r.format)).toEqual(['test-tall']);
    expect(fake.renders).toHaveLength(1);
  });

  it('followers use the primary\'s composition (also for a link added later) and formats are added without the agent', async () => {
    const slug = await create(['test-wide', 'test-wide-b'], { links: {} });
    expect((await versionOf(slug, 1)).compositions!.map((c) => c.followsFormat)).toEqual([undefined, undefined]);
    // Linked after the fact (decisions log 140): the next version's entry follows the primary.
    const link = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/links`, headers: H, payload: { follower: 'test-wide-b', primary: 'test-wide' } });
    expect(link.statusCode, link.body).toBe(200);
    await turn(slug, { text: 'go' });
    const v2 = await versionOf(slug, 2);
    const wide = v2.compositions!.find((c) => c.format === 'test-wide')!;
    expect(v2.compositions!.find((c) => c.format === 'test-wide-b')).toEqual({ format: 'test-wide-b', dir: 'compositions/test-wide', hash: wide.hash, followsFormat: 'test-wide', problems: [] });
    expect(existsSync(compDir(slug, 2, 'test-wide-b'))).toBe(false);
    expect(prompts()[1]!.prompt).not.toContain('compositions/test-wide-b');
    // A format added to the brief that can follow: a version without the agent.
    const c = (await detail(slug)).creative;
    const put = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...c.brief, formats: [...c.brief.formats, 'test-wide-c'] } } });
    expect(put.statusCode, put.body).toBe(200);
    const before = prompts().length;
    await turn(slug, {});
    expect(prompts()).toHaveLength(before);
    const v3 = await versionOf(slug, 3);
    expect(v3.request).toContain('Wide C');
    expect(v3.compositions!.find((x) => x.format === 'test-wide-c')).toMatchObject({ dir: 'compositions/test-wide', hash: wide.hash, followsFormat: 'test-wide' });
    expect(v3.compositions!.find((x) => x.format === 'test-wide')).toEqual(wide);
    // History by composition hash: the primary did not change in v3.
    const formats = (await detail(slug)).formats!;
    expect(formats.find((f) => f.id === 'test-wide')!.history).toEqual([1, 2]);
  });
});

describe('the agent\'s composition tools', { timeout: 120_000 }, () => {
  it('validate_composition checks; preview_frames returns PNG images, at most 540 px wide, 10 calls per turn', async () => {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    bridge.setOrigin(url);
    const log = join(base, 'bridge.jsonl');
    const good = ['preview_frames', { format: 'test-wide', times: [0, 1.5] }];
    process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
    process.env.FAKE_CLAUDE_BRIDGE_CALLS = JSON.stringify([
      ['validate_composition', {}],
      ['validate_composition', { format: 'nope' }],
      ['preview_frames', { format: 'test-wide', times: [0, 1, 2, 3, 4, 5, 6] }],
      ['preview_frames', { format: 'test-tall', times: [0] }],
      ...Array.from({ length: 11 }, () => good),
    ]);
    await create(['test-wide']);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; status: number; body: Record<string, unknown> });
    expect(calls[0]).toMatchObject({ status: 200, body: { problems: [], formats: [{ format: 'test-wide', ok: true }] } });
    expect(calls[1]!.status).toBe(400);
    expect(calls[2]!.status).toBe(400); // more than 6 times: refused, not counted
    expect(calls[3]!.status).toBe(400); // not a format of this turn
    const previews = calls.slice(4);
    expect(previews.slice(0, 10).every((c) => c.status === 200)).toBe(true);
    expect(previews[10]!.status).toBe(429);
    const ok = previews[0]!.body as { ok: boolean; frames: Array<{ t: number; width: number }>; images: Array<{ mimeType: string; data: string }> };
    expect(ok.ok).toBe(true);
    expect(ok.frames).toEqual([{ t: 0, width: 320, height: 180 }, { t: 1.5, width: 320, height: 180 }]);
    expect(ok.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/png']);
    expect(Buffer.from(ok.images[0]!.data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
    const agentFrames = fake.frames.filter((f) => f.imageFormat === 'png');
    expect(agentFrames).toHaveLength(10);
    expect(agentFrames.every((f) => f.width === 320 && f.versionDir === 'outputs/v1')).toBe(true);
  });
});

describe('the agent\'s AskUserQuestion (user note 8)', { timeout: 120_000 }, () => {
  it('waits on a question card; the answer reaches the fake CLI as allow + answers, and the conversation keeps question and answer', async () => {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    bridge.setOrigin(url);
    const log = join(base, 'bridge.jsonl');
    const question = 'Il brief dice circa 30 s, il titolo 12 s: quale durata uso?';
    const input = { questions: [{ question, header: 'Durata', multiSelect: false, options: [{ label: '12 s', description: 'Come nel titolo' }, { label: '30 s', description: 'Come nel brief' }] }] };
    process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
    process.env.FAKE_CLAUDE_BRIDGE_CALLS = JSON.stringify([['approve', { tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_ask1' }]]);
    const created = create(['test-wide']);
    let card: ApprovalRequest | undefined;
    for (let i = 0; i < 1500 && !card; i++) {
      card = ((await app.inject({ url: '/api/approvals', headers: H })).json() as ApprovalRequest[])[0];
      if (!card) await new Promise((r) => setTimeout(r, 20));
    }
    expect(card).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion', questions: input.questions, detail: '' });
    const r = await app.inject({ method: 'POST', url: `/api/approvals/${card!.id}/answer`, headers: H, payload: { answers: [{ selected: [0] }] } });
    expect(r.statusCode, r.body).toBe(200);
    const slug = await created;
    const [call] = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { status: number; body: unknown });
    expect(call).toEqual({ tool: 'approve', status: 200, body: { behavior: 'allow', updatedInput: { ...input, answers: { [question]: '12 s' } } } });
    const events = (await store().readConversation(slug)).flatMap((e) => (e.type === 'agent' ? [e.event] : []));
    expect(events).toContainEqual({ kind: 'question_answered', outcome: 'answered', toolUseId: 'toolu_ask1', items: [{ header: 'Durata', question, answer: '12 s' }] });
    expect(events.some((e) => e.kind === 'approval_decided')).toBe(false);
  });
});

describe('live preview sessions', { timeout: 120_000 }, () => {
  it('need the UI token, a UI origin as parent, and mint a preview session on the composition server', async () => {
    const slug = await create(['test-wide', 'test-wide-b']);
    const url = `/api/projects/acme/creatives/${slug}/versions/1/preview-session`;
    const payload = { format: 'test-wide', parentOrigin: UI_ORIGIN };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload, headers: { ...H, origin: 'https://evil.example' } })).statusCode).toBe(403);
    const foreign = await app.inject({ method: 'POST', url, headers: H, payload: { ...payload, parentOrigin: 'http://localhost:6000' } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe('preview-origin');
    expect((await app.inject({ method: 'POST', url, headers: H, payload: { ...payload, format: 'nope' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url.replace('/1/', '/9/'), headers: H, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, headers: H, payload: { ...payload, extra: 1 } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url, headers: H, payload });
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json() as { url: string; origin: string; format: string; hash: string; width: number };
    const origin = ((await app.inject({ url: '/api/preview/origin', headers: H })).json() as { origin: string }).origin;
    expect(s.origin).toBe(origin);
    expect(s.url.startsWith(`${origin}/`)).toBe(true);
    expect(s.url).toContain(`mode=preview&parentOrigin=${encodeURIComponent(UI_ORIGIN)}`);
    expect(s).toMatchObject({ format: 'test-wide', width: 320, hash: (await versionOf(slug, 1)).compositions![0]!.hash });
    // A follower previews its primary's composition.
    const follower = await app.inject({ method: 'POST', url, headers: H, payload: { ...payload, format: 'test-wide-b' } });
    expect(follower.json()).toMatchObject({ format: 'test-wide', hash: s.hash });
    // A composition changed after its version was saved is not previewed as that version.
    writeFileSync(join(compDir(slug, 1, 'test-wide'), 'extra.txt'), 'x');
    const changed = await app.inject({ method: 'POST', url, headers: H, payload });
    expect(changed.statusCode).toBe(409);
  });

  it('a session can be ended early, only by its own creative and version (Task 8 fix I2)', async () => {
    const slug = await create(['test-wide']);
    const other = await create(['test-wide']);
    const mint = async (c: string) => (await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${c}/versions/1/preview-session`, headers: H,
      payload: { format: 'test-wide', parentOrigin: UI_ORIGIN } })).json() as { url: string; token: string };
    const s = await mint(slug);
    expect(s.url).toContain(`/${s.token}/runtime/`);
    const page = async () => (await fetch(s.url)).status;
    expect(await page()).toBe(200);
    const del = (c: string, n: number | string, token = s.token, headers: Record<string, string> = H) =>
      app.inject({ method: 'DELETE', url: `/api/projects/acme/creatives/${c}/versions/${n}/preview-session/${token}`, headers });
    expect((await del(slug, 1, s.token, {})).statusCode).toBe(401);
    // Another creative, another version, a malformed token: nothing is touched.
    expect((await del(other, 1)).statusCode).toBe(404);
    expect((await del(slug, 2)).statusCode).toBe(404);
    expect((await del(slug, 1, 'short')).statusCode).toBe(404);
    expect(await page()).toBe(200);
    const r = await del(slug, 1);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ revoked: true });
    expect(await page()).toBe(404);
    expect((await del(slug, 1)).statusCode).toBe(404);
  });

  it('reports the live composition server origin when it starts, and null when the app closes (desktop pins its frames to it)', async () => {
    const seen: Array<string | null> = [];
    const other = await buildServer({
      uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config2')), git: new Git(),
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
      render: fake.engine, uiOrigins: () => [UI_ORIGIN], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''],
      onCompositionOrigin: (o) => seen.push(o),
    });
    try {
      expect(seen).toEqual([]);
      const origin = ((await other.inject({ url: '/api/preview/origin', headers: H })).json() as { origin: string }).origin;
      expect(seen).toEqual([origin]);
    } finally {
      await other.close();
    }
    expect(seen.at(-1)).toBeNull();
  });
});

describe('export of v2 versions', { timeout: 120_000 }, () => {
  it('renders a missing ★ render first, then copies; a rendered one is copied as it is', async () => {
    const slug = await create(['test-wide', 'test-still']);
    const prep = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export/prepare`, headers: H, payload: { picks: { 'test-wide': 1 } } });
    expect(prep.statusCode, prep.body).toBe(200);
    const job = (prep.json() as { renders: Array<{ version: number; formats: string[]; job: JobSummary }> }).renders;
    expect(job.map((x) => [x.version, x.formats])).toEqual([[1, ['test-wide']]]);
    await waitJob(job[0]!.job.id);
    const dest = join(base, 'out');
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 1, 'test-still': 1 } } });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { files: Array<{ to: string }>; rendered?: unknown };
    expect(body.rendered).toEqual([{ version: 1, formats: ['test-still'] }]);
    expect(body.files.map((f) => basename(f.to)).sort()).toEqual(['launch-test-still-v1.png', 'launch-test-wide-v1.mp4']);
    expect(fake.renders.map((x) => x.format.id)).toEqual(['test-wide', 'test-still']);
    // Again: everything is rendered, nothing is rendered twice.
    const again = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 1 } } });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as { rendered?: unknown }).rendered).toBeUndefined();
    expect(fake.renders).toHaveLength(2);
  });

  it('a render that fails: 409 export-render-failed, nothing copied', async () => {
    const slug = await create(['test-wide']);
    fake.fail['test-wide'] = 'boom';
    const dest = join(base, 'out2');
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 1 } } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('export-render-failed');
    expect(existsSync(dest)).toBe(false);
  });

  it('starFileMissing is for legacy files; an unrendered v2 ★ is notRendered, and a ★ may be picked on it', async () => {
    const slug = await create(['test-wide']);
    const star = async () => (await detail(slug)).formats!.find((f) => f.id === 'test-wide')!;
    expect(await star()).toMatchObject({ starFileMissing: false, starRender: 'notRendered', exportVersion: 1 });
    await render(slug, 1);
    expect(await star()).toMatchObject({ starFileMissing: false, starRender: 'rendered' });
    const out = (await versionOf(slug, 1)).outputs[0]!;
    rmSync(join(store().dir(slug), 'outputs', 'v1', out.file));
    expect(await star()).toMatchObject({ starFileMissing: false, starRender: 'notRendered' });
    // A later legacy version whose file is gone: missing, as in phase 9.
    await store().appendVersion(slug, { n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: [], renderCommand: null, basedOn: 1,
      outputs: [{ format: 'test-wide', file: 'test-wide.mp4', width: 320, height: 180, durationSec: 4, verified: true, preview: null, sha256: 'a'.repeat(64), problems: [] }] });
    expect(await star()).toMatchObject({ exportVersion: 2, starFileMissing: true, starRender: 'missing' });
    // A ★ pick on the unrendered v2 version is allowed (export renders it).
    const pick = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/export-picks`, headers: H, payload: { format: 'test-wide', version: 1 } });
    expect(pick.statusCode, pick.body).toBe(200);
    expect(await star()).toMatchObject({ exportVersion: 1, starFileMissing: false, starRender: 'notRendered' });
  });
});

describe('units', () => {
  it('the startup sweep removes old storyboard temp folders only', async () => {
    const pdir = mkdtempSync(join(tmpdir(), 'ms-test-sb-sweep-'));
    try {
      const v = join(pdir, '.studio', 'cache', 'storyboards', 'c1', 'v2');
      for (const name of ['test-wide.0123456789ab.tmp', 'test-wide', 'test-wide.tmp', 'test-tall.ffffffffffff.tmp']) mkdirSync(join(v, name), { recursive: true });
      const later = Date.now() + 11 * 60_000;
      expect((await sweepStoryboardTemps(pdir, { now: later })).sort()).toEqual(['c1/v2/test-tall.ffffffffffff.tmp', 'c1/v2/test-wide.0123456789ab.tmp']);
      expect(readdirSync(v).sort()).toEqual(['test-wide', 'test-wide.tmp']);
      mkdirSync(join(v, 'x.0123456789ab.tmp'));
      expect(await sweepStoryboardTemps(pdir)).toEqual([]); // too recent: may be written right now
    } finally {
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it('storyboard plan and frame times', () => {
    expect(storyboardPlan({ duration: 0, fps: 30, scenes: [] })).toEqual([{ t: 0, kind: 'poster' }]);
    expect(storyboardPlan({ duration: 0.5, fps: 30, scenes: [{ id: 'b', start: 0.2, duration: 0.3 }, { id: 'a', start: 0, duration: 0.2 }] }))
      .toEqual([{ t: 0, kind: 'scene', scene: 'a' }, { t: 0.2, kind: 'scene', scene: 'b' }, { t: 0.5, kind: 'poster' }]);
    expect(frameTime({ duration: 2, fps: 30 }, 5)).toBeCloseTo(59 / 30);
    expect(frameTime({ duration: 2, fps: 30 }, 1)).toBe(1);
    expect(frameTime({ duration: 0, fps: 30 }, 3)).toBe(0);
  });

  it('the preview lane is bounded: slots, a short queue, refusal beyond it, aborted waiters leave', async () => {
    const lane = new PreviewLane({ slots: 1, maxWaiting: 1 });
    let release!: () => void;
    const first = lane.run(() => new Promise<string>((r) => { release = () => r('a'); }));
    const ctl = new AbortController();
    const waiting = lane.run(async () => 'b', ctl.signal);
    await expect(lane.run(async () => 'c')).rejects.toBeInstanceOf(PreviewLaneBusyError);
    ctl.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    const third = lane.run(async () => 'd');
    release();
    expect(await first).toBe('a');
    expect(await third).toBe('d');
    expect(lane.load).toEqual({ active: 0, waiting: 0 });
  });

  it('acceptedDurationsOf: only a duration the user chose in the editor, recorded, clean, and only while the brief is unchanged (decisions log 270)', () => {
    const entry = (format: string, o: { problems?: string[]; userDuration?: { durationSec: number; briefDurationSec: number }; followsFormat?: string } = {}) =>
      ({ format, dir: `compositions/${format}`, hash: 'a'.repeat(64), problems: o.problems ?? [], ...(o.userDuration ? { userDuration: o.userDuration } : {}), ...(o.followsFormat ? { followsFormat: o.followsFormat } : {}) });
    const version = (compositions: unknown[], origin?: 'editor') => ({ n: 3, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-13T10:00:00.000Z', request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: 2, compositions, ...(origin ? { origin } : {}) }) as unknown as VersionEntry;
    // An agent version at 10 s, the brief since changed to 6 s: nothing recorded, so nothing accepted (flagged again).
    expect(acceptedDurationsOf(version([entry('test-wide')]), ['test-wide'], PRESETS, 6).size).toBe(0);
    // An editor version that chose 7 s against a 4 s brief: accepted while the brief still says 4 s.
    const edited = version([entry('test-wide', { userDuration: { durationSec: 7, briefDurationSec: 4 } }), entry('test-wide-b', { problems: ['p'], userDuration: { durationSec: 7, briefDurationSec: 4 } }), entry('test-short', { followsFormat: 'test-wide', userDuration: { durationSec: 7, briefDurationSec: 4 } })], 'editor');
    expect([...acceptedDurationsOf(edited, ['test-wide', 'test-wide-b', 'test-short', 'missing'], PRESETS, 4)]).toEqual([['test-wide', 7]]);
    // The brief changed since (to 6 s, or to 7 s itself): the choice no longer holds.
    expect(acceptedDurationsOf(edited, ['test-wide'], PRESETS, 6).size).toBe(0);
    expect(acceptedDurationsOf(edited, ['test-wide'], PRESETS, 7).size).toBe(0);
    expect(acceptedDurationsOf(edited, ['test-wide'], PRESETS, null).size).toBe(0);
    expect(acceptedDurationsOf(undefined, ['test-wide'], PRESETS, 4).size).toBe(0);
  });

  it('an old store composition with an HTML/CSS device frame layer still validates (decision 803)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-comp-'));
    try {
      // The frame layer is a real clip of a visual track, so the check reads and validates it (not an orphan file).
      mkdirSync(join(dir, 'layers'));
      writeFileSync(join(dir, 'layers', 'device-frame.html'), '<!doctype html><html><body><div style="border-radius:40px;border:12px solid #222;width:160px;height:300px"></div></body></html>');
      const frame = { id: 'frame', type: 'html', src: 'layers/device-frame.html', start: 0, duration: 2, props: { x: 0, y: 0, width: 320, height: 180 } };
      writeFileSync(join(dir, 'composition.json'), JSON.stringify({ $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#000000', fonts: [], scenes: [], tracks: [{ id: 'visual', kind: 'visual', clips: [frame] }] }));
      await writeNormalized(dir);
      expect(JSON.parse(readFileSync(join(dir, 'composition.json'), 'utf8')).tracks[0].clips.map((c: { src?: string }) => c.src)).toEqual(['layers/device-frame.html']);
      const r = await checkComposition(dir, 'test-wide', PRESETS[0]!, 2);
      expect(r.problems).toEqual([]);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names equal after NFC are a clear problem; links are refused; the json is normalised after the agent', async () => {
    expect(folderProblem(new CompositionFolderError('ambiguous', 'assets/é.png')).key).toBe('composition.ambiguousNames');
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-comp-'));
    try {
      const preset = PRESETS[0]!;
      writeFileSync(join(dir, 'composition.json'), JSON.stringify({ $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#000000', fonts: [], scenes: [], tracks: [] }));
      await writeNormalized(dir);
      expect(JSON.parse(readFileSync(join(dir, 'composition.json'), 'utf8')).scenes).toEqual([{ id: 'scene-1', start: 0, duration: 2 }]);
      expect((await checkComposition(dir, 'test-wide', preset, 2)).ok).toBe(true);
      // Far from the brief's duration: a problem (the phase 8 rule).
      expect((await checkComposition(dir, 'test-wide', preset, 10)).problems.map((p) => p.key)).toEqual(['composition.durationOffBrief']);
      // A duration the base accepted (a direct edit's) is not off the brief while it is kept; another one is (decisions log 262).
      expect((await checkComposition(dir, 'test-wide', preset, 10, 2)).ok).toBe(true);
      expect((await checkComposition(dir, 'test-wide', preset, 10, 3)).problems.map((p) => p.key)).toEqual(['composition.durationOffBrief']);
      // No brief duration (a direct save): never checked.
      expect((await checkComposition(dir, 'test-wide', preset, null)).ok).toBe(true);
      mkdirSync(join(dir, 'layers'));
      writeFileSync(join(dir, 'layers', 'x.html'), '<script>new Worker("w.js")</script>');
      const warned = await checkComposition(dir, 'test-wide', preset, 2);
      expect(warned.ok).toBe(true);
      expect(warned.warnings.map((w) => w.key)).toContain('composition.layerWorker');
      symlinkSync('/etc/hosts', join(dir, 'assets-link'));
      const linked = await checkComposition(dir, 'test-wide', preset, 2);
      expect(linked).toMatchObject({ ok: false, hash: null });
      expect(linked.problems.map((p) => p.key)).toEqual(['composition.folderUnreadable']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review fixes (Task 5b)', { timeout: 150_000 }, () => {
  it('I1: pin frames go to the protected cache through real folders and a fresh temp, never through a planted link', async () => {
    const slug = await create(['test-wide']);
    const pins = [{ format: 'test-wide', x: 0.5, y: 0.5, timeSec: 1 }];
    const cache = join(projectDir(), '.studio', 'cache', 'pin-frames', slug);
    // v2: a normal pinned turn.
    await turn(slug, { text: 'bigger', pins });
    const frame = join(cache, 'v2', '2-1.jpg');
    expect(lstatSync(frame).isFile()).toBe(true);
    expect(prompts()[1]!.prompt).toContain(`.studio/cache/pin-frames/${slug}/v2/2-1.jpg`);
    expect(existsSync(join(store().dir(slug), 'work', '.feedback'))).toBe(false);
    // v3: its folder is a link to another folder: nothing is written there, no attachment.
    const outside = mkdtempSync(join(tmpdir(), 'ms-test-outside-'));
    try {
      symlinkSync(outside, join(cache, 'v3'));
      await turn(slug, { text: 'again', pins });
      expect(readdirSync(outside)).toEqual([]);
      expect(prompts()[2]!.prompt).not.toContain('pin-frames');
      // v4: a link planted at the file's own name is replaced as an entry; its target is untouched.
      mkdirSync(join(cache, 'v4'));
      writeFileSync(join(outside, 'victim.txt'), 'keep');
      symlinkSync(join(outside, 'victim.txt'), join(cache, 'v4', '4-1.jpg'));
      await turn(slug, { text: 'once more', pins });
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep');
      expect(lstatSync(join(cache, 'v4', '4-1.jpg')).isFile()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('T10: a range ending at the duration of a composition never rendered gets its end frame, grabbed at the last frame', async () => {
    const slug = await create(['test-wide']);
    const c = JSON.parse(readFileSync(join(store().dir(slug), 'outputs', 'v1', 'compositions', 'test-wide', 'composition.json'), 'utf8')) as { duration: number; fps: 24 | 25 | 30 | 50 | 60 };
    expect(renderState((await store().readVersions(slug))[0]!, 'test-wide')).not.toBe('rendered');
    const before = fake.frames.length;
    await turn(slug, { text: 'end', pins: [{ format: 'test-wide', x: 0.5, y: 0.5, timeSec: 1, range: { start: 1, end: c.duration } }] });
    // The pin frames are single-time grabs (a storyboard asks for several times at once, and may land meanwhile).
    const asked = fake.frames.slice(before).filter((o) => o.imageFormat === 'jpeg' && o.times.length === 1).map((o) => o.times[0]!);
    expect(asked[0]).toBe(frameTime(c, 1));
    // The end: the last frame, never the duration itself.
    expect(asked[1]).toBeCloseTo(c.duration - 1 / c.fps, 6);
    const cache = join(projectDir(), '.studio', 'cache', 'pin-frames', slug, 'v2');
    expect(readdirSync(cache).filter((f) => f.endsWith('.jpg')).sort()).toEqual(['2-1.jpg', '2-1e.jpg']);
  });

  it('I2: an export waits for a render job of other formats, then renders its own', async () => {
    const slug = await create(['test-wide', 'test-still']);
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const reel = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: ['test-wide'] } });
    expect(reel.statusCode).toBe(202);
    const prep = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export/prepare`, headers: H, payload: { picks: { 'test-still': 1 } } });
    // A follow-up job for the still is queued behind the running one (I3): it covers the export's formats.
    const prepared = (prep.json() as { renders: Array<{ covers: boolean; job: { formats?: string[]; state: string } }> }).renders[0]!;
    expect(prepared.covers).toBe(true);
    expect(prepared.job).toMatchObject({ formats: ['test-still'], state: 'queued' });
    const exp = app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: join(base, 'out'), picks: { 'test-still': 1 } } });
    await new Promise((r) => setTimeout(r, 300));
    release();
    fake.gate = null;
    const r = await exp;
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.renders.map((x) => x.format.id)).toEqual(['test-wide', 'test-still']);
    expect((r.json() as { files: Array<{ to: string }> }).files.map((f) => basename(f.to))).toEqual(['launch-test-still-v1.png']);
  });

  it('I2: an export does not copy a render it just made that has problems; once the user ticks it again, it is copied', async () => {
    const slug = await create(['test-wide', 'test-tiny']);
    const picks = { 'test-wide': 1, 'test-tiny': 1 };
    const first = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: join(base, 'out1'), picks } });
    expect(first.statusCode, first.body).toBe(200);
    const r1 = first.json() as { files: Array<{ to: string }>; skipped: string[]; excluded: Array<{ format: string; version: number; problems: string[]; issues: Array<{ code: string }> }> };
    expect(r1.files.map((f) => basename(f.to))).toEqual(['launch-test-wide-v1.mp4']);
    // Stated apart, with its problems and their codes (P2): never a silent exclusion, never mixed with missing files.
    expect(r1.skipped).toEqual([]);
    expect(r1.excluded).toEqual([{ format: 'test-tiny', version: 1, problems: [expect.any(String)], issues: [{ code: 'tooLarge', params: { size: expect.any(Number), max: 0.00001 } }] }]);
    // The render with problems is now on record: a second export (the row ticked again) copies it.
    const again = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: join(base, 'out2'), picks: { 'test-tiny': 1 } } });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as { files: Array<{ to: string }> }).files.map((f) => basename(f.to))).toEqual(['launch-test-tiny-v1.mp4']);
    // Only the problem render, made now: nothing exported, a localized 409 naming the problem.
    const slug2 = await create(['test-tiny']);
    const only = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug2}/export`, headers: H, payload: { destination: join(base, 'out3'), picks: { 'test-tiny': 1 } } });
    expect(only.statusCode).toBe(409);
    expect(only.json()).toMatchObject({ code: 'export-render-problems' });
  });

  it('I3: a composition turn never shows the agent a render command, even from a legacy base', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Old', generate: false, brief: { goal: 'g', message: '', formats: ['test-wide'], durationSec: 4, assets: [], notes: '' } } });
    const slug = r.json().slug as string;
    await store().appendVersion(slug, { n: 1, commit: null, sessionId: 's1', status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: ['remotion'],
      renderCommand: 'npx remotion render Main outputs/v1/test-wide.mp4', basedOn: null,
      outputs: [{ format: 'test-wide', file: 'test-wide.mp4', width: 320, height: 180, durationSec: 4, verified: true, preview: null, sha256: 'b'.repeat(64), problems: [] }] });
    const c = (await detail(slug)).creative;
    await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...c.brief, formats: ['test-wide', 'test-tall'] } } });
    await turn(slug, {});
    const p = prompts()[0]!.prompt;
    const request = p.slice(p.indexOf('## Request\n') + 11, p.indexOf('\n\n', p.indexOf('## Request\n')));
    expect(request).toContain('test-tall');
    expect(request).not.toMatch(/render|remotion|npx|renderCommand/i);
    expect((await versionOf(slug, 2)).request).not.toMatch(/render|remotion/i);
  });

  it('stray removal never follows links the agent planted', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ms-test-outside-'));
    try {
      writeFileSync(join(outside, 'keep.txt'), 'keep');
      process.env.FAKE_CLAUDE_SYMLINKS = JSON.stringify([['x', outside], ['compositions/test-tall', outside]]);
      const slug = await create(['test-wide']);
      expect(readdirSync(outside)).toEqual(['keep.txt']);
      expect(readdirSync(join(store().dir(slug), 'outputs', 'v1')).sort()).toEqual(['compositions', 'manifest.json']);
      expect(readdirSync(join(store().dir(slug), 'outputs', 'v1', 'compositions'))).toEqual(['test-wide']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the agent\'s original is kept before normalising, and validate_composition reports the final hash', async () => {
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    bridge.setOrigin(url);
    const log = join(base, 'bridge.jsonl');
    process.env.FAKE_CLAUDE_NO_SCENES = '1';
    process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
    process.env.FAKE_CLAUDE_BRIDGE_CALLS = JSON.stringify([['validate_composition', { format: 'test-wide' }]]);
    const slug = await create(['test-wide']);
    const v1 = await versionOf(slug, 1);
    const call = JSON.parse(readFileSync(log, 'utf8').trim()) as { body: { formats: Array<{ hash: string }> } };
    expect(call.body.formats[0]!.hash).toBe(v1.compositions![0]!.hash);
    const original = JSON.parse(readFileSync(join(projectDir(), '.studio', 'cache', 'agent-originals', slug, 'v1', 'test-wide.json'), 'utf8'));
    expect(original.scenes).toEqual([]);
    expect(JSON.parse(readFileSync(join(compDir(slug, 1, 'test-wide'), 'composition.json'), 'utf8')).scenes).toHaveLength(1);
  });

  it('a linked target composition folder is refused without following it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-test-linked-'));
    try {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'composition.json'), '{"secret": true}');
      const versionDir = join(root, 'creative', 'outputs', 'v1');
      mkdirSync(join(versionDir, 'compositions'), { recursive: true });
      symlinkSync(outside, join(versionDir, 'compositions', 'test-wide'));
      const r = await checkTargets({ versionDir, targets: ['test-wide'], presets: PRESETS, briefDurationSec: null, locale: 'en' });
      expect(r.checks).toEqual([]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toContain('cannot be read safely');
      expect(r.problems[0]).not.toContain('outside');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('signed URLs: bound to the path, refused once expired, compared in constant time', () => {
    let now = 1_000;
    const s = new UrlSigner(500, () => now);
    const { url, expiresAt } = s.sign('/a/b/f-0.jpg');
    const token = new URLSearchParams(url.split('?')[1]).get('s');
    expect(expiresAt).toBe(1_500);
    expect(s.verify('/a/b/f-0.jpg', token)).toBe(true);
    expect(s.verify('/a/b/f-1.jpg', token)).toBe(false);
    expect(s.verify('/a/b/f-0.jpg', undefined)).toBe(false);
    expect(new UrlSigner(500, () => now).verify('/a/b/f-0.jpg', token)).toBe(false); // another process key
    now = 1_500;
    expect(s.verify('/a/b/f-0.jpg', token)).toBe(false);
  });

  it('creative files are same-origin resources too (CORP)', async () => {
    const slug = await create(['test-wide']);
    const r = await app.inject({ url: `/api/projects/acme/creatives/${slug}/files/outputs/v1/manifest.json` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
