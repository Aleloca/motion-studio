// @vitest-environment node
/**
 * SVG inner editor, Task 2: the editor stages an SVG edited in the browser (`POST …/editor/stage` with `kind: 'svgEdit'`).
 * The core checks it with `checkVectorSvg` and stores it under a content-addressed name in the session's staging, so the
 * existing save accepts it like a staged library file. Refusals: a script, an external link, over 512 KB, a base that is
 * not an SVG of the composition, a discarded variant (phase 15).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Composition, EditorCompositionView, FormatPreset, JobSummary, VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { stagingIdOf } from '../src/creatives/editor-staging.ts';
import { directEditBodySchema } from '../src/creatives/direct-edit.ts';
import { EDITOR_SAVE_STAGED_MAX } from '@motion-studio/shared';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'df'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const UI_ORIGIN = 'http://127.0.0.1:5995';
const ICON: FormatPreset = { id: 'test-favicon', channel: 'Test', name: 'Favicon', width: 64, height: 64, kind: 'image', extensions: ['png'], identity: 'favicon' };
const PRESETS: FormatPreset[] = [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] }, ICON];
const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#ff5a1f"/></svg>';
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

let base: string;
let app: FastifyInstance;
let v: VariantApp | undefined;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-svg-edit-'));
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    uiOrigins: () => [UI_ORIGIN], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''],
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
  process.env.FAKE_CLAUDE_SCENARIO = 'composition';
  process.env.FAKE_CLAUDE_IMAGE = '1';
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.FAKE_CLAUDE_IMAGE;
  await app?.close();
  await v?.close();
  v = undefined;
  rmSync(base, { recursive: true, force: true });
});

const projectDir = () => join(base, 'ws', 'acme');
const store = () => new CreativeStore(projectDir());
const compDir = (slug: string, n: number, format: string) => join(store().dir(slug), 'outputs', `v${n}`, 'compositions', format);
const versionOf = async (slug: string, n: number): Promise<VersionEntry | undefined> => (await store().readVersions(slug)).find((x) => x.n === n);
const stagingDir = (slug: string, token: string) => join(projectDir(), '.studio', 'cache', 'editor-staging', slug, stagingIdOf(token), 'assets', 'lib');
const stagedFiles = (slug: string, token: string) => (existsSync(stagingDir(slug, token)) ? readdirSync(stagingDir(slug, token)).filter((f) => !f.startsWith('.')) : []);
const clip = (c: Composition, id: string) => c.tracks.flatMap((t) => t.clips).find((k) => k.id === id)! as unknown as { id: string; src?: string };

async function waitJob(id: string): Promise<JobSummary> {
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
async function create(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: true, brief: { goal: 'g', message: '', formats: ['test-wide'], durationSec: 4, assets: [], notes: '' },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const done = await waitJob((r.json().job as JobSummary).id);
  expect(done.state, done.error).toBe('succeeded');
  return r.json().slug as string;
}
async function view(slug: string, n: number, format: string): Promise<EditorCompositionView> {
  const r = await app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/${n}/compositions/${format}`, headers: H });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as EditorCompositionView;
}
async function mint(slug: string, format = 'test-wide'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H, payload: { format, parentOrigin: UI_ORIGIN } });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { token: string }).token;
}
const stageEdit = (slug: string, token: string, content: string, baseSrc = 'assets/logo.svg', clipId = 'logo') =>
  app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/editor/stage`, headers: H, payload: { token, from: { kind: 'svgEdit', clipId, baseSrc, content } } });
const save = (slug: string, body: unknown) => app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/edits`, headers: H, payload: body as object });

describe('the save body', () => {
  it('names up to 220 staged paths: 20 library files and fonts plus 200 edited SVGs', () => {
    expect(EDITOR_SAVE_STAGED_MAX).toBe(220);
    const body = (n: number) => ({ baseVersion: 1, format: 'f', baseHash: 'a'.repeat(64), composition: {}, ops: [], token: 'A'.repeat(43),
      staged: Array.from({ length: n }, (_, i) => `assets/lib/logo-e${String(i).padStart(8, '0')}.svg`) });
    expect(directEditBodySchema.safeParse(body(220)).success).toBe(true);
    expect(directEditBodySchema.safeParse(body(221)).success).toBe(false);
  });
});

describe('staging an edited SVG', { timeout: 120_000 }, () => {
  it('answers a content-addressed path in the session staging, the same for the same content, and the check warnings', async () => {
    const slug = await create();
    const token = await mint(slug);
    const r = await stageEdit(slug, token, GOOD);
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json() as { path: string; warnings: string[]; kind: string };
    expect(a.path).toBe(`assets/lib/logo-e${sha8(GOOD)}.svg`);
    expect(a).toMatchObject({ kind: 'svg', warnings: [], svgEdit: true });
    expect(readFileSync(join(stagingDir(slug, token), `logo-e${sha8(GOOD)}.svg`), 'utf8')).toBe(GOOD);
    expect((await stageEdit(slug, token, GOOD)).json().path).toBe(a.path);
    // An edit of the edit: named after the original stem, not stacked suffixes.
    const next = GOOD.replace('#ff5a1f', '#000000');
    const b = (await stageEdit(slug, token, next, a.path)).json() as { path: string };
    expect(b.path).toBe(`assets/lib/logo-e${sha8(next)}.svg`);
    // Text is accepted with the check's warning.
    const withText = GOOD.replace('</svg>', '<text x="1" y="10">Acme</text></svg>');
    const t = (await stageEdit(slug, token, withText)).json() as { warnings: string[] };
    expect(t.warnings).toHaveLength(1);
    expect(stagedFiles(slug, token)).toHaveLength(3);
  });

  it('refuses a script, an external link and an SVG over 512 KB with the check reasons; a base that is not an SVG of the composition; nothing is staged', async () => {
    const slug = await create();
    const token = await mint(slug);
    for (const [content, reason] of [
      [GOOD.replace('</svg>', '<script>alert(1)</script></svg>'), /script/],
      [GOOD.replace('</svg>', '<use href="https://example.com/a.svg#x"/></svg>'), /local #id/],
      [GOOD.replace('</svg>', `<desc>${'x'.repeat(512 * 1024)}</desc></svg>`), /over 512 KB/],
    ] as const) {
      const r = await stageEdit(slug, token, content);
      expect(r.statusCode, r.body.slice(0, 300)).toBe(400);
      expect(r.json().code).toBe('svg-edit-refused');
      expect((r.json().problems as string[]).some((p) => reason.test(p)), r.body.slice(0, 300)).toBe(true);
    }
    for (const baseSrc of ['assets/logo.png', 'assets/nope.svg', '../logo.svg', 'assets/lib/never-staged.svg']) {
      const r = await stageEdit(slug, token, GOOD, baseSrc);
      expect(r.statusCode, baseSrc).toBe(400);
    }
    expect((await stageEdit(slug, token, GOOD, 'assets/nope.svg')).json().code).toBe('svg-edit-bad-base');
    expect(stagedFiles(slug, token)).toEqual([]);
  });

  it('a save with the new src makes a version with the new file, and the old file stays for a clip that still uses it', async () => {
    const slug = await create();
    const token = await mint(slug);
    const staged = (await stageEdit(slug, token, GOOD)).json() as { path: string };
    const vw = await view(slug, 1, 'test-wide');
    const c = structuredClone(vw.composition);
    const track = c.tracks.find((t) => t.clips.some((k) => k.id === 'logo'))!;
    // A second clip shares the base file: it keeps it.
    track.clips.push({ ...structuredClone(track.clips.find((k) => k.id === 'logo')!), id: 'logo2' } as never);
    clip(c, 'logo').src = staged.path;
    const r = await save(slug, { baseVersion: 1, format: 'test-wide', baseHash: vw.hash, composition: c, staged: [staged.path], ops: [{ kind: 'clipMedia', clipId: 'logo', src: staged.path }], token });
    expect(r.statusCode, r.body).toBe(200);
    const dir = compDir(slug, 2, 'test-wide');
    expect(readFileSync(join(dir, staged.path), 'utf8')).toBe(GOOD);
    expect(existsSync(join(dir, 'assets', 'logo.svg'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, 'composition.json'), 'utf8')) as Composition;
    expect(clip(saved, 'logo').src).toBe(staged.path);
    expect(clip(saved, 'logo2').src).toBe('assets/logo.svg');
    expect((await versionOf(slug, 2))!.status).toBe('complete');
  });

  it('an identity format recoloured and saved is a complete version with no problems', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Icon', generate: false, brief: { goal: 'g', message: '', formats: [ICON.id], durationSec: null, assets: [], notes: '' },
    } });
    expect(r.statusCode, r.body).toBe(201);
    const slug = r.json().slug as string;
    const dir = compDir(slug, 1, ICON.id);
    const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>';
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'mark.svg'), mark);
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({
      $schema: 'motion-studio/composition@1', width: 64, height: 64, fps: 30, duration: 0, background: '#ffffff', fonts: [], scenes: [],
      tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'mark', type: 'svg', src: 'assets/mark.svg', start: 0, duration: 0, props: { fit: 'contain' } }] }],
    }));
    const compositions = [{ format: ICON.id, dir: `compositions/${ICON.id}`, hash: (await readCompositionFolder(dir)).hash, problems: [] }];
    writeFileSync(join(store().outputsDir(slug, 1), 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] }));
    await store().appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null, compositions });

    const token = await mint(slug, ICON.id);
    const recoloured = mark.replace('#123456', '#ff5a1f');
    const staged = await stageEdit(slug, token, recoloured, 'assets/mark.svg', 'mark');
    expect(staged.statusCode, staged.body).toBe(200);
    const path = (staged.json() as { path: string }).path;
    const vw = await view(slug, 1, ICON.id);
    const c = structuredClone(vw.composition);
    clip(c, 'mark').src = path;
    const s = await save(slug, { baseVersion: 1, format: ICON.id, baseHash: vw.hash, composition: c, staged: [path], ops: [{ kind: 'clipMedia', clipId: 'mark', src: path }, { kind: 'svgContent', clipId: 'mark', colors: 1, texts: 0, hidden: 0 }], token });
    expect(s.statusCode, s.body).toBe(200);
    const v2 = (await versionOf(slug, 2))!;
    expect(v2).toMatchObject({ status: 'complete', problems: [] });
    // The summary names the SVG change (the svgContent op of the web's section).
    expect(v2.request).toMatch(/mark: 1 (colour changed|colore cambiato)/);
    expect(v2.compositions![0]!.problems).toEqual([]);
    expect(readFileSync(join(compDir(slug, 2, ICON.id), path), 'utf8')).toBe(recoloured);
  });
});

describe('reading a clip SVG for the editor', { timeout: 120_000 }, () => {
  const read = (slug: string, token: string, path: string) =>
    app.inject({ url: `/api/projects/acme/creatives/${slug}/editor/svg?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`, headers: H });

  it('answers the checked text of a base file or of a staged edit, and refuses what the check refuses', async () => {
    const slug = await create();
    const token = await mint(slug);
    // (the fake agent's logo.svg has no viewBox, which the strict check refuses: a file of its own here)
    const text = GOOD.replace('</svg>', '<text x="1" y="10">Acme</text></svg>');
    writeFileSync(join(compDir(slug, 1, 'test-wide'), 'assets', 'mark.svg'), text);
    const r = await read(slug, token, 'assets/mark.svg');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ path: 'assets/mark.svg', content: text });
    expect((r.json() as { warnings: string[] }).warnings).toHaveLength(1);
    expect((await read(slug, token, 'assets/logo.svg')).json().code).toBe('svg-edit-refused');
    const staged = (await stageEdit(slug, token, GOOD)).json() as { path: string };
    expect((await read(slug, token, staged.path)).json()).toMatchObject({ path: staged.path, content: GOOD, warnings: [] });
    // A base file the check refuses: the editor shows the reasons and never draws it inline.
    writeFileSync(join(compDir(slug, 1, 'test-wide'), 'assets', 'bad.svg'), GOOD.replace('</svg>', '<script>alert(1)</script></svg>'));
    const bad = await read(slug, token, 'assets/bad.svg');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('svg-edit-refused');
    expect((bad.json().problems as string[]).some((p) => /script/.test(p))).toBe(true);
    expect(bad.body).not.toContain('alert(1)');
    for (const path of ['assets/nope.svg', 'composition.json', '../logo.svg', 'assets/lib/never-staged.svg']) {
      expect((await read(slug, token, path)).json().code, path).toBe('svg-edit-bad-base');
    }
    expect((await read(slug, 'A'.repeat(43), 'assets/logo.svg')).json().code).toBe('editor-no-session');
  });
});

describe('reading a clip SVG: what is refused', { timeout: 180_000 }, () => {
  const read = (slug: string, token: string, path: string) =>
    app.inject({ url: `/api/projects/acme/creatives/${slug}/editor/svg?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`, headers: H });

  it('the session of another creative', async () => {
    const a = await create();
    const b = await create();
    const token = await mint(a);
    writeFileSync(join(compDir(a, 1, 'test-wide'), 'assets', 'mark.svg'), GOOD);
    expect((await read(a, token, 'assets/mark.svg')).statusCode).toBe(200);
    const other = await read(b, token, 'assets/mark.svg');
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('editor-no-session');
  });

  it('links: a file or a folder of the composition linked elsewhere (even inside it), and a staged file swapped for a link', async () => {
    const slug = await create();
    const token = await mint(slug);
    const dir = compDir(slug, 1, 'test-wide');
    const outside = join(base, 'outside.svg');
    writeFileSync(outside, GOOD);
    symlinkSync(outside, join(dir, 'assets', 'out.svg'));
    // A folder link that stays inside the composition: only the exact real path is accepted (exact = true).
    mkdirSync(join(dir, 'assets', 'inner'));
    writeFileSync(join(dir, 'assets', 'inner', 'mark.svg'), GOOD);
    symlinkSync(join(dir, 'assets', 'inner'), join(dir, 'assets', 'linked'));
    expect((await read(slug, token, 'assets/inner/mark.svg')).statusCode).toBe(200);
    for (const path of ['assets/out.svg', 'assets/linked/mark.svg']) {
      const r = await read(slug, token, path);
      expect(r.statusCode, path).toBe(400);
      expect(r.json().code, path).toBe('svg-edit-bad-base');
    }
    // A staged edit replaced by a link to a file outside.
    const staged = (await stageEdit(slug, token, GOOD)).json() as { path: string };
    expect((await read(slug, token, staged.path)).statusCode).toBe(200);
    const file = join(stagingDir(slug, token), staged.path.slice('assets/lib/'.length));
    unlinkSync(file);
    symlinkSync(outside, file);
    const r = await read(slug, token, staged.path);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('svg-edit-bad-base');
  });
});

describe('a discarded variant', { timeout: 60_000 }, () => {
  it('refuses svgEdit staging with 409 variant-discarded', async () => {
    v = await variantApp();
    const P = '/api/projects/acme/creatives';
    const slug = ((await v.app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' }, generate: false } })).json() as { slug: string }).slug;
    expect((await v.app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2 } })).statusCode).toBe(201);
    expect((await v.app.inject({ method: 'POST', url: `${P}/${slug}/variants/b/discard` })).statusCode).toBe(200);
    const res = await v.app.inject({ method: 'POST', url: `${P}/${slug}~b/editor/stage`, payload: { token: 'A'.repeat(43), from: { kind: 'svgEdit', clipId: 'logo', baseSrc: 'assets/logo.svg', content: GOOD } } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'variant-discarded' });
  });
});
