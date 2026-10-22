// @vitest-environment node
/**
 * Subtitles Task 18 (spec §6.1 "Versions", §6.6, U8): the subtitle set staged into renders and preview sessions (in the
 * runtime page's data, never a file the renderer reads), the snapshot kept next to the output, the set and hash each output
 * was drawn with, render staleness when the set changes, the default language pairing, and the pending subtitle commits
 * flushed before a render. A composition without a subtitles track renders exactly as before (anti-goal 4).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SUBTITLES_SCHEMA_ID, renderState, subtitleCuesHash, subtitleHashesOf, subtitleSetText, type Composition, type CreativeDetail, type FormatPreset, type JobSummary, type ManifestV2, type SubtitleSet,
} from '@motion-studio/shared';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { RenderJobService } from '../src/creatives/render-jobs.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import type { MediaNormalizer } from '../src/render/media-normalize.ts';
import { resolveLocalizedItems } from '../src/creatives/export.ts';
import { readSubtitleSet, removeSubtitleSet, stageSubtitles, writeSubtitleSet } from '../src/subtitles/store.ts';
import { FONT } from './helpers/render-env.ts';
import { H, PRESETS, UI_ORIGIN, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const DURATION = 5;

const subtitlesTrack = (hidden = false) => ({
  id: 'subs', kind: 'subtitles', ...(hidden ? { hidden: true } : {}),
  clips: [{ id: 'sub', type: 'subtitles', start: 0, duration: DURATION, props: { fontFamily: 'Mono', fontSize: 20, color: '#ffffff', position: 'bottom', margin: 10, maxWidth: 0.8 } }],
});
const composition = (o: { track?: boolean; hidden?: boolean } = {}) => ({
  $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: DURATION, background: '#101010',
  fonts: o.track ? [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }] : [],
  scenes: [{ id: 's', start: 0, duration: DURATION }],
  tracks: [
    { id: 't', kind: 'visual', clips: [{ id: 'box', type: 'shape', start: 0, duration: DURATION, props: { x: 10, y: 10, width: 100, height: 50, fill: '#ff0000' } }] },
    ...(o.track ? [subtitlesTrack(o.hidden)] : []),
  ],
}) as unknown as Composition;

const set = (lang: SubtitleSet['lang'], over: Partial<SubtitleSet> = {}): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang, origin: 'speech', transcript: 'whisper-small', detected: lang,
  timing: { version: 1, format: 'test-wide', fingerprint: 'a'.repeat(64) },
  cues: [
    { id: 'c1', start: 0, end: 1200, text: `Ciao ${lang}`, words: [{ start: 0, end: 500, text: 'Ciao' }, { start: 500, end: 1200, text: lang }] },
    // Past the 5 s duration: cut at the end (and its words with it).
    { id: 'c2', start: 4500, end: 6000, text: 'fine', words: [{ start: 4500, end: 4800, text: 'fi' }, { start: 4800, end: 5600, text: 'ne' }, { start: 5100, end: 5900, text: 'x' }] },
    // Starts after the end: dropped.
    { id: 'c3', start: 5000, end: 6500, text: 'dopo' },
  ],
  ...over,
});

describe('stageSubtitles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-test-subs-stage-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('staged cues are clamped to the composition: a cue past the 5 s duration is cut, one starting after it dropped', async () => {
    const s = set('it');
    await writeSubtitleSet(dir, s);
    // The lines' hash, what a render records (final review M3).
    const hash = subtitleCuesHash(s);
    const staged = await stageSubtitles({ creativeDir: dir, composition: composition({ track: true }), lang: 'it', durationMs: DURATION * 1000 });
    expect(staged).not.toBeNull();
    expect(staged!.hash).toBe(hash);
    expect(staged!.set).toEqual(s);
    expect(staged!.data).toEqual({ lang: 'it', cues: [
      { start: 0, end: 1200, text: 'Ciao it', words: [{ start: 0, end: 500, text: 'Ciao' }, { start: 500, end: 1200, text: 'it' }] },
      { start: 4500, end: 5000, text: 'fine', words: [{ start: 4500, end: 4800, text: 'fi' }, { start: 4800, end: 5000, text: 'ne' }] },
    ] });
  });

  it('a set written with its keys out of order hashes the same on write and on read (review M1)', async () => {
    const s = set('de', { origin: 'translation', sourceLang: 'it' });
    expect(Object.keys(s).at(-1)).toBe('sourceLang');
    const written = await writeSubtitleSet(dir, s);
    expect((await readSubtitleSet(dir, 'de'))!.hash).toBe(written);
  });

  it('null without a visible subtitles track, without a language, or without that language\'s set', async () => {
    await writeSubtitleSet(dir, set('it'));
    const at = (c: Composition, lang: 'it' | 'en' | null) => stageSubtitles({ creativeDir: dir, composition: c, lang, durationMs: DURATION * 1000 });
    expect(await at(composition(), 'it')).toBeNull();
    expect(await at(composition({ track: true, hidden: true }), 'it')).toBeNull();
    expect(await at(composition({ track: true }), null)).toBeNull();
    expect(await at(composition({ track: true }), 'en')).toBeNull();
  });
});

let env: InstanceEnv;
beforeEach(async () => { env = await startInstanceEnv('ms-test-subs-render-'); });
afterEach(async () => { await env?.close(); });

/**
 * A creative with a v2 version 1 whose `test-wide` composition is written here (with or without the subtitles track), and the
 * follower `test-wide-b` linked to it.
 */
