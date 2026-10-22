// @vitest-environment node
/**
 * Task 6 of the subtitles plan: the subtitles routes of a creative (overview, start, one set, the .srt/.vtt downloads) and
 * the agent's `start_subtitles` tool. A server on a temp workspace with the controlled runner (no `claude`), the `studio`
 * bridge active (the test calls the bridge routes with a run's token, as the MCP server would), real ffmpeg, no Whisper
 * (none detected) and the transcription set to "ask".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBTITLES_SCHEMA_ID, subtitleSetHash, toSrt, toVtt, type Composition, type CreativeDetail, type JobSummary, type SubtitleSet, type SubtitlesSummary,
} from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
import { Git } from '../src/git.ts';
import { t } from '../src/i18n.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { audioFingerprint, writeSubtitleSet } from '../src/subtitles/store.ts';
import { ControlledRunner, type ControlledRun } from './helpers/controlled-runner.ts';

const P = '/api/projects/acme/creatives';
const brief = { goal: 'Lancio app', message: '', formats: ['youtube-16x9'], durationSec: 6, assets: [], notes: '' };

let base: string;
let app: FastifyInstance;
let runner: ControlledRunner;
let bridge: AgentBridge;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-subtitles-routes-'));
  runner = new ControlledRunner();
  bridge = new AgentBridge();
  bridge.setOrigin('http://127.0.0.1:9');
  const config = new AppConfigStore(join(base, 'config'));
  await config.setTranscription({ method: 'ask' });
  app = await buildServer({
    uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: config, configDir: join(base, 'config'), git: new Git(), runner,
    doctor: async () => [], claudeVersion: async () => '2.1.0', bridge, approvals: new ApprovalBroker({ broadcast: () => {} }),
    mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')], vault: new MemoryVault({}), whisperDetect: async () => [],
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => {
  for (const r of runner.runs) r.end();
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const projectDir = () => join(base, 'ws', 'acme');
const jobs = async () => (await app.inject('/api/jobs')).json() as JobSummary[];
const waitIdle = () => vi.waitFor(async () => expect((await jobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true), { timeout: 20_000, interval: 20 });
const detail = async (slug: string) => (await app.inject(`${P}/${slug}`)).json() as CreativeDetail;
const runOf = async (slug: string, nth = 0): Promise<ControlledRun> => {
  const mine = () => runner.runs.filter((r) => r.req.prompt.includes(`creatives/${slug}/outputs`));
  await vi.waitFor(() => expect(mine().length).toBeGreaterThan(nth), { timeout: 10_000 });
  return mine()[nth]!;
};
const tool = async (run: ControlledRun, name: string, args: Record<string, unknown>): Promise<LightMyRequestResponse> => {
  const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
  const token = (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
  return app.inject({ method: 'POST', url: `/api/bridge/${name}`, headers: { 'x-motion-studio-bridge': token }, payload: args });
};
/** A composition without audio. */
const composition = (w: number, h: number, duration: number): Composition => ({
  $schema: 'motion-studio/composition@1', width: w, height: h, fps: 30, duration, background: '#000000', fonts: [], scenes: [], tracks: [],
} as unknown as Composition);
/** A 6 s video (a still for an image format) for every format the run's prompt asks for. */
const writeCompositions = (run: ControlledRun) => {
  for (const f of parseStudioBlock(run.req.prompt)!.formats) {
    const dir = join(run.req.cwd, f.compositionDir!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition(f.width, f.height, f.kind === 'video' ? 6 : 0)));
  }
};
/** A creative whose first turn saved version 1 (a 6 s video, no audio). */
const made = async (): Promise<string> => {
  const slug = ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, generate: true } })).json() as { slug: string }).slug;
  const run = await runOf(slug);
  writeCompositions(run);
  run.finish({ write: false });
  await waitIdle();
  expect((await detail(slug)).versions.map((v) => v.status)).toEqual(['complete']);
  return slug;
};
const set = (fingerprint: string): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'speech', transcript: 'whisper-small', detected: 'en',
  timing: { version: 1, format: 'youtube-16x9', fingerprint },
  cues: [
    { id: 'c1', start: 200, end: 1800, text: 'Hello <everyone>' },
    { id: 'c2', start: 2000, end: 3500, text: 'Book in three taps', edited: true },
    { id: 'c3', start: 5200, end: 7400, text: 'Past the end' },
    { id: 'c4', start: 6100, end: 6900, text: 'Never shown' },
  ],
});

