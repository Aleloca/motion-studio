// @vitest-environment node
/**
 * Decision 790: a workspace or project folder whose path (or real path) holds a glob metacharacter (`GLOB_PATH_CHARS`).
 * With Claude Code 2.1.300 such a path stops the protected-file deny rules from matching (decisions 780/781). Creating such
 * a workspace or project is refused at the route; for one that already exists, every agent run is refused before launch with
 * the same message (chat line, job error, console line), while browsing, rendering and exporting keep working.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import type { JobSummary, StorePack } from '@motion-studio/shared';
import type { AgentRunner } from '../src/agent/runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { t } from '../src/i18n.ts';
import { buildServer } from '../src/server/app.ts';
import { assertAgentFolders, folderWithGlobChars, pathHasGlobChars } from '../src/workspace-store.ts';
import { H, PRESETS, TOKEN, UI_ORIGIN, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const GLOB_NAME = 'p (x) [y]';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const message = (path: string) => t().errors.folderGlobChars({ path });

describe('folderWithGlobChars / assertAgentFolders', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-glob-unit-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('finds the plain path, the real path of a clean link, and the real path of a folder not made yet under a link', async () => {
    const bad = join(base, GLOB_NAME);
    mkdirSync(bad);
    symlinkSync(bad, join(base, 'clean-link'));
    const real = await realpath(bad);
    expect(await folderWithGlobChars([bad])).toBe(bad);
    expect(await folderWithGlobChars([join(base, 'clean-link')])).toBe(real);
    expect(await folderWithGlobChars([join(base, 'clean-link', 'not-yet', 'ws')])).toBe(join(real, 'not-yet', 'ws'));
    expect(await folderWithGlobChars([join(base, 'plain'), join(base, 'other')])).toBeNull();
    for (const c of ['(', ')', '[', ']', '{', '}', '*', '?', '\\']) expect(await folderWithGlobChars([join(base, `a${c}b`)])).not.toBeNull();
    await expect(assertAgentFolders(join(base, 'clean-link', 'acme'))).rejects.toMatchObject({ apiCode: 'folder-glob-chars', status: 400, message: message(real) });
    await expect(assertAgentFolders(join(base, 'plain', 'acme'))).resolves.toBeUndefined();
  });
});

describe('pathHasGlobChars per platform (decision 791)', () => {
  it('POSIX: the whole set, backslash included', () => {
    expect(pathHasGlobChars('/Users/a/proj', posix)).toBe(false);
    for (const c of ['(', ')', '[', ']', '{', '}', '*', '?', '\\']) expect(pathHasGlobChars(`/Users/a/p${c}q`, posix), c).toBe(true);
  });
  it('Windows (path.win32): separators, the drive colon and the UNC and device prefixes are syntax; names are checked', () => {
    const clean = ['C:\\Users\\a\\proj', 'C:/Users/a/proj', 'D:\\', '\\\\server\\share\\proj', '\\\\server\\share\\a\\b', '\\\\?\\C:\\Users\\a\\proj', '\\\\.\\C:\\x', '\\\\?\\UNC\\server\\share\\proj'];
    for (const p of clean) expect(pathHasGlobChars(p, win32), p).toBe(false);
    const bad = ['C:\\Users\\a\\p (x) [y]', 'C:\\Users\\a\\p[1]', 'C:/x/{z}', 'C:\\a*b', 'C:\\what?\\x', '\\\\server\\share\\p[1]', '\\\\server\\sh[a]re\\x', '\\\\?\\UNC\\server\\share\\a (b)', '\\\\?\\C:\\p [y]'];
    for (const p of bad) expect(pathHasGlobChars(p, win32), p).toBe(true);
  });
});

describe('creating a workspace or project with glob characters (route refusals)', { timeout: 60_000 }, () => {
  let base: string;
  let app: FastifyInstance;
  let config: AppConfigStore;
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'ms-glob-routes-'));
    config = new AppConfigStore(join(base, 'config'));
    app = await buildServer({ uiToken: TOKEN, configDir: join(base, 'config'), sandbox: async () => ({ available: false, reason: 'test' }), appConfig: config, git: new Git(), doctor: async () => [], runner: { start: () => { throw new Error('no agent in this suite'); } } });
  });
  afterEach(async () => { await app.close(); rmSync(base, { recursive: true, force: true }); });
  const select = (path: string) => app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path } });

  it('PUT /api/workspace refuses a glob path (existing or not), a clean link to one and a new folder under such a link; nothing is created or saved', async () => {
    const bad = join(base, GLOB_NAME);
    const missing = join(base, 'q {z}');
    mkdirSync(bad);
    symlinkSync(bad, join(base, 'clean-link'));
    const real = await realpath(bad);
    const cases: Array<[string, string]> = [
      [bad, bad], [missing, missing], [join(base, 'clean-link'), real], [join(base, 'clean-link', 'new-ws'), join(real, 'new-ws')],
    ];
    for (const [path, named] of cases) {
      const r = await select(path);
      expect(r.statusCode, path).toBe(400);
      expect(r.json(), path).toMatchObject({ code: 'folder-glob-chars', error: message(named) });
      expect(r.json().error).toContain(named);
    }
    expect(existsSync(join(bad, '.studio'))).toBe(false);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(real, 'new-ws'))).toBe(false);
    expect((await config.read()).workspacePath).toBeNull();
    // A clean path is accepted as before.
    expect((await select(join(base, 'ws'))).statusCode).toBe(200);
  });

  it('the message names the path and suggests a rename, in English and Italian, never a symbolic link', async () => {
    const { messages } = await import('@motion-studio/shared');
    for (const loc of ['en', 'it'] as const) {
      const text = messages(loc).errors.folderGlobChars({ path: '/a/p (x) [y]' });
      expect(text).toContain('/a/p (x) [y]');
      expect(text).toMatch(loc === 'en' ? /rename the folder/ : /rinomina la cartella/);
      expect(text).not.toMatch(/link|collegamento/i);
    }
  });
});

/**
 * A project made in a clean workspace (a generated version, a website brand source, an asset to describe), then the workspace
 * folder moved to `p (x) [y]` (or reached through a clean-named link to it) and the server restarted on it: a workspace that
 * existed before decision 790.
 */