async function creative(o: { track?: boolean; locales?: { primary: string; extra: string[] } } = {}): Promise<{ slug: string; dir: string; store: CreativeStore }> {
  const r = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats: ['test-wide', 'test-wide-b'], durationSec: DURATION, assets: [], notes: '',
      links: { 'test-wide-b': 'test-wide' }, ...(o.locales ? { locales: o.locales } : {}) },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const slug = r.json().slug as string;
  const store = env.store();
  const vdir = store.outputsDir(slug, 1);
  const cdir = join(vdir, 'compositions', 'test-wide');
  mkdirSync(join(cdir, 'assets'), { recursive: true });
  copyFileSync(FONT, join(cdir, 'assets', 'Mono.woff2'));
  writeFileSync(join(cdir, 'composition.json'), JSON.stringify(composition({ track: o.track })));
  const hash = (await readCompositionFolder(cdir)).hash;
  const compositions = [
    { format: 'test-wide', dir: 'compositions/test-wide', hash, problems: [] },
    { format: 'test-wide-b', dir: 'compositions/test-wide', hash, followsFormat: 'test-wide', problems: [] },
  ];
  const manifest: ManifestV2 = { schemaVersion: 2, compositions, renders: [] };
  writeFileSync(join(vdir, 'manifest.json'), JSON.stringify(manifest));
  await store.appendVersion(slug, {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [],
    renderCommand: null, basedOn: null, compositions,
  });
  return { slug, dir: store.dir(slug), store };
}

const done = async (r: { statusCode: number; body: string; json(): unknown }) => {
  expect(r.statusCode, r.body).toBe(202);
  const j = await env.waitJob((r.json() as JobSummary).id);
  expect(j.state, j.error).toBe('succeeded');
  return j;
};
const render = (slug: string, payload: object = {}) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload });
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'outputs', 'v1', 'manifest.json'), 'utf8')) as ManifestV2;

