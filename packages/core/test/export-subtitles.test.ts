// @vitest-environment node
/**
 * Task 7 of the subtitles plan: `.srt`/`.vtt` files in the export. The core writes `<stem>.<lang>.srt|vtt` next to each
 * exported video (never a still); the route refuses a language with no set; an export without the field is as it was.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUBTITLES_SCHEMA_ID, toSrt, toVtt, type SubtitleSet, type VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { exportPicks, exportVersion } from '../src/creatives/export.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { writeSubtitleSet } from '../src/subtitles/store.ts';
import { fileURLToPath } from 'node:url';

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
