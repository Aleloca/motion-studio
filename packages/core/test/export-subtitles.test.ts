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
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { writeSubtitleSet } from '../src/subtitles/store.ts';
import { fileURLToPath } from 'node:url';

const set = (lang: 'it' | 'en'): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang, origin: 'speech', transcript: 'whisper-small', detected: lang,
  timing: { version: 1, format: 'instagram-reel-9x16', fingerprint: '0'.repeat(64) },
  cues: [{ id: 'c1', start: 200, end: 1800, text: 'Ciao <a tutti>' }, { id: 'c2', start: 7000, end: 8000, text: 'Oltre la fine' }],
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
    const r = await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio', subtitles: { sets: [set('it')], durationMs: 6000 } });
    const stem = 'lancio-instagram-reel-9x16-v2';
    expect((await readdir(dest)).sort()).toEqual([`${stem}.it.srt`, `${stem}.it.vtt`, `${stem}.mp4`, 'lancio-web-banner-300x250-v2.png']);
    expect(r.files.map((f) => f.to.split('/').pop())).toEqual([`${stem}.mp4`, `${stem}.it.srt`, `${stem}.it.vtt`, 'lancio-web-banner-300x250-v2.png']);
    expect(await readFile(join(dest, `${stem}.it.srt`), 'utf8')).toBe(toSrt(set('it').cues, { durationMs: 6000 }));
    expect(await readFile(join(dest, `${stem}.it.vtt`), 'utf8')).toBe(toVtt(set('it').cues, { durationMs: 6000 }));
  });
  it('never overwrites: a second export names the files after the video copy (-2)', async () => {
    const o = { creativeDir, version, destination: dest, slug: 'lancio', subtitles: { sets: [set('it')], durationMs: 6000 } };
    await exportVersion(o);
    await exportVersion(o);
    expect((await readdir(dest)).filter((f) => f.endsWith('.srt')).sort()).toEqual(['lancio-instagram-reel-9x16-v2-2.it.srt', 'lancio-instagram-reel-9x16-v2.it.srt']);
  });
  it('without subtitles it writes exactly the files it wrote before', async () => {
    await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio' });
    expect((await readdir(dest)).sort()).toEqual(['lancio-instagram-reel-9x16-v2.mp4', 'lancio-web-banner-300x250-v2.png']);
  });
  it('picks export writes them too', async () => {
    const r = await exportPicks({ creativeDir, destination: dest, slug: 'lancio', versions: [version], picks: { 'instagram-reel-9x16': 2 }, subtitles: { sets: [set('en')], durationMs: 6000 } });
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
    const plain = await app.inject({ method: 'POST', url, payload: { destination: join(base, 'plain'), picks: { 'instagram-post-1x1': 1 } } });
    expect((await readdir(join(base, 'plain'))).length).toBe(plain.json().files.length);
  });
});