describe('an existing workspace with glob characters: agent runs refused before launch, browsing and export work', { timeout: 180_000 }, () => {
  let env: InstanceEnv;
  let app: FastifyInstance | null = null;
  let starts = 0;
  let slug = '';
  beforeEach(async () => {
    starts = 0;
    env = await startInstanceEnv('ms-glob-existing-');
    // The identity presets must be in the catalog: creation refuses formats it does not hold (decision 1445).
    expect((await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [...PRESETS, ...DEFAULT_FORMATS] } })).statusCode).toBe(200);
    slug = await env.create(['test-wide'], { locales: { primary: 'en', extra: ['de'] } });
    await env.render(slug, 1);
    expect((await env.app.inject({ method: 'POST', url: '/api/projects/acme/brand/sources', headers: H, payload: { kind: 'website', url: 'https://example.com' } })).statusCode).toBe(201);
    writeFileSync(join(env.projectDir(), 'assets', 'logo.svg'), SVG);
    expect((await env.app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', headers: H, payload: { files: ['logo.svg'] } })).statusCode).toBe(200);
    await env.app.close();
  });
  afterEach(async () => { await app?.close(); app = null; await env.close(); });

  /** Moves the workspace to the glob-named folder and restarts the server on `configured` (that folder or a clean link to it). */
  async function restart(viaLink: boolean): Promise<{ root: string; named: string }> {
    const moved = join(env.base, GLOB_NAME);
    renameSync(env.ws, moved);
    let root = moved;
    if (viaLink) { root = join(env.base, 'clean-link'); symlinkSync(moved, root); }
    const config = new AppConfigStore(join(env.base, 'config'));
    await config.setWorkspacePath(root);
    const counting: AgentRunner = { start: () => { starts++; return { done: Promise.resolve({ status: 'failed' as const, error: 'should not run' }), cancel: () => {} }; } };
    app = await buildServer({
      uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: config, git: new Git(), runner: counting,
      doctor: async () => [], render: env.fake.engine, uiOrigins: () => [UI_ORIGIN], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''],
    });
    return { root, named: viaLink ? await realpath(moved) : moved };
  }
  const waitJob = async (id: string): Promise<JobSummary> => {
    let j: JobSummary | undefined;
    for (let i = 0; i < 1500; i++) {
      j = ((await app!.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
      if (j && j.state !== 'queued' && j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for the job: ${JSON.stringify(j)}`);
  };
  const failsWith = async (r: { statusCode: number; body: string; json: () => unknown }, text: string, job = (r.json() as JobSummary).id) => {
    expect(r.statusCode, r.body).toBeLessThan(300);
    const done = await waitJob(job);
    expect(done.state).toBe('failed');
    expect(done.error).toBe(text);
  };
  const lastChatError = async (root: string, c: string) => {
    const conv = await new CreativeStore(join(root, 'acme')).readConversation(c);
    const errors = conv.filter((e) => e.type === 'system' && e.level === 'error');
    return (errors.at(-1) as { text: string } | undefined)?.text;
  };

  for (const viaLink of [false, true]) {
    it(`${viaLink ? 'through a clean-named link: ' : ''}every agent entry point fails before launch with the same message`, async () => {
      const { root, named } = await restart(viaLink);
      const text = message(named);
      const P = '/api/projects/acme';
      // Project console (the console's error line).
      await failsWith(await app!.inject({ method: 'POST', url: `${P}/turns`, headers: H, payload: { prompt: 'hello' } }), text);
      // Creative turn (chat line).
      await failsWith(await app!.inject({ method: 'POST', url: `${P}/creatives/${slug}/turns`, headers: H, payload: { text: 'bigger title', pins: [] } }), text);
      expect(await lastChatError(root, slug)).toBe(t().jobs.generationFailed({ text }));
      // Localize (chat line).
      const loc = await app!.inject({ method: 'POST', url: `${P}/creatives/${slug}/versions/1/localize`, headers: H, payload: { locales: ['de'] } });
      await failsWith(loc, text, loc.json().jobId);
      expect(await lastChatError(root, slug)).toBe(t().jobs.generationFailed({ text }));
      // Brand analysis and asset description (job errors).
      await failsWith(await app!.inject({ method: 'POST', url: `${P}/brand/analyze`, headers: H, payload: {} }), text);
      await failsWith(await app!.inject({ method: 'POST', url: `${P}/assets/describe`, headers: H, payload: { files: ['logo.svg'] } }), text);
      // A new creative that generates at once, a store pack and an identity creative (the same creative turn).
      const fresh = await app!.inject({ method: 'POST', url: `${P}/creatives`, headers: H, payload: { title: 'Again', generate: true, brief: { goal: 'g', message: '', formats: ['test-wide'], durationSec: 4, assets: [], notes: '' } } });
      expect(fresh.statusCode, fresh.body).toBe(201);
      await failsWith(fresh, text, fresh.json().job.id);
      const pack: StorePack = { app: { name: 'Tasky', tagline: 'Plan' }, stores: ['playstore'], devices: { appstore: [], playstore: ['phone'] }, screenshots: [{ caption: 'All your tasks', screen: null }, { caption: 'Share with your team', screen: null }], preview: false };
      const sp = await app!.inject({ method: 'POST', url: `${P}/creatives/store-pack`, headers: H, payload: { title: 'Pack', storePack: pack, generate: true } });
      expect(sp.statusCode, sp.body).toBe(201);
      await failsWith(sp, text, sp.json().job.id);
      expect(await lastChatError(root, sp.json().slug)).toBe(t().jobs.generationFailed({ text }));
      const id = await app!.inject({ method: 'POST', url: `${P}/creatives`, headers: H, payload: { title: 'Logo', generate: true, brief: { goal: 'g', message: '', formats: ['identity-logo'], durationSec: 4, assets: [], notes: '', identity: { start: 'scratch', name: 'Acme', concepts: 1 } } } });
      expect(id.statusCode, id.body).toBe(201);
      await failsWith(id, text, id.json().job.id);
      // Nothing was launched.
      expect(starts).toBe(0);
      // Creating a project in this workspace is refused at the route.
      const created = await app!.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Second' } });
      expect(created.statusCode).toBe(400);
      expect(created.json()).toMatchObject({ code: 'folder-glob-chars', error: text });
      expect(existsSync(join(root, 'second'))).toBe(false);
    });
  }

  it('browsing, rendering and exporting still work', async () => {
    const { root } = await restart(false);
    const P = '/api/projects/acme';
    expect((await app!.inject({ url: '/api/workspace', headers: H })).json()).toMatchObject({ path: root, error: null });
    expect((await app!.inject({ url: '/api/projects', headers: H })).json()).toEqual([expect.objectContaining({ slug: 'acme', ok: true })]);
    expect((await app!.inject({ url: P, headers: H })).statusCode).toBe(200);
    expect((await app!.inject({ url: `${P}/creatives/${slug}`, headers: H })).statusCode).toBe(200);
    expect((await app!.inject({ url: `${P}/assets`, headers: H })).statusCode).toBe(200);
    expect((await app!.inject({ url: `${P}/files/assets/logo.svg`, headers: H })).statusCode).toBe(200);
    const render = await app!.inject({ method: 'POST', url: `${P}/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(render.statusCode, render.body).toBe(202);
    const rendered = await waitJob(render.json().id);
    expect(rendered.state, rendered.error).toBe('succeeded');
    const dest = join(env.base, 'out');
    mkdirSync(dest);
    const exp = await app!.inject({ method: 'POST', url: `${P}/creatives/${slug}/versions/1/export`, headers: H, payload: { destination: dest } });
    expect(exp.statusCode, exp.body).toBe(200);
    const files = (exp.json() as { files: Array<{ from: string; to: string }> }).files;
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(files[0]!.to, 'utf8')).toMatch(/^render of test-wide/);
    expect(starts).toBe(0);
  });
});