describe('a version render draws the subtitles', { timeout: 120_000 }, () => {
  it('records outputs[].subtitles = { lang, hash } (the follower too), writes the snapshot, and hands the staged set to the renderer', async () => {
    const { slug, dir, store } = await creative({ track: true, locales: { primary: 'it', extra: ['en'] } });
    const it = set('it');
    await writeSubtitleSet(dir, it);
    const hash = subtitleCuesHash(it);
    await writeSubtitleSet(dir, set('en', { origin: 'translation', sourceLang: 'it' }));
    await done(await render(slug));
    const call = env.fake.renders.at(-1)!;
    expect(call.subtitles?.lang).toBe('it');
    expect(call.subtitles?.cues.map((c) => [c.start, c.end])).toEqual([[0, 1200], [4500, 5000]]);
    const v = (await store.readVersions(slug))[0]!;
    expect(v.outputs.find((x) => x.format === 'test-wide')!.subtitles).toEqual({ lang: 'it', hash });
    expect(v.outputs.find((x) => x.format === 'test-wide-b')!.subtitles).toEqual({ lang: 'it', hash });
    expect(manifestOf(dir).renders.find((x) => x.format === 'test-wide')!.subtitles).toEqual({ lang: 'it', hash });
    // The snapshot: the set exactly as drawn, next to the output.
    const snap = join(dir, 'outputs', 'v1', 'subtitles', `it.${hash.slice(0, 12)}.json`);
    expect(readFileSync(snap, 'utf8')).toBe(subtitleSetText(it));
    // Rendering again with the same set writes nothing new (idempotent).
    await done(await render(slug, { formats: ['test-wide'] }));
    expect(readdirSync(join(dir, 'outputs', 'v1', 'subtitles'))).toEqual([`it.${hash.slice(0, 12)}.json`]);
  });

  it('renderState is stale once the set changes (the detail says so too); rendered without the map', async () => {
    const { slug, dir, store } = await creative({ track: true, locales: { primary: 'it', extra: [] } });
    await writeSubtitleSet(dir, set('it'));
    await done(await render(slug));
    await writeSubtitleSet(dir, set('it', { cues: [{ id: 'c1', start: 0, end: 1000, text: 'Corretto', edited: true }] }));
    const changed = (await readSubtitleSet(dir, 'it'))!.cuesHash;
    const v = (await store.readVersions(slug))[0]!;
    expect(renderState(v, 'test-wide', { it: changed })).toBe('stale');
    expect(renderState(v, 'test-wide')).toBe('rendered');
    const detail = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
    expect(detail.formats!.find((f) => f.id === 'test-wide')!.starRender).toBe('stale');
    // A new render draws the corrected set.
    await done(await render(slug));
    expect(env.fake.renders.at(-1)!.subtitles?.cues).toEqual([{ start: 0, end: 1000, text: 'Corretto' }]);
    expect((await store.readVersions(slug))[0]!.outputs.find((x) => x.format === 'test-wide')!.subtitles).toEqual({ lang: 'it', hash: changed });
  });

  it('"Tempi controllati" and other changes outside the cues keep the render current; a cue edit makes it stale (final review M3)', async () => {
    const { slug, dir, store } = await creative({ track: true, locales: { primary: 'it', extra: [] } });
    const before = await writeSubtitleSet(dir, set('it'));
    await done(await render(slug));
    const starRender = async () => ((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail).formats!.find((f) => f.id === 'test-wide')!.starRender;
    // The timing record written again (as "Tempi controllati" does), the detected language and the origin: the file (and its
    // hash, the one save conflicts use) changes, the lines drawn do not.
    const checked = await writeSubtitleSet(dir, set('it', { timing: { version: 1, format: 'test-wide', fingerprint: 'b'.repeat(64) }, detected: 'en', transcript: 'whisper-large-v3-turbo' }));
    expect(checked).not.toBe(before);
    expect(await starRender()).toBe('rendered');
    const detail = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
    const v = (await store.readVersions(slug))[0]!;
    expect(renderState(v, 'test-wide', subtitleHashesOf(detail.subtitles))).toBe('rendered');
    // The summary keeps the set's own hash for the editor's saves.
    expect(detail.subtitles![0]!.hash).toBe(checked);
    // A line corrected: stale, here and in the web's map.
    await writeSubtitleSet(dir, set('it', { cues: [{ id: 'c1', start: 0, end: 1200, text: 'Ciao corretto', edited: true }] }));
    expect(await starRender()).toBe('stale');
    const after = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
    expect(renderState(v, 'test-wide', subtitleHashesOf(after.subtitles))).toBe('stale');
  });

  it('default pairing (U8): the brief\'s primary language when it has a set, else the set made from the speech', async () => {
    const { slug, dir } = await creative({ track: true });
    await writeSubtitleSet(dir, set('it'));
    await writeSubtitleSet(dir, set('en', { origin: 'translation', sourceLang: 'it' }));
    await done(await render(slug, { formats: ['test-wide'] }));
    expect(env.fake.renders.at(-1)!.subtitles?.lang).toBe('it');
  });

  it('without a subtitles track: no subtitles option, no snapshot, no record (anti-goal 4)', async () => {
    const { slug, dir, store } = await creative({ locales: { primary: 'it', extra: [] } });
    await writeSubtitleSet(dir, set('it'));
    await done(await render(slug));
    for (const call of env.fake.renders) expect('subtitles' in call).toBe(false);
    expect(existsSync(join(dir, 'outputs', 'v1', 'subtitles'))).toBe(false);
    for (const o of (await store.readVersions(slug))[0]!.outputs) expect('subtitles' in o).toBe(false);
    for (const r of manifestOf(dir).renders) expect('subtitles' in r).toBe(false);
  });
});

describe('a render with the track but no set (review I1)', { timeout: 120_000 }, () => {
  it('records a marker and turns stale once a set appears; removing the set and rendering again, then transcribing again, the same', async () => {
    const { slug, dir, store } = await creative({ track: true, locales: { primary: 'it', extra: [] } });
    await done(await render(slug, { formats: ['test-wide'] }));
    expect('subtitles' in env.fake.renders.at(-1)!).toBe(false);
    const out = async () => (await store.readVersions(slug))[0]!.outputs.find((x) => x.format === 'test-wide')!;
    expect((await out()).subtitles).toEqual({ lang: null, hash: null, seen: [] });
    expect(manifestOf(dir).renders.find((x) => x.format === 'test-wide')!.subtitles).toEqual({ lang: null, hash: null, seen: [] });
    const star = async () => ((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail).formats!.find((f) => f.id === 'test-wide')!.starRender;
    expect(await star()).toBe('rendered');
    await writeSubtitleSet(dir, set('it'));
    expect(await star()).toBe('stale');
    await done(await render(slug, { formats: ['test-wide'] }));
    expect((await out()).subtitles).toEqual({ lang: 'it', hash: (await readSubtitleSet(dir, 'it'))!.cuesHash });
    expect(await star()).toBe('rendered');
    // The set is removed: stale; rendered again without it: a marker, current; transcribed again: stale.
    await removeSubtitleSet(dir, 'it');
    expect(await star()).toBe('stale');
    await done(await render(slug, { formats: ['test-wide'] }));
    expect((await out()).subtitles).toEqual({ lang: null, hash: null, seen: [] });
    expect(await star()).toBe('rendered');
    await writeSubtitleSet(dir, set('it'));
    expect(await star()).toBe('stale');
  });
});

describe('a render with the track and only sets it cannot pair (review round 2)', { timeout: 120_000 }, () => {
  it('records the languages it saw: rendering again with the same sets is current; a speech set appearing makes it stale', async () => {
    const { slug, dir, store } = await creative({ track: true });
    await writeSubtitleSet(dir, set('en', { origin: 'translation', sourceLang: 'it' }));
    await done(await render(slug, { formats: ['test-wide'] }));
    const out = async () => (await store.readVersions(slug))[0]!.outputs.find((x) => x.format === 'test-wide')!;
    expect((await out()).subtitles).toEqual({ lang: null, hash: null, seen: ['en'] });
    const star = async () => ((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail).formats!.find((f) => f.id === 'test-wide')!.starRender;
    expect(await star()).toBe('rendered');
    await done(await render(slug, { formats: ['test-wide'] }));
    expect(await star()).toBe('rendered');
    await writeSubtitleSet(dir, set('it'));
    expect(await star()).toBe('stale');
  });

  it('a follower asked for alone after its primary\'s set changed renders the primary again (the set file is on disk before any commit)', async () => {
    const { slug, dir } = await creative({ track: true, locales: { primary: 'it', extra: [] } });
    await writeSubtitleSet(dir, set('it'));
    await done(await render(slug));
    const before = env.fake.renders.length;
    await writeSubtitleSet(dir, set('it', { cues: [{ id: 'c1', start: 0, end: 1000, text: 'Corretto', edited: true }] }));
    await done(await render(slug, { formats: ['test-wide-b'] }));
    expect(env.fake.renders.length).toBe(before + 1);
    expect(env.fake.renders.at(-1)!.subtitles?.cues).toEqual([{ start: 0, end: 1000, text: 'Corretto' }]);
  });
});

describe('a localized render', { timeout: 120_000 }, () => {
  it('draws its own language\'s set when there is one, else none', async () => {
    const { slug, dir, store } = await creative({ track: true, locales: { primary: 'it', extra: ['de'] } });
    await writeSubtitleSet(dir, set('it'));
    const put = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/test-wide`, headers: H, payload: {} });
    expect(put.statusCode, put.body).toBe(200);
    await done(await render(slug, { formats: ['test-wide'], locales: ['de'] }));
    expect('subtitles' in env.fake.renders.at(-1)!).toBe(false);
    const row = () => store.readVersions(slug).then((vs) => vs[0]!.localizations!.find((r) => r.locale === 'de')!);
    // A marker: the track draws, but there was no `de` set (review I1).
    expect((await row()).render!.subtitles).toEqual({ lang: 'de', hash: null });
    const items = async () => {
      const vs = await store.readVersions(slug);
      const r = await resolveLocalizedItems(dir, vs, [{ format: 'test-wide', n: 1, file: 'test-wide.mp4', width: 320, height: 180 }], ['de']);
      return { current: r.items.length, pending: [...r.pending.values()].flatMap((p) => p.locales) };
    };
    expect(await items()).toEqual({ current: 1, pending: [] });
    await writeSubtitleSet(dir, set('de', { origin: 'translation', sourceLang: 'it' }));
    // The `de` set appeared: the render without it is no longer current.
    expect(await items()).toEqual({ current: 0, pending: ['de'] });
    const { cuesHash: hash } = (await readSubtitleSet(dir, 'de'))!;
    await done(await render(slug, { formats: ['test-wide'], locales: ['de'] }));
    expect(env.fake.renders.at(-1)!.subtitles?.lang).toBe('de');
    expect((await row()).render!.subtitles).toEqual({ lang: 'de', hash });
    expect(manifestOf(dir).renders.find((r) => r.locale === 'de')!.subtitles).toEqual({ lang: 'de', hash });
    expect(existsSync(join(dir, 'outputs', 'v1', 'subtitles', `de.${hash.slice(0, 12)}.json`))).toBe(true);
  });
});

describe('a preview session', { timeout: 120_000 }, () => {
  it('carries the staged subtitles in the runtime page\'s data; none without the track', async () => {
    const { slug, dir } = await creative({ track: true, locales: { primary: 'it', extra: [] } });
    await writeSubtitleSet(dir, set('it'));
    const pageData = async (s: string) => {
      const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${s}/versions/1/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: UI_ORIGIN } });
      expect(r.statusCode, r.body).toBe(200);
      const html = await (await fetch(r.json().url as string)).text();
      const m = /<script type="application\/json" id="ms-composition">(.*?)<\/script>/s.exec(html);
      return JSON.parse(m![1]!) as { subtitles?: { lang: string; cues: unknown[] } };
    };
    const data = await pageData(slug);
    expect(data.subtitles?.lang).toBe('it');
    expect(data.subtitles?.cues).toHaveLength(2);
    const plain = await creative({ locales: { primary: 'it', extra: [] } });
    await writeSubtitleSet(plain.dir, set('it'));
    expect('subtitles' in await pageData(plain.slug)).toBe(false);
  });
});

describe('pending subtitle commits', { timeout: 60_000 }, () => {
  it('are flushed before the render job reads the sets', async () => {
    const { slug, dir } = await creative({ track: true, locales: { primary: 'it', extra: [] } });
    await writeSubtitleSet(dir, set('it'));
    const log: string[] = [];
    const queue = new JobQueue({ concurrency: 1, lanes: { render: 1 } });
    const normalizer = { prepare: async () => ({ media: { dir: join(env.projectDir(), '.studio', 'cache', 'media'), clips: new Map() }, warnings: [], made: 0, cached: 0, release: () => {} }) } as unknown as MediaNormalizer;
    const engine = { ...env.fake.engine, render: async (o: Parameters<typeof env.fake.engine.render>[0]) => { log.push('render'); return env.fake.engine.render(o); } };
    const ref = { root: env.ws, projectSlug: 'acme', projectDir: env.projectDir(), creativeSlug: slug };
    const svc = new RenderJobService({
      queue, engine, media: NoMediaTools, normalizer, presets: async () => PRESETS as FormatPreset[], broadcast: () => {},
      subtitleCommits: { flush: async (r) => { log.push(`flush ${r?.creativeSlug}`); } },
    });
    const job = await svc.start(ref, 1, ['test-wide']);
    await queue.whenIdle();
    expect(queue.list().find((j) => j.id === job.id)?.error).toBeUndefined();
    expect(log).toEqual([`flush ${slug}`, 'render']);
  });

  it('are not waited for by the render of a composition without the track (review M4)', async () => {
    const { slug } = await creative({ locales: { primary: 'it', extra: [] } });
    const log: string[] = [];
    const queue = new JobQueue({ concurrency: 1, lanes: { render: 1 } });
    const normalizer = { prepare: async () => ({ media: { dir: join(env.projectDir(), '.studio', 'cache', 'media'), clips: new Map() }, warnings: [], made: 0, cached: 0, release: () => {} }) } as unknown as MediaNormalizer;
    const ref = { root: env.ws, projectSlug: 'acme', projectDir: env.projectDir(), creativeSlug: slug };
    const svc = new RenderJobService({
      queue, engine: env.fake.engine, media: NoMediaTools, normalizer, presets: async () => PRESETS as FormatPreset[], broadcast: () => {},
      subtitleCommits: { flush: async () => { log.push('flush'); } },
    });
    const job = await svc.start(ref, 1, ['test-wide']);
    await queue.whenIdle();
    expect(queue.list().find((j) => j.id === job.id)?.state).toBe('succeeded');
    expect(log).toEqual([]);
  });
});
