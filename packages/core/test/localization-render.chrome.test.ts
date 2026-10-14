// @vitest-environment node
/**
 * Localized renders in real Chrome (Phase 12, Task 3 fix round 1, Ruling I): the runtime measures each text clip after
 * layout and reports an advisory `textOverflow`; a localized render records it as a problem of that language, while the
 * primary-language render of the same overflowing composition stays as it was (never a failure, no new problem). The render
 * runs on the private copy (an `@2` instance id, the fallback font file present). Skipped without Chrome, unless
 * MS_REQUIRE_CHROME=1 (CI).
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messages, type Composition, type FormatPreset, type JobSummary, type ManifestV2 } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { currentLocale } from '../src/i18n.ts';
import { createFfmpegTools, NoMediaTools } from '../src/media/media-tools.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { createRenderEngine } from '../src/render/renderer.ts';
import { buildServer } from '../src/server/app.ts';
import { buildRuntime, FONT, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('localized render tests');
const TOKEN = 'ce'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const PRESET: FormatPreset = { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png'] };
/** A still with a safe zone that leaves out the right 40 px (as a Reels frame leaves out its right band). */
const SAFE: FormatPreset = { ...PRESET, id: 'test-safe', name: 'Safe', safeZone: { top: 0, bottom: 0, left: 0, right: 40 } };
const LONG_DE = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung';

const composition = (text: string, props: Record<string, unknown> = {}) => ({
  $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 0, background: '#000000',
  fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }], scenes: [],
  tracks: [{ id: 'v', kind: 'visual', clips: [
    // A narrow box: one line of 20 px text, 140 px wide.
    { id: 'title', name: 'Title', type: 'text', start: 0, duration: 0, props: { x: 10, y: 10, width: 140, height: 26, text, fontSize: 20, fontFamily: 'Mono', color: '#ffffff', ...props } },
  ] }],
});

