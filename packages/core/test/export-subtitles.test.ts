// @vitest-environment node
/**
 * Task 7 of the subtitles plan: `.srt`/`.vtt` files in the export. The core writes `<stem>.<lang>.srt|vtt` next to each
 * exported video (never a still); the route refuses a language with no set; an export without the field is as it was.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMATS, EXPORT_NAME_MAX, SUBTITLES_SCHEMA_ID, exportNameCollisions, subtitledStem, toSrt, toVtt, withLocaleSuffix, type FormatPreset, type JobSummary, type ManifestV2, type SubtitleSet, type VersionEntry,
} from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { exportPicks, exportVersion } from '../src/creatives/export.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { writeSubtitleSet } from '../src/subtitles/store.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { execCommand } from '../src/exec.ts';
import { softRemuxArgs } from '../src/render/encode.ts';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, probe } from './helpers/analysis-fixtures.ts';
import { FONT } from './helpers/render-env.ts';
import { H, PRESETS, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const set = (lang: 'it' | 'en'): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang, origin: 'speech', transcript: 'whisper-small', detected: lang,
  timing: { version: 1, format: 'instagram-reel-9x16', fingerprint: '0'.repeat(64) },
  cues: [{ id: 'c1', start: 200, end: 1800, text: 'Ciao <a tutti>' }, { id: 'c2', start: 7000, end: 8000, text: 'Oltre la fine' }],
});
const mkVersion = (n: number, durationSec: number | null): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: 'r', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ format: 'instagram-reel-9x16', file: 'instagram-reel-9x16.mp4', width: 1080, height: 1920, durationSec, verified: true, preview: null }],
});
const version: VersionEntry = {
  n: 2, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: 'r', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [
    { format: 'instagram-reel-9x16', file: 'instagram-reel-9x16.mp4', width: 1080, height: 1920, durationSec: 6, verified: true, preview: null },
    { format: 'web-banner-300x250', file: 'web-banner-300x250.png', width: 300, height: 250, durationSec: null, verified: true, preview: null },
  ],
};

describe('exportVersion with subtitles', () => {
  let base: string, creativeDir: string, dest: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ms-exp-subs-'));
    creativeDir = join(base, 'creative');
    dest = join(base, 'out');
    await mkdir(join(creativeDir, 'outputs', 'v2'), { recursive: true });
    await writeFile(join(creativeDir, 'outputs', 'v2', 'instagram-reel-9x16.mp4'), 'video');
    await writeFile(join(creativeDir, 'outputs', 'v2', 'web-banner-300x250.png'), 'png');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  it('writes <stem>.<lang>.srt and .vtt next to each video, none for a still', async () => {
    const r = await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio', subtitles: { sets: [set('it')] } });
    const stem = 'lancio-instagram-reel-9x16-v2';
    expect((await readdir(dest)).sort()).toEqual([`${stem}.it.srt`, `${stem}.it.vtt`, `${stem}.mp4`, 'lancio-web-banner-300x250-v2.png']);
    expect(r.files.map((f) => f.to.split('/').pop())).toEqual([`${stem}.mp4`, `${stem}.it.srt`, `${stem}.it.vtt`, 'lancio-web-banner-300x250-v2.png']);
    expect(await readFile(join(dest, `${stem}.it.srt`), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 6000 }));
    expect(await readFile(join(dest, `${stem}.it.vtt`), 'utf8')).toBe(toVtt(set('it').cues, { durationMs: 6000 }));
  });
  it('never overwrites: a second export names the files after the video copy (-2)', async () => {
    const o = { creativeDir, version, destination: dest, slug: 'lancio', subtitles: { sets: [set('it')] } };
    await exportVersion(o);
    await exportVersion(o);
    expect((await readdir(dest)).filter((f) => f.endsWith('.srt')).sort()).toEqual(['lancio-instagram-reel-9x16-v2-2.it.srt', 'lancio-instagram-reel-9x16-v2.it.srt']);
  });
  it('without subtitles it writes exactly the files it wrote before', async () => {
    await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio' });
    expect((await readdir(dest)).sort()).toEqual(['lancio-instagram-reel-9x16-v2.mp4', 'lancio-web-banner-300x250-v2.png']);
  });
  it('cuts the cues at the exported video\'s own duration, per version', async () => {
    const short = mkVersion(3, 3), long = mkVersion(4, 9);
    for (const v of [short, long]) { await mkdir(join(creativeDir, 'outputs', `v${v.n}`), { recursive: true }); await writeFile(join(creativeDir, 'outputs', `v${v.n}`, 'instagram-reel-9x16.mp4'), 'video'); }
    await exportVersion({ creativeDir, version: short, destination: dest, slug: 'a', subtitles: { sets: [set('it')], durationMs: 60_000 } });
    await exportVersion({ creativeDir, version: long, destination: dest, slug: 'b', subtitles: { sets: [set('it')], durationMs: 1000 } });
    expect(await readFile(join(dest, 'a-instagram-reel-9x16-v3.it.srt'), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 3000 }));
    expect(await readFile(join(dest, 'b-instagram-reel-9x16-v4.it.srt'), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 9000 }));
    expect(await readFile(join(dest, 'b-instagram-reel-9x16-v4.it.srt'), 'utf8')).toContain('Oltre la fine');
    expect(await readFile(join(dest, 'a-instagram-reel-9x16-v3.it.srt'), 'utf8')).not.toContain('Oltre la fine');
  });
  it('with no recorded duration it uses the fallback, never an unbounded cut', async () => {
    const unknown = mkVersion(5, null);
    await mkdir(join(creativeDir, 'outputs', 'v5'), { recursive: true });
    await writeFile(join(creativeDir, 'outputs', 'v5', 'instagram-reel-9x16.mp4'), 'video');
    await exportVersion({ creativeDir, version: unknown, destination: dest, slug: 'c', subtitles: { sets: [set('it')], durationMs: 2000 } });
    expect(await readFile(join(dest, 'c-instagram-reel-9x16-v5.it.srt'), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 2000 }));
    await exportVersion({ creativeDir, version: unknown, destination: dest, slug: 'd', subtitles: { sets: [set('it')] } });
    expect(await readFile(join(dest, 'd-instagram-reel-9x16-v5.it.srt'), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 8000 }));
  });
  it('picks export writes them too', async () => {
    const r = await exportPicks({ creativeDir, destination: dest, slug: 'lancio', versions: [version], picks: { 'instagram-reel-9x16': 2 }, subtitles: { sets: [set('en')] } });
    expect(r.files.map((f) => f.to.split('/').pop())).toEqual(['lancio-instagram-reel-9x16-v2.mp4', 'lancio-instagram-reel-9x16-v2.en.srt', 'lancio-instagram-reel-9x16-v2.en.vtt']);
  });
});

describe('export route with subtitles', () => {
  const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
  let app: FastifyInstance, base: string, slug: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ms-exp-subs-route-'));
    process.env.FAKE_CLAUDE_SCENARIO = 'render';
    app = await buildServer({ agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [] });
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const brief = { goal: 'Lancio', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' };
    slug = (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief, generate: true } })).json().slug;
    for (let i = 0; i < 750; i++) {
      const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string }>;
      if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  it('refuses a language with no set (400 export-subtitles-missing) before copying anything', async () => {
    await writeSubtitleSet(join(base, 'ws', 'acme', 'creatives', slug), set('it'));
    const dest = join(base, 'out');
    const url = `/api/projects/acme/creatives/${slug}/export`;
    const r = await app.inject({ method: 'POST', url, payload: { destination: dest, picks: { 'instagram-post-1x1': 1 }, subtitles: { files: ['en'] } } });
    expect([r.statusCode, r.json().code]).toEqual([400, 'export-subtitles-missing']);
    await expect(readdir(dest)).rejects.toThrow();
    // A language with a set is accepted (the fake agent's output may be a still: no subtitle files then, the export as it was).
    const ok = await app.inject({ method: 'POST', url, payload: { destination: dest, picks: { 'instagram-post-1x1': 1 }, subtitles: { files: ['it'] } } });
    expect([ok.statusCode, ok.json().code]).toEqual([200, undefined]);
    const store = new CreativeStore(join(base, 'ws', 'acme'));
    const cdir = join(base, 'ws', 'acme', 'creatives', slug);
    for (const [n, sec] of [[7, 3], [8, 9]] as const) {
      await mkdir(join(cdir, 'outputs', `v${n}`), { recursive: true });
      await writeFile(join(cdir, 'outputs', `v${n}`, 'instagram-reel-9x16.mp4'), 'video');
      await store.appendVersion(slug, mkVersion(n, sec));
    }
    const vdest = join(base, 'videos');
    const old = await app.inject({ method: 'POST', url, payload: { destination: vdest, picks: { 'instagram-reel-9x16': 7 }, subtitles: { files: ['it'] } } });
    expect([old.statusCode, old.json().code]).toEqual([200, undefined]);
    const longer = await app.inject({ method: 'POST', url, payload: { destination: vdest, picks: { 'instagram-reel-9x16': 8 }, subtitles: { files: ['it'] } } });
    expect(longer.statusCode).toBe(200);
    expect((await readdir(vdest)).sort()).toEqual(['lancio-instagram-reel-9x16-v7.it.srt', 'lancio-instagram-reel-9x16-v7.it.vtt', 'lancio-instagram-reel-9x16-v7.mp4',
      'lancio-instagram-reel-9x16-v8.it.srt', 'lancio-instagram-reel-9x16-v8.it.vtt', 'lancio-instagram-reel-9x16-v8.mp4']);
    expect(await readFile(join(vdest, 'lancio-instagram-reel-9x16-v7.it.srt'), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 3000 }));
    expect(await readFile(join(vdest, 'lancio-instagram-reel-9x16-v8.it.vtt'), 'utf8')).toBe(toVtt(set('it').cues, { durationMs: 9000 }));
    const plain = await app.inject({ method: 'POST', url, payload: { destination: join(base, 'plain'), picks: { 'instagram-post-1x1': 1 } } });
    expect((await readdir(join(base, 'plain'))).length).toBe(plain.json().files.length);
  });
});

/**
 * Task 21 (spec §6.6, decision 1643, anti-goals 2 and 4): the subtitle choices of an export, with the fake render engine of
 * the instance suites recording each render's options. `drawn`: one video per language, `<stem>-sub-<lang>`; `files` and
 * `soft`: the CLEAN video `<stem>` (never drawn subtitles), the tracks muxed into it, the files next to it.
 */