describe('subtitles routes', () => {
  it('a creative without sets: nothing, no job, nothing asked; the detail has no subtitles', async () => {
    const slug = await made();
    const res = await app.inject(`${P}/${slug}/subtitles`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ sets: [], job: null, pending: null });
    expect((await detail(slug)).subtitles).toBeUndefined();
  });

  it('lists a set with its timing state, gives it whole and downloads it as .srt and .vtt clamped to the video', async () => {
    const slug = await made();
    const creativeDir = join(projectDir(), 'creatives', slug);
    const written = set('0'.repeat(64));
    await writeSubtitleSet(creativeDir, written);

    const overview = (await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] };
    const summary: SubtitlesSummary = {
      lang: 'en', origin: 'speech', cues: 4, edited: 1, hash: subtitleSetHash(written), timing: written.timing, timingChanged: true, staleCues: 0,
    };
    expect(overview.sets).toEqual([summary]);
    expect((await detail(slug)).subtitles).toEqual([summary]);

    // The same fingerprint as the version's main format: the timing still holds.
    const fresh = set(audioFingerprint(composition(1920, 1080, 6)));
    await writeSubtitleSet(creativeDir, fresh);
    expect(((await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] }).sets[0]).toMatchObject({ timingChanged: false, hash: subtitleSetHash(fresh) });

    const one = await app.inject(`${P}/${slug}/subtitles/en`);
    expect(one.json()).toEqual({ set: fresh, hash: subtitleSetHash(fresh) });

    const srt = await app.inject(`${P}/${slug}/subtitles/en/file.srt`);
    expect(srt.statusCode).toBe(200);
    expect(srt.body).toBe(toSrt(fresh.cues, { durationMs: 6000 }));
    expect(srt.body).not.toContain('Never shown');
    expect(srt.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(srt.headers['content-disposition']).toBe(`attachment; filename="${slug}.en.srt"`);
    const vtt = await app.inject(`${P}/${slug}/subtitles/en/file.vtt`);
    expect(vtt.body).toBe(toVtt(fresh.cues, { durationMs: 6000 }));
    expect(vtt.headers['content-type']).toMatch(/^text\/vtt/);
    expect(vtt.headers['content-disposition']).toBe(`attachment; filename="${slug}.en.vtt"`);
  });

  it('a language without a set answers 404, one outside the supported languages 400', async () => {
    const slug = await made();
    for (const url of [`${P}/${slug}/subtitles/fr`, `${P}/${slug}/subtitles/fr/file.srt`, `${P}/${slug}/subtitles/fr/file.vtt`]) {
      expect((await app.inject(url)).statusCode, url).toBe(404);
    }
    for (const url of [`${P}/${slug}/subtitles/xx`, `${P}/${slug}/subtitles/xx/file.srt`, `${P}/${slug}/subtitles/..%2Fcreative/file.vtt`]) {
      expect((await app.inject(url)).statusCode, url).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: { lang: 'xx' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: { mode: 'other' } })).statusCode).toBe(400);
  });

  it('starts a job, refuses a second one while it runs, and shows it in the overview', async () => {
    const slug = await made();
    const first = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: {} });
    expect(first.statusCode, first.body).toBe(200);
    const job = (first.json() as { job: JobSummary }).job;
    expect(job).toMatchObject({ kind: 'subtitles' });
    const second = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: { mode: 'new' } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'subtitles-running' });
    await waitIdle();
    expect((await app.inject(`${P}/${slug}/subtitles`)).json()).toMatchObject({ job: null, pending: null });
  });

  it('a transcription answer or recheck with nothing asking answers 409; a bad answer 400', async () => {
    const slug = await made();
    const choice = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/transcription-choice`, payload: { choice: 'whisper', remember: false } });
    expect(choice.statusCode).toBe(409);
    expect(choice.json()).toMatchObject({ code: 'transcription-not-asked' });
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/transcription-choice`, payload: { choice: 'whisper', remember: false, file: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/transcription-recheck` })).statusCode).toBe(409);
  });

  it('an unknown creative answers 404', async () => {
    expect((await app.inject(`${P}/nope/subtitles`)).statusCode).toBe(404);
  });
});

describe('the start_subtitles tool', () => {
  it('starts the job from a creative turn, once per turn', async () => {
    const slug = await made();
    const sent = await app.inject({ method: 'POST', url: `${P}/${slug}/messages`, payload: { clientId: '00000000-0000-4000-8000-000000000001', text: 'Aggiungi i sottotitoli', mode: 'queued' } });
    expect(sent.statusCode, sent.body).toBe(200);
    const run = await runOf(slug, 1);
    const res = await tool(run, 'start_subtitles', { drawn: false });
    expect(res.statusCode, res.body).toBe(200);
    const { jobId } = res.json() as { started: true; jobId: string };
    expect(res.json()).toEqual({ started: true, jobId });
    expect((await jobs()).find((j) => j.id === jobId)).toMatchObject({ kind: 'subtitles' });
    const again = await tool(run, 'start_subtitles', { drawn: true });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: t().errors.subtitlesOncePerTurn });
    expect((await tool(run, 'start_subtitles', { drawn: 'yes' })).statusCode).toBe(400);
    run.finish({ write: false });
    await waitIdle();
  });

  it('a job of another kind cannot call it', async () => {
    const token = bridge.register({
      jobId: 'brief-1', kind: 'brief', projectSlug: 'acme', projectDir: projectDir(), creativeSlug: null, sandboxed: false, autoApproveAtStart: false,
      emit: () => {}, signal: new AbortController().signal,
    });
    const res = await app.inject({ method: 'POST', url: '/api/bridge/start_subtitles', headers: { 'x-motion-studio-bridge': token }, payload: { drawn: false } });
    expect(res.statusCode).toBe(403);
  });
});