describe.skipIf(!tools.ok)('localized renders in real Chrome', () => {
  let work: string;
  let ws: string;
  let app: FastifyInstance;
  let dist: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-l10n-chrome-'));
    dist = join(work, 'dist');
    mkdirSync(join(work, 'render-tmp'));
    await buildRuntime(dist);
    ws = join(work, 'ws');
    app = await buildServer({
      uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(work, 'config')), git: new Git(),
      runner: new ClaudeCodeRunner([process.execPath, '-e', ''], { killGraceMs: 200 }), doctor: async () => [],
      media: await createFfmpegTools(),
      render: createRenderEngine({ provider: async () => new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 10 * 60_000 } }) }),
      renderOptions: { distDir: dist, tempDir: join(work, 'render-tmp'), parallel: 1, encoder: 'libx264' },
    });
    await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
    await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
    await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [PRESET, SAFE] } });
  }, 600_000);
  afterAll(async () => { await app?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

  async function waitJob(id: string): Promise<JobSummary> {
    for (const t0 = Date.now(); Date.now() - t0 < 300_000;) {
      const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
      if (j && j.state !== 'queued' && j.state !== 'running') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout waiting for the job');
  }

  /** A creative with the `@2` instance of the still preset, its v1 composition showing `source`. */
  async function creative(source: string, o: { preset?: string; props?: Record<string, unknown> } = {}) {
    const preset = o.preset ?? 'test-still';
    const format = `${preset}@2`;
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Lang', generate: false, brief: { goal: 'g', message: '', formats: [preset, format], durationSec: null, assets: [], notes: '', links: {}, locales: { primary: 'en', extra: ['de', 'ja'] } },
    } });
    expect(r.statusCode, r.body).toBe(201);
    const slug = r.json().slug as string;
    const store = new CreativeStore(join(ws, 'acme'));
    const vdir = store.outputsDir(slug, 1);
    const compositions = [];
    for (const f of [preset, format]) {
      const dir = join(vdir, 'compositions', f);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      copyFileSync(FONT, join(dir, 'assets', 'Mono.woff2'));
      writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition(source, o.props)));
      compositions.push({ format: f, dir: `compositions/${f}`, hash: (await readCompositionFolder(dir)).hash, problems: [] });
    }
    writeFileSync(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
    await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null, compositions });
    return { slug, store, format };
  }

  it('a German text too long for a narrow box: the render measures it and records the problem on that language', { timeout: 300_000 }, async () => {
    const { slug, store, format } = await creative('Welcome');
    // The user's fit 1 (kept): the estimate already flags it, so the render needs force.
    const put = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/${encodeURIComponent(format)}`, headers: H, payload: { texts: { title: LONG_DE }, fit: { title: 1 } } });
    expect(put.statusCode, put.body).toBe(200);
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: [format], locales: ['de'], force: true } });
    expect(r.statusCode, r.body).toBe(202);
    const job = await waitJob((r.json() as JobSummary).id);
    expect(job.state, job.error).toBe('succeeded');
    const row = (await store.readVersions(slug))[0]!.localizations!.find((x) => x.locale === 'de')!;
    const measured = messages(currentLocale()).variants.textOverflowMeasured({ clip: 'Title', fit: 100 });
    expect(row.render?.file).toBe('test-still@2.de.png');
    expect(row.render?.problems).toContain(measured);
    expect(row.problems).toContain(measured);
  });

  it('frames report each overflowing clip, also two equal boxes that overflow alike (Task 4 fix I3: the localize turn measure)', { timeout: 300_000 }, async () => {
    const dir = join(work, 'frames-creative');
    const comp = join(dir, 'outputs', 'v1', 'compositions', PRESET.id);
    mkdirSync(join(comp, 'assets'), { recursive: true });
    copyFileSync(FONT, join(comp, 'assets', 'Mono.woff2'));
    const c = composition(LONG_DE);
    const first = c.tracks[0]!.clips[0]!;
    c.tracks[0]!.clips.push({ ...first, id: 'title2', name: 'Title 2', props: { ...first.props, y: 100 } });
    writeFileSync(join(comp, 'composition.json'), JSON.stringify(c));
    const engine = createRenderEngine({ provider: async () => new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 10 * 60_000 } }) });
    const r = await engine.frames({ dir, versionDir: 'outputs/v1', composition: c as unknown as Composition, format: PRESET, times: [0], width: 64, imageFormat: 'jpeg',
      signal: new AbortController().signal, distDir: dist });
    const over = r.errors.filter((e) => e.code === 'textOverflow');
    // The same message for both (equal boxes, same text): still two reports, one per clip.
    expect(new Set(over.map((e) => e.message)).size).toBe(1);
    expect(over.map((e) => e.clipId).sort()).toEqual(['title', 'title2']);
  });

  it('a text clip without an explicit box (or with a width only) is measured against the frame, or the safe zone (final wave P6)', { timeout: 300_000 }, async () => {
    const dir = join(work, 'unboxed-creative');
    const comp = join(dir, 'outputs', 'v1', 'compositions', PRESET.id);
    mkdirSync(join(comp, 'assets'), { recursive: true });
    copyFileSync(FONT, join(comp, 'assets', 'Mono.woff2'));
    const text = (id: string, props: Record<string, unknown>) => ({ id, name: id, type: 'text', start: 0, duration: 0, props: { fontFamily: 'Mono', color: '#ffffff', ...props } });
    const c = {
      ...composition('x'),
      tracks: [{ id: 'v', kind: 'visual', clips: [
        // No box: a long German string wraps at the frame's right edge and runs past its bottom.
        text('long', { x: 10, y: 60, fontSize: 28, text: LONG_DE }),
        // No box, short: inside the frame.
        text('short', { x: 10, y: 10, fontSize: 20, text: 'Hallo' }),
        // A width only: it wraps in its 140 px and runs past the bottom.
        text('narrow', { x: 170, y: 40, width: 140, fontSize: 20, text: LONG_DE }),
        // No box, inside the frame but below a safe zone that leaves the bottom 100 px out.
        text('low', { x: 10, y: 120, fontSize: 20, text: 'Hallo Welt' }),
        // No box, inside the frame but above a safe zone that leaves the top 8 px out (fix round 1, M6: every edge).
        text('high', { x: 200, y: 2, fontSize: 12, text: 'Hi' }),
        // No box, short, but scaled 3x about its centre: as drawn it reaches past the frame's left edge (M6: scale counts).
        text('scaled', { x: 4, y: 150, fontSize: 12, text: 'Hallo', scale: 3 }),
      ] }],
    };
    writeFileSync(join(comp, 'composition.json'), JSON.stringify(c));
    const engine = createRenderEngine({ provider: async () => new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 10 * 60_000 } }) });
    const measure = async (format: FormatPreset) => {
      const r = await engine.frames({ dir, versionDir: 'outputs/v1', composition: c as unknown as Composition, format, times: [0], width: 64, imageFormat: 'jpeg',
        signal: new AbortController().signal, distDir: dist });
      return r.errors.filter((e) => e.code === 'textOverflow').map((e) => e.clipId).sort();
    };
    expect(await measure(PRESET)).toEqual(['long', 'narrow', 'scaled']);
    expect(await measure({ ...PRESET, safeZone: { top: 8, bottom: 100, left: 0, right: 0 } })).toEqual(['high', 'long', 'low', 'narrow', 'scaled']);
  });

  it('unboxed text whose source wraps to the frame edge (past a safe zone): a translation of the same length gets only a note (N1)', { timeout: 300_000 }, async () => {
    const source = 'Welcome to the brand new version of our wonderful app for every device';
    const { slug, store, format } = await creative(source, { preset: 'test-safe', props: { width: undefined, height: undefined, y: 40 } });
    const put = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/${encodeURIComponent(format)}`, headers: H,
      payload: { texts: { title: 'Willkommen zur neuen Version unserer App für jedes Gerät, ganz einfach' } } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().problems).toEqual([]);
    expect(put.json().issues).toEqual([{ code: 'sourceTextOverflow', clipId: 'title', message: messages(currentLocale()).variants.sourceTextOverflow({ clip: 'Title' }) }]);
    // The localized render needs no force for it, and keeps it a note.
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: [format], locales: ['de'] } });
    expect(r.statusCode, r.body).toBe(202);
    expect((await waitJob((r.json() as JobSummary).id)).state).toBe('succeeded');
    const row = (await store.readVersions(slug))[0]!.localizations!.find((x) => x.locale === 'de')!;
    expect(row.problems).toBeUndefined();
    expect(row.render?.problems).toBeUndefined();
  });

  it('a short translation: no overflow measured; the primary render of an overflowing source neither fails nor gains a problem', { timeout: 300_000 }, async () => {
    const { slug, store, format } = await creative(LONG_DE);
    const put = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/${encodeURIComponent(format)}`, headers: H, payload: { texts: { title: 'Hallo' } } });
    expect(put.json().problems).toEqual([]);
    const loc = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: [format], locales: ['de'] } });
    expect(loc.statusCode, loc.body).toBe(202);
    expect((await waitJob((loc.json() as JobSummary).id)).state).toBe('succeeded');
    const row = (await store.readVersions(slug))[0]!.localizations!.find((x) => x.locale === 'de')!;
    expect(row.render?.problems).toBeUndefined();
    const primary = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: [format] } });
    const done = await waitJob((primary.json() as JobSummary).id);
    expect(done.state, done.error).toBe('succeeded');
    const out = (await store.readVersions(slug))[0]!.outputs.find((o) => o.format === format)!;
    expect(out.problems).toEqual([]);
  });

  it('a Japanese translation renders with its fallback font in the private copy (from the library: no download)', { timeout: 300_000 }, async () => {
    const { slug, store, format } = await creative('Hello');
    const projectDir = join(ws, 'acme');
    mkdirSync(join(projectDir, 'assets', 'fonts'), { recursive: true });
    copyFileSync(FONT, join(projectDir, 'assets', 'fonts', 'NotoSansJP-400.woff2'));
    await new LibraryStore(projectDir, NoMediaTools).registerAssets([{ file: 'fonts/NotoSansJP-400.woff2', origin: 'google-fonts', tags: ['font', 'Noto Sans JP'], description: 'Font Noto Sans JP' }]);
    const put = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/ja/${encodeURIComponent(format)}`, headers: H, payload: { texts: { title: 'こんにちは' } } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().overlay.fonts).toEqual([{ family: 'Noto Sans JP', files: ['assets/fonts/NotoSansJP-400.woff2'] }]);
    expect(put.json().problems).toEqual([]);
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { formats: [format], locales: ['ja'] } });
    expect(r.statusCode, r.body).toBe(202);
    const job = await waitJob((r.json() as JobSummary).id);
    expect(job.state, job.error).toBe('succeeded');
    const row = (await store.readVersions(slug))[0]!.localizations!.find((x) => x.locale === 'ja')!;
    expect(row.render).toMatchObject({ file: 'test-still@2.ja.png', forced: false });
  });
});