describe('export subtitle choices (Task 21)', { timeout: 120_000 }, () => {
  const DURATION = 5;
  const STILL: FormatPreset = { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png'] };
  const subtitlesTrack = { id: 'subs', kind: 'subtitles',
    clips: [{ id: 'sub', type: 'subtitles', start: 0, duration: DURATION, props: { fontFamily: 'Mono', fontSize: 20, color: '#ffffff', position: 'bottom', margin: 10, maxWidth: 0.8 } }] };
  const composition = (o: { track?: boolean; still?: boolean }) => ({
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: o.still ? 0 : DURATION, background: '#101010',
    fonts: o.track ? [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }] : [],
    scenes: o.still ? [] : [{ id: 's', start: 0, duration: DURATION }],
    tracks: [
      { id: 't', kind: 'visual', clips: [{ id: 'box', type: 'shape', start: 0, duration: o.still ? 0 : DURATION, props: { x: 10, y: 10, width: 100, height: 50, fill: '#ff0000' } }] },
      ...(o.track ? [subtitlesTrack] : []),
    ],
  });
  const tset = (lang: 'it' | 'en'): SubtitleSet => ({ ...set(lang), timing: { version: 1, format: 'test-wide', fingerprint: 'a'.repeat(64) },
    ...(lang === 'en' ? { origin: 'translation', sourceLang: 'it' } as const : {}) });
  let env: InstanceEnv;
  let mp4: Buffer | null = null;
  beforeAll(async () => {
    if (!hasFfmpeg) return;
    // A real (tiny) MP4 for the version renders whose soft tracks are muxed without a render.
    const d = await mkdtemp(join(tmpdir(), 'ms-exp-subs-mp4-'));
    const r = await execCommand('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(d, 'v.mp4')], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr);
    mp4 = await readFile(join(d, 'v.mp4'));
    await rm(d, { recursive: true, force: true });
  }, 60_000);
  beforeEach(async () => {
    env = await startInstanceEnv('ms-test-export-subs-');
    expect((await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [...PRESETS, STILL] } })).statusCode).toBe(200);
  });
  afterEach(async () => { await env?.close(); });

  /** A v2 version 1: `test-wide` (with or without the subtitles track), its follower `test-wide-b`, and `extra` formats. */
  async function creative(o: { track?: boolean; still?: boolean; render?: boolean }): Promise<{ slug: string; dir: string }> {
    const formats = ['test-wide', 'test-wide-b', ...(o.still ? ['test-still'] : [])];
    const r = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats, durationSec: DURATION, assets: [], notes: '', links: { 'test-wide-b': 'test-wide' }, locales: { primary: 'it', extra: [] } },
    } });
    expect(r.statusCode, r.body).toBe(201);
    const slug = r.json().slug as string;
    const store = env.store();
    const vdir = store.outputsDir(slug, 1);
    const compositions: Array<{ format: string; dir: string; hash: string; followsFormat?: string; problems: string[] }> = [];
    for (const [f, c] of [['test-wide', composition({ track: o.track })], ...(o.still ? [['test-still', composition({ still: true })] as const] : [])] as const) {
      const cdir = join(vdir, 'compositions', f);
      await mkdir(join(cdir, 'assets'), { recursive: true });
      if (f === 'test-wide') await copyFile(FONT, join(cdir, 'assets', 'Mono.woff2'));
      await writeFile(join(cdir, 'composition.json'), JSON.stringify(c));
      compositions.push({ format: f, dir: `compositions/${f}`, hash: (await readCompositionFolder(cdir)).hash, problems: [] });
    }
    compositions.push({ format: 'test-wide-b', dir: 'compositions/test-wide', hash: compositions[0]!.hash, followsFormat: 'test-wide', problems: [] });
    await writeFile(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
    await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: null, compositions });
    const dir = store.dir(slug);
    await writeSubtitleSet(dir, tset('it'));
    await writeSubtitleSet(dir, tset('en'));
    // The version render (draws `it`, the brief's primary, when the composition has the track).
    if (o.render !== false) await env.render(slug, 1);
    return { slug, dir };
  }
  const exportOf = (slug: string, payload: object) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H,
    payload: { destination: join(env.base, 'out'), picks: { 'test-wide': 1 }, ...payload } });
  const outFiles = async () => (await readdir(join(env.base, 'out'))).sort();
  const exportJobs = async () => ((await env.app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).filter((j) => j.key.startsWith('render-export:'));
  const STEM = 'launch-test-wide-v1';

  it('drawn: one export render per language with that set drawn, named <stem>-sub-<lang>, the version render untouched', async () => {
    const { slug } = await creative({ track: true });
    expect(env.fake.renders.at(-1)!.subtitles?.lang).toBe('it');
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { subtitles: { drawn: ['en'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before + 1);
    const call = env.fake.renders.at(-1)!;
    expect(call.subtitles?.lang).toBe('en');
    expect(call.composition.tracks.some((t) => t.kind === 'subtitles')).toBe(true);
    expect('softSubtitles' in call).toBe(false);
    expect(await outFiles()).toEqual([`${STEM}-sub-en.mp4`]);
    const jobs = await exportJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.label).toMatch(/(subtitles|sottotitoli) en\)$/);
  });

  it('drawn in the language the version render already draws reuses it (no render)', async () => {
    const { slug, dir } = await creative({ track: true });
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { subtitles: { drawn: ['it'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before);
    expect(await outFiles()).toEqual([`${STEM}-sub-it.mp4`]);
    expect(await readFile(join(env.base, 'out', `${STEM}-sub-it.mp4`), 'utf8')).toBe(await readFile(join(dir, 'outputs', 'v1', 'test-wide.mp4'), 'utf8'));
  });

  it('files and soft on a composition with the track: one clean export render (stripped, soft tracks), files next to it, never drawn (anti-goal 2)', async () => {
    const { slug } = await creative({ track: true });
    const before = env.fake.renders.length;
    const seen: string[] = [];
    env.fake.after = async (o) => { for (const s of o.softSubtitles ?? []) seen.push(await readFile(s.srt, 'utf8')); };
    const r = await exportOf(slug, { subtitles: { files: ['it'], soft: ['it', 'en'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before + 1);
    const call = env.fake.renders.at(-1)!;
    expect('subtitles' in call).toBe(false);
    expect(call.composition.tracks.some((t) => t.kind === 'subtitles')).toBe(false);
    expect(call.softSubtitles?.map((s) => s.lang)).toEqual(['it', 'en']);
    for (const s of call.softSubtitles!) expect(s.srt.startsWith(dirname(call.out))).toBe(true);
    expect(seen).toEqual([toSrt(tset('it').cues, { durationMs: DURATION * 1000 }), toSrt(tset('en').cues, { durationMs: DURATION * 1000 })]);
    expect(await outFiles()).toEqual([`${STEM}.it.srt`, `${STEM}.it.vtt`, `${STEM}.mp4`]);
    expect((await exportJobs())[0]!.label).toMatch(/(without subtitles|senza sottotitoli)\)$/);
  });

  it.skipIf(!hasFfmpeg)('files and soft on a composition without the track: no render job, the tracks muxed into a copy of the version file', async () => {
    env.fake.content = (o) => (o.format.id === 'test-wide' ? mp4 : null);
    const { slug, dir } = await creative({});
    const before = env.fake.renders.length;
    const versionBytes = await readFile(join(dir, 'outputs', 'v1', 'test-wide.mp4'));
    const r = await exportOf(slug, { subtitles: { files: ['it'], soft: ['it', 'en'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before);
    expect(await exportJobs()).toHaveLength(0);
    expect(await outFiles()).toEqual([`${STEM}.it.srt`, `${STEM}.it.vtt`, `${STEM}.mp4`]);
    const streams = (await probe(join(env.base, 'out', `${STEM}.mp4`))).streams;
    expect(streams.filter((s) => s.codec_type === 'subtitle').map((s) => [s.codec_name, (s.tags as Record<string, string>).language])).toEqual([['mov_text', 'ita'], ['mov_text', 'eng']]);
    expect(streams.filter((s) => s.codec_type === 'video')).toHaveLength(1);
    expect(streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
    // The version's own file is never changed.
    expect((await readFile(join(dir, 'outputs', 'v1', 'test-wide.mp4'))).equals(versionBytes)).toBe(true);
  });

  it('files only on a composition without the track: the version file as it is, the files next to it', async () => {
    const { slug, dir } = await creative({});
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { subtitles: { files: ['en'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before);
    expect(await outFiles()).toEqual([`${STEM}.en.srt`, `${STEM}.en.vtt`, `${STEM}.mp4`]);
    expect(await readFile(join(env.base, 'out', `${STEM}.mp4`), 'utf8')).toBe(await readFile(join(dir, 'outputs', 'v1', 'test-wide.mp4'), 'utf8'));
  });

  it('stills are skipped with a note (the still itself is exported as it is)', async () => {
    const { slug } = await creative({ track: true, still: true });
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { picks: { 'test-still': 1 }, subtitles: { drawn: ['en'], files: ['it'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before);
    expect(await outFiles()).toEqual(['launch-test-still-v1.png']);
    expect(r.json().skipped).toEqual([expect.stringMatching(/Still/)]);
  });

  it('the creative\'s format summaries say which ★ compositions draw the subtitles (final review I2)', async () => {
    const formats = async (slug: string) => Object.fromEntries(((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json().formats as Array<{ id: string; subtitlesTrack?: boolean }>)
      .map((f) => [f.id, f.subtitlesTrack]));
    const withTrack = await creative({ track: true, still: true, render: false });
    expect(await formats(withTrack.slug)).toEqual({ 'test-wide': true, 'test-wide-b': true, 'test-still': false });
    const without = await creative({ render: false });
    expect(await formats(without.slug)).toEqual({ 'test-wide': false, 'test-wide-b': false });
  });

  it('soft tracks asked of an App Store preview: rendered with its store audio, the tracks left out with a note (final review M4)', async () => {
    const preview = DEFAULT_FORMATS.find((p) => p.id === 'appstore-preview')!;
    expect((await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [...PRESETS, STILL, preview] } })).statusCode).toBe(200);
    const r0 = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats: ['appstore-preview'], durationSec: DURATION, assets: [], notes: '', locales: { primary: 'it', extra: [] } },
    } });
    expect(r0.statusCode, r0.body).toBe(201);
    const slug = r0.json().slug as string;
    const store = env.store();
    const cdir = join(store.outputsDir(slug, 1), 'compositions', 'appstore-preview');
    await mkdir(join(cdir, 'assets'), { recursive: true });
    await copyFile(FONT, join(cdir, 'assets', 'Mono.woff2'));
    await writeFile(join(cdir, 'composition.json'), JSON.stringify({ ...composition({ track: true }), width: preview.width, height: preview.height }));
    const compositions = [{ format: 'appstore-preview', dir: 'compositions/appstore-preview', hash: (await readCompositionFolder(cdir)).hash, problems: [] }];
    await writeFile(join(store.outputsDir(slug, 1), 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
    await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: null, compositions });
    await writeSubtitleSet(store.dir(slug), tset('it'));
    const r = await exportOf(slug, { picks: { 'appstore-preview': 1 }, subtitles: { files: ['it'], soft: ['it'] } });
    expect(r.statusCode, r.body).toBe(200);
    const call = env.fake.renders.at(-1)!;
    expect(call).toMatchObject({ storeAudio: true, fps: 30 });
    expect(r.json().skipped).toEqual([expect.stringMatching(/App Preview.*(App Store)/)]);
    expect(await outFiles()).toEqual(['launch-appstore-preview-v1.it.srt', 'launch-appstore-preview-v1.it.vtt', 'launch-appstore-preview-v1.mp4']);
  });

  it('a follower reuses its primary\'s subtitled file, renamed', async () => {
    const { slug } = await creative({ track: true });
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { follow: ['test-wide-b'], subtitles: { drawn: ['en'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before + 1);
    expect(await outFiles()).toEqual(['launch-test-wide-b-v1-sub-en.mp4', `${STEM}-sub-en.mp4`]);
    const a = await readFile(join(env.base, 'out', `${STEM}-sub-en.mp4`), 'utf8');
    expect(await readFile(join(env.base, 'out', 'launch-test-wide-b-v1-sub-en.mp4'), 'utf8')).toBe(a);
  });

  it('drawn, files and soft together: the drawn video and the clean one, the files with the clean one', async () => {
    const { slug } = await creative({ track: true });
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { subtitles: { drawn: ['en'], files: ['it'], soft: ['en'] } });
    expect(r.statusCode, r.body).toBe(200);
    const calls = env.fake.renders.slice(before);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.subtitles?.lang ?? null).sort()).toEqual(['en', null]);
    const clean = calls.find((c) => !c.subtitles)!;
    expect(clean.softSubtitles?.map((s) => s.lang)).toEqual(['en']);
    expect(clean.composition.tracks.some((t) => t.kind === 'subtitles')).toBe(false);
    expect(calls.find((c) => c.subtitles)!.softSubtitles).toBeUndefined();
    expect(await outFiles()).toEqual([`${STEM}-sub-en.mp4`, `${STEM}.it.srt`, `${STEM}.it.vtt`, `${STEM}.mp4`]);
  });

  it('refuses a drawn or soft language without a set (400 export-subtitles-missing), nothing rendered', async () => {
    const { slug } = await creative({ track: true });
    const before = env.fake.renders.length;
    for (const subtitles of [{ drawn: ['fr'] }, { soft: ['fr'] }]) {
      const r = await exportOf(slug, { subtitles });
      expect([r.statusCode, r.json().code]).toEqual([400, 'export-subtitles-missing']);
    }
    expect(env.fake.renders.length).toBe(before);
  });

  it('without subtitles the export runs as before: no render, no job, the version file (anti-goal 4)', async () => {
    const { slug, dir } = await creative({ track: true });
    const before = env.fake.renders.length;
    const r = await exportOf(slug, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.length).toBe(before);
    expect(await exportJobs()).toHaveLength(0);
    expect(await outFiles()).toEqual([`${STEM}.mp4`]);
    expect(await readFile(join(env.base, 'out', `${STEM}.mp4`), 'utf8')).toBe(await readFile(join(dir, 'outputs', 'v1', 'test-wide.mp4'), 'utf8'));
  });

  // Review round 1.
  it('a ★ without a current render is not rendered for the version first when the export renders it all (one render)', async () => {
    const { slug } = await creative({ track: true, render: false });
    const r = await exportOf(slug, { subtitles: { files: ['it'], soft: ['it'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders).toHaveLength(1);
    expect(env.fake.renders[0]!.composition.tracks.some((t) => t.kind === 'subtitles')).toBe(false);
    expect(await outFiles()).toEqual([`${STEM}.it.srt`, `${STEM}.it.vtt`, `${STEM}.mp4`]);
    // Cut at the rendered video's own duration.
    expect(await readFile(join(env.base, 'out', `${STEM}.it.srt`), 'utf8')).toBe(toSrt(tset('it').cues, { durationMs: DURATION * 1000 }));
  });

  it('the soft tracks and the side files come from the same read of the sets (a set changed during the export is not mixed in)', async () => {
    const { slug, dir } = await creative({ track: true, render: false });
    let open!: () => void;
    env.fake.gate = new Promise<void>((res) => { open = res; });
    const seen: string[] = [];
    env.fake.after = async (o) => { for (const x of o.softSubtitles ?? []) seen.push(await readFile(x.srt, 'utf8')); };
    // `drawn: ['it']` (the version render's language) makes the version render first: the set changes while it runs.
    const pending = exportOf(slug, { subtitles: { drawn: ['it'], files: ['en'], soft: ['en'] } });
    for (let i = 0; i < 500 && env.fake.renders.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    expect(env.fake.renders).toHaveLength(1);
    await writeSubtitleSet(dir, { ...tset('en'), cues: [{ id: 'c1', start: 0, end: 900, text: 'Changed' }] });
    env.fake.gate = null;
    open();
    const r = await pending;
    expect(r.statusCode, r.body).toBe(200);
    const old = toSrt(tset('en').cues, { durationMs: DURATION * 1000 });
    expect(seen).toEqual([old]);
    expect(await readFile(join(env.base, 'out', `${STEM}.en.srt`), 'utf8')).toBe(old);
  });

  it('409 export-subtitles-nothing when only drawn languages are asked of videos without the track', async () => {
    const { slug } = await creative({});
    const r = await exportOf(slug, { subtitles: { drawn: ['en'] } });
    expect([r.statusCode, r.json().code]).toEqual([409, 'export-subtitles-nothing']);
    await expect(readdir(join(env.base, 'out'))).rejects.toThrow();
  });

  it('the older version payload refuses drawn and soft subtitles (400), takes the files', async () => {
    const { slug } = await creative({ track: true });
    const url = `/api/projects/acme/creatives/${slug}/export`;
    for (const subtitles of [{ drawn: ['en'] }, { soft: ['en'] }]) {
      const r = await env.app.inject({ method: 'POST', url, headers: H, payload: { destination: join(env.base, 'out'), version: 1, subtitles } });
      expect([r.statusCode, r.json().code]).toEqual([400, 'export-invalid-picks']);
    }
    const ok = await env.app.inject({ method: 'POST', url, headers: H, payload: { destination: join(env.base, 'out'), version: 1, subtitles: { files: ['en'] } } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a failed subtitle render refuses the export and leaves no temp folder', async () => {
    const { slug } = await creative({ track: true });
    const outs: string[] = [];
    env.fake.after = (o) => { outs.push(o.out); throw new Error('boom'); };
    const r = await exportOf(slug, { subtitles: { soft: ['it', 'en'] } });
    expect([r.statusCode, r.json().code]).toEqual([409, 'export-render-failed']);
    expect(outs).toHaveLength(1);
    const temp = dirname(dirname(dirname(outs[0]!)));
    expect(basename(temp)).toMatch(/^ms-render-export-/);
    expect(existsSync(temp)).toBe(false);
  });
});


/**
 * Task 27 (spec §6.6, U8): multi-language subtitle exports. `drawn` takes video/subtitle-language pairs (a bare tag is the
 * original video); a localized video is rendered for the export from its localized composition with the chosen set; files and
 * soft tracks go with every exported video language's clean video; a set timed on a localized voice pairs only with that video.
 */
describe('multi-language subtitle exports (Task 27)', { timeout: 120_000 }, () => {
  const DURATION = 5;
  const subtitlesTrack = { id: 'subs', kind: 'subtitles',
    clips: [{ id: 'sub', type: 'subtitles', start: 0, duration: DURATION, props: { fontFamily: 'Mono', fontSize: 20, color: '#ffffff', position: 'bottom', margin: 10, maxWidth: 0.8 } }] };
  const composition = {
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: DURATION, background: '#101010',
    fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }], scenes: [{ id: 's', start: 0, duration: DURATION }],
    tracks: [
      { id: 't', kind: 'visual', clips: [{ id: 'title', type: 'text', start: 0, duration: DURATION, props: { text: 'Ciao', x: 10, y: 10, width: 200, height: 50, fontFamily: 'Mono', fontSize: 20, color: '#ffffff' } }] },
      subtitlesTrack,
    ],
  };
  const lset = (lang: 'it' | 'en' | 'de', voiced = false): SubtitleSet => ({
    $schema: SUBTITLES_SCHEMA_ID, lang, origin: lang === 'it' || voiced ? 'speech' : 'translation', transcript: 'whisper-small', detected: lang === 'it' || voiced ? lang : null,
    ...(lang !== 'it' && !voiced ? { sourceLang: 'it' } : {}),
    timing: { version: 1, format: 'test-wide', fingerprint: 'a'.repeat(64), ...(voiced ? { locale: lang } : {}) },
    cues: [{ id: 'c1', start: 200, end: 1800, text: `Riga ${lang}` }],
  });
  let env: InstanceEnv;
  beforeEach(async () => { env = await startInstanceEnv('ms-test-export-langs-'); });
  afterEach(async () => { await env?.close(); });

  /** Version 1 of `test-wide` (with the subtitles track), primary `it`, translated into `de`; sets it, en and de. */
  async function creative(o: { voicedDe?: boolean } = {}): Promise<{ slug: string; dir: string }> {
    const r = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats: ['test-wide'], durationSec: DURATION, assets: [], notes: '', locales: { primary: 'it', extra: ['de'] } },
    } });
    expect(r.statusCode, r.body).toBe(201);
    const slug = r.json().slug as string;
    const store = env.store();
    const vdir = store.outputsDir(slug, 1);
    const cdir = join(vdir, 'compositions', 'test-wide');
    await mkdir(join(cdir, 'assets'), { recursive: true });
    await copyFile(FONT, join(cdir, 'assets', 'Mono.woff2'));
    await writeFile(join(cdir, 'composition.json'), JSON.stringify(composition));
    const compositions = [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(cdir)).hash, problems: [] }];
    await writeFile(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
    await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: null, compositions });
    const put = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/test-wide`, headers: H, payload: { texts: { title: 'Hallo' } } });
    expect(put.statusCode, put.body).toBe(200);
    const dir = store.dir(slug);
    await writeSubtitleSet(dir, lset('it'));
    await writeSubtitleSet(dir, lset('en'));
    await writeSubtitleSet(dir, lset('de', o.voicedDe === true));
    await env.render(slug, 1);
    return { slug, dir };
  }
  const exportOf = (slug: string, payload: object) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H,
    payload: { destination: join(env.base, 'out'), picks: { 'test-wide': 1 }, ...payload } });
  const outFiles = async () => (await readdir(join(env.base, 'out'))).sort();
  const STEM = 'launch-test-wide-v1';
  const LOCALE_RENDER = () => join(env.projectDir(), '.studio', 'cache', 'locale-render');
  const titleOf = (c: { tracks: Array<{ clips: Array<{ id: string; props: { text?: string } }> }> }) => c.tracks.flatMap((t) => t.clips).find((x) => x.id === 'title')?.props.text;
  const deRow = async (slug: string) => (await env.versionOf(slug, 1))!.localizations!.find((x) => x.locale === 'de')!;

  it('drawn pairs: the Italian video with English, the German video with German: one export render each, named -sub-en and -de-sub-de', async () => {
    const { slug } = await creative();
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { subtitles: { drawn: [{ video: 'it', lang: 'en' }, { video: 'de', lang: 'de' }] } });
    expect(r.statusCode, r.body).toBe(200);
    const calls = env.fake.renders.slice(before);
    expect(calls).toHaveLength(2);
    const it = calls.find((c) => c.subtitles?.lang === 'en')!;
    const de = calls.find((c) => c.subtitles?.lang === 'de')!;
    expect(titleOf(it.composition as never)).toBe('Ciao');
    expect(it.dir.startsWith(LOCALE_RENDER())).toBe(false);
    // The German video is the localized composition, from a private copy removed afterwards, with the German set drawn.
    expect(titleOf(de.composition as never)).toBe('Hallo');
    expect(de.dir.startsWith(LOCALE_RENDER())).toBe(true);
    expect(existsSync(de.dir)).toBe(false);
    expect(de.composition.tracks.some((t) => t.kind === 'subtitles')).toBe(true);
    expect(await outFiles()).toEqual([`${STEM}-de-sub-de.mp4`, `${STEM}-sub-en.mp4`]);
    // Nothing is recorded: the German row has no render of its own.
    expect((await deRow(slug)).render).toBeUndefined();
  });

  it('soft [it, en, de] and files [en] with locales [it, de]: each clean video gets three tracks and the files, never drawn', async () => {
    const { slug } = await creative();
    const before = env.fake.renders.length;
    const r = await exportOf(slug, { locales: ['it', 'de'], subtitles: { soft: ['it', 'en', 'de'], files: ['en'] } });
    expect(r.statusCode, r.body).toBe(200);
    const calls = env.fake.renders.slice(before);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect('subtitles' in c).toBe(false);
      expect(c.composition.tracks.some((t) => t.kind === 'subtitles')).toBe(false);
      expect(c.softSubtitles?.map((s) => s.lang)).toEqual(['it', 'en', 'de']);
    }
    expect(calls.map((c) => titleOf(c.composition as never)).sort()).toEqual(['Ciao', 'Hallo']);
    expect(await outFiles()).toEqual([`${STEM}-de.en.srt`, `${STEM}-de.en.vtt`, `${STEM}-de.mp4`, `${STEM}.en.srt`, `${STEM}.en.vtt`, `${STEM}.mp4`]);
    // The German video was rendered for the export only (no row render first).
    expect((await deRow(slug)).render).toBeUndefined();
  });

  it('a bare drawn tag is the original video (Phase 3 clients); a ticked language without subtitles is exported as today', async () => {
    const { slug } = await creative();
    const r = await exportOf(slug, { locales: ['it', 'de'], subtitles: { drawn: ['en'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await outFiles()).toEqual([`${STEM}-de.mp4`, `${STEM}-sub-en.mp4`]);
    // The German file is its row render (rendered first, as an export of the language without subtitles).
    const row = await deRow(slug);
    expect(row.render?.file).toBe('test-wide.de.mp4');
    expect(await readFile(join(env.base, 'out', `${STEM}-de.mp4`), 'utf8')).toBe(await readFile(join(env.store().outputsDir(slug, 1), 'test-wide.de.mp4'), 'utf8'));
  });

  it('a set timed on the German voice goes only on the German video: refused elsewhere (400 export-subtitles-pair), soft only on that video', async () => {
    const { slug } = await creative({ voicedDe: true });
    const before = env.fake.renders.length;
    for (const subtitles of [{ drawn: [{ video: 'it', lang: 'de' }] }, { drawn: ['de'] }, { soft: ['de'] }, { files: ['de'] }]) {
      const r = await exportOf(slug, { subtitles });
      expect([r.statusCode, r.json().code], JSON.stringify(subtitles)).toEqual([400, 'export-subtitles-pair']);
    }
    expect(env.fake.renders.length).toBe(before);
    const r = await exportOf(slug, { locales: ['it', 'de'], subtitles: { soft: ['it', 'de'] } });
    expect(r.statusCode, r.body).toBe(200);
    const calls = env.fake.renders.slice(before);
    expect(calls.map((c) => [titleOf(c.composition as never), c.softSubtitles?.map((s) => s.lang)]).sort()).toEqual([['Ciao', ['it']], ['Hallo', ['it', 'de']]]);
  });

  it('a pair names a video language of the brief (400 locale-not-in-brief otherwise)', async () => {
    const { slug } = await creative();
    const r = await exportOf(slug, { subtitles: { drawn: [{ video: 'fr', lang: 'en' }] } });
    expect([r.statusCode, r.json().code]).toEqual([400, 'locale-not-in-brief']);
  });
});

describe('softRemuxArgs', () => {
  it('copies the video and any audio, maps each SRT as mov_text with its ISO 639-2 tag', () => {
    const own = (p: string, f: string) => ['-protocol_whitelist', 'file', '-format_whitelist', f, '-i', p];
    expect(softRemuxArgs({ input: '/w/in.mp4', soft: [{ lang: 'it', srt: '/w/it.srt' }, { lang: 'en', srt: '/w/en.srt' }], format: 'mp4', out: '/w/out.mp4' })).toEqual([
      ...own('/w/in.mp4', 'mov,mp4'), ...own('/w/it.srt', 'srt'), ...own('/w/en.srt', 'srt'),
      '-map', '0:v:0', '-map', '0:a?', '-map', '1:s:0', '-map', '2:s:0', '-c', 'copy', '-c:s', 'mov_text',
      '-metadata:s:s:0', 'language=ita', '-metadata:s:s:1', 'language=eng', '-movflags', '+faststart', '-f', 'mp4', '/w/out.mp4']);
  });
});

describe('subtitledStem (decision 1643)', () => {
  it('names a drawn video <stem>-sub-<lang>, never like a localized one', () => {
    expect(subtitledStem('launch-reel-v1', 'pt-BR')).toBe('launch-reel-v1-sub-pt-br');
    const names = [subtitledStem('a', 'en'), withLocaleSuffix('a', 'en'), 'a', subtitledStem('a', 'it'), withLocaleSuffix('a', 'it')].map((s) => `${s}.mp4`);
    expect(exportNameCollisions(names)).toEqual([]);
    expect(subtitledStem('x'.repeat(200), 'en').length).toBeLessThanOrEqual(EXPORT_NAME_MAX);
  });
});
